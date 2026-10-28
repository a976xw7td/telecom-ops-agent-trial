/* 引擎核心 v1.0.0 — 检索 + 指标 + 检查 + 归因 + What-if（纯函数，无随机、无网络） */
(function (g) {
  var isNode = typeof module === "object" && module.exports;
  var D = isNode ? require("./data.js") : g.JDData;
  var KB = isNode ? require("./kb.js") : g.JDKB;
  var SK = isNode ? require("./skill.js") : g.JDSkill;

  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
  function round(v, d) { var p = Math.pow(10, d); return Math.round(v * p) / p; }
  function last(a) { return a[a.length - 1]; }
  function avg(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function hash(str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return ("0000000" + h.toString(16)).slice(-8); }
  function getRegion(id) { for (var i = 0; i < D.REPORT.regions.length; i++) if (D.REPORT.regions[i].id === id || D.REPORT.regions[i].name === id) return D.REPORT.regions[i]; return null; }

  /* ---------- 检索层：BM25 over 文档分块 ---------- */
  var CHUNKS = [], INDEX = null;
  (function build() {
    KB.docs.forEach(function (doc) {
      doc.text.split("\n\n").forEach(function (t, i) {
        CHUNKS.push({ docId: doc.id, title: doc.title, version: doc.version, owner: doc.owner, chunk: i + 1, text: t.trim() });
      });
    });
  })();
  function tokenize(s) {
    s = String(s || "").toLowerCase(); var out = [];
    (s.match(/[a-z0-9\.%]+/g) || []).forEach(function (t) { out.push(t); });
    (s.match(/[\u4e00-\u9fa5]+/g) || []).forEach(function (seg) {
      for (var i = 0; i < seg.length; i++) { out.push(seg[i]); if (i < seg.length - 1) out.push(seg.substr(i, 2)); }
    });
    return out;
  }
  function ensureIndex() {
    if (INDEX) return INDEX;
    var df = {}, tfs = [];
    CHUNKS.forEach(function (c) {
      var toks = tokenize(c.title + " " + c.text), tf = {};
      toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      tfs.push({ tf: tf, len: toks.length });
    });
    INDEX = { df: df, tfs: tfs, avgLen: tfs.reduce(function (a, b) { return a + b.len; }, 0) / tfs.length };
    return INDEX;
  }
  function retrieve(query, k) {
    var idx = ensureIndex(), q = tokenize(query), N = CHUNKS.length, k1 = 1.5, b = 0.75, scored = [];
    var qs = {}; q.forEach(function (t) { qs[t] = 1; });
    CHUNKS.forEach(function (c, i) {
      var s = 0, tf = idx.tfs[i].tf, len = idx.tfs[i].len;
      Object.keys(qs).forEach(function (t) {
        if (!tf[t]) return;
        var idf = Math.log(1 + (N - (idx.df[t] || 0) + 0.5) / ((idx.df[t] || 0) + 0.5));
        s += idf * (tf[t] * (k1 + 1)) / (tf[t] + k1 * (1 - b + b * len / idx.avgLen));
      });
      if (s > 0) scored.push({ docId: c.docId, title: c.title, version: c.version, owner: c.owner, chunk: c.chunk, text: c.text, score: round(s, 3), ref: c.docId + "#" + c.chunk, loc: c.docId + " §" + c.chunk });
    });
    scored.sort(function (x, y) { return y.score - x.score || (x.docId + x.chunk).localeCompare(y.docId + y.chunk); });
    return scored.slice(0, num(k, 4));
  }

  /* ---------- 指标层 ---------- */
  function metricStatus(key, cur) {
    var m = D.METRICS[key];
    if (!m || m.target === undefined) return "na";
    if (m.dir === "down") return cur > m.target ? "bad" : "ok";
    return cur < m.target ? "bad" : "ok";
  }
  function metricsTable(region) {
    return Object.keys(D.METRICS).map(function (key) {
      var m = D.METRICS[key], s = region.series[key], cur = last(s), prev = s[s.length - 2], first = s[0];
      return {
        key: key, name: m.name, unit: m.unit, target: m.target, dir: m.dir,
        cur: round(cur, m.decimals), prev: round(prev, m.decimals),
        wow: round(cur - prev, m.decimals), spanChange: round(cur - first, m.decimals),
        spark: s.map(function (v) { return round(v, m.decimals); }),
        status: metricStatus(key, cur)
      };
    });
  }

  /* ---------- 检查层：规则来自 Skill.checks，口径来自 RAG ---------- */
  function checkRegion(region) {
    var out = [], S = region.series, sev = { high: 3, medium: 2, low: 1 };
    SK.checks.forEach(function (c) {
      var s = S[c.metric]; if (!s) return;
      var cur = last(s), fired = false, detail = "", value = null;
      if (c.rule === "cross_check") {
        var rows = [];
        if (!S.installArrive || !S.installStaff) {
          out.push({ id: c.id, metric: c.metric, label: c.label, severity: c.severity, fired: false, ref: c.ref, value: null, detail: "缺少装机到达/在岗人手序列，口径交叉核验跳过（不计入风险分）", rule: c.rule, skipped: true });
          return;
        }
        for (var i = 1; i < s.length; i++) {
          var observed = s[i] - s[i - 1];
          var theo = (S.installArrive[i] - S.installStaff[i] * 6) * D.REPORT.meta.workdays;
          var dev = theo === 0 ? (observed === 0 ? 0 : 1) : (observed - theo) / Math.abs(theo);
          rows.push({ week: D.REPORT.weeks[i], observed: round(observed, 0), theoretical: round(theo, 0), deviation: round(dev * 100, 1) });
        }
        var bad = rows.filter(function (r) { return Math.abs(r.deviation) > 15; });
        fired = bad.length > 0;
        function sg(x) { return (x >= 0 ? "+" : "") + x; }
        detail = rows.map(function (r) { return r.week + "：实际 " + sg(r.observed) + " / 理论 " + sg(r.theoretical) + "，偏差 " + r.deviation + "%"; }).join("；");
        value = rows;
      } else if (c.rule === "trend_down") {
        fired = last(s) < s[s.length - 2] && s[s.length - 2] < s[s.length - 3];
        value = round(cur, 0); detail = "近 3 周净增：" + s.slice(-3).join(" → ");
      } else {
        var m = /^(>=|>|<=|<)\s*([\d.]+)$/.exec(c.rule);
        if (!m) return;
        var th = parseFloat(m[2]), op = m[1];
        fired = op === ">=" ? cur >= th : op === ">" ? cur > th : op === "<=" ? cur <= th : cur < th;
        value = round(cur, D.METRICS[c.metric] ? D.METRICS[c.metric].decimals : 2);
        detail = "当前 " + value + (D.METRICS[c.metric] ? D.METRICS[c.metric].unit : "") + "，阈值 " + op + " " + th;
      }
      out.push({ id: c.id, metric: c.metric, label: c.label, severity: c.severity, fired: fired, ref: c.ref, value: value, detail: detail, rule: c.rule });
    });
    var score = out.filter(function (x) { return x.fired; }).reduce(function (a, x) { return a + sev[x.severity]; }, 0);
    return { checks: out, score: score, fired: out.filter(function (x) { return x.fired; }) };
  }

  /* ---------- 归因层 ---------- */
  function conditions(region) {
    var S = region.series, f = {}, ch = checkRegion(region).fired.map(function (x) { return x.id; });
    /* 字段缺失时该条件判定为“未知/false”，不猜测、不报错 */
    var fus = S.fusionPen || [], chn = S.channelOrders || [], stf = S.installStaff || [], arr = S.installArrive || [];
    f.backlog_high = ch.indexOf("C2") >= 0;
    f.complaints_high = ch.indexOf("C3") >= 0;
    f.churn_high = ch.indexOf("C1") >= 0;
    f.fusion_down = ch.indexOf("C4") >= 0 && fus.length > 0 && last(fus) < fus[0];
    /* 未达标但趋势在改善：属观察项，不进入归因，也不触发干预动作 */
    f.fusion_below_target_improving = ch.indexOf("C4") >= 0 && fus.length > 0 && last(fus) >= fus[0];
    f.channel_down = chn.length > 0 && last(chn) < chn[0];
    f.staff_shortage = stf.length > 0 && arr.length > 0 && last(stf) * 6 < last(arr);
    return f;
  }
  function diagnose(region) {
    var c = conditions(region);
    var list = SK.playbook.map(function (p) {
      var keys = p.trigger.split("&&").map(function (s) { return s.trim(); });
      var hit = keys.filter(function (k) { return !!c[k]; });
      if (hit.length !== keys.length) return null;
      return { id: p.id, hypothesis: p.hypothesis, refs: p.refs, conditions: keys, weight: p.weight, confidence: p.weight };
    }).filter(Boolean);
    /* 证据质量折扣：存在口径核验偏差时下调置信度 */
    var q = checkRegion(region).checks.filter(function (x) { return x.id === "C7" && x.fired; }).length > 0;
    list.forEach(function (h) { h.confidence = round(h.weight * (q ? 0.9 : 1), 2); h.evidenceQuality = q ? "存在口径偏差，置信度已折扣 10%" : "口径一致"; });
    list.sort(function (a, b) { return b.confidence - a.confidence || a.id.localeCompare(b.id); });
    /* 三态输出：有假设 / 有异常但未匹配既有假设（降级并给补证清单）/ 无异常 */
    var fired = checkRegion(region).fired.filter(function (x) { return x.id !== "C7"; });
    var state = list.length ? "attributed" : (fired.length ? "unattributed" : "no_anomaly");
    var gap = state === "unattributed" ? {
      note: "已命中异常（" + fired.map(function (x) { return x.label; }).join("、") + "），但未匹配既有假设；不做猜测性归因。",
      need: fired.map(function (x) {
        return { signal: x.label, missing: "该指标的分渠道/分网格明细与同期工单明细", use: "判断是集中在单点还是全面性恶化" };
      }),
      action: "先按观察项监控 1 周并补明细数据，再重新归因；期间只做低风险纠偏"
    } : null;
    return { conditions: c, hypotheses: list, state: state, evidenceGap: gap, counterEvidence: counterEvidence(region) };
  }
  function counterEvidence(region) {
    var S = region.series, out = [], bb = S.bbNetAdd || [], chn = S.channelOrders || [];
    if (bb.length > 1 && last(bb) > bb[0]) out.push({ text: "宽带净增由 " + bb[0] + " 升至 " + last(bb) + "（+" + (last(bb) - bb[0]) + " 户），需求侧未恶化，不能归因为'市场变差'", refs: ["D4", "D1"] });
    if (chn.length > 1 && last(chn) > chn[0]) out.push({ text: "渠道订单在上升，排除渠道产能问题", refs: ["D4"] });
    return out;
  }

  /* ---------- What-if 与人员约束 ---------- */
  function whatIf(regionId, opts) {
    opts = opts || {};
    var region = getRegion(regionId); if (!region) return null;
    var add = num(opts.addStaff, 0), weeks = Math.max(1, num(opts.weeks, 4)), ppp = num(opts.perPerson, 6), wd = num(opts.workdays, D.REPORT.meta.workdays);
    var S = region.series, miss = [];
    if (!S.installStaff) miss.push("在岗人手");
    if (!S.installArrive) miss.push("装机到达量");
    if (!S.installBacklog) miss.push("装机积压量");
    if (miss.length) {
      /* 缺关键序列时不做模拟，明确返回缺口，不给编造的数字 */
      return {
        region: region.id, regionName: region.name, degraded: true, missing: miss,
        base: { staff: null, arrive: null, backlog: null, threshold: D.METRICS.installBacklog.target, capacity: null, net: null },
        assumption: { perPerson: ppp, workdays: wd, rampWeek1: 0.5, arriveIsAverage: true },
        addStaff: add, weeks: weeks, rows: [], reachedThresholdWeek: null,
        minAddToStopGrowth: null, addToReachThresholdInWeeks: null, clearingDays: null,
        note: "缺少" + miss.join("、") + "序列，无法做增员模拟；补数据后再模拟，本次不给结论。",
        caseCheck: null
      };
    }
    var staff = last(S.installStaff), arrive = avg(S.installArrive), backlog = last(S.installBacklog), threshold = D.METRICS.installBacklog.target;
    var rows = [], cur = backlog, reached = null;
    for (var w = 1; w <= weeks; w++) {
      var ramp = w === 1 ? 0.5 : 1, head = staff + add * ramp, cap = head * ppp, net = cap - arrive;
      /* net = 产能 - 到达：net>0 产能富余，积压按 -net*工作日 递减；net<0 产能不足，积压递增 */
      var next = Math.max(0, cur - net * wd);
      rows.push({ label: "W+" + w, headcount: round(head, 1), capacity: round(cap, 1), net: round(net, 1), backlog: round(next, 0), trend: net > 0 ? "下降" : "仍上升" });
      if (reached === null && next <= threshold) reached = w;
      cur = next;
    }
    var minAdd = Math.max(0, Math.ceil(arrive / ppp - staff));
    var needAdd = Math.max(0, Math.ceil(arrive / ppp + (backlog - threshold) / (weeks * wd * ppp) - staff));
    return {
      region: region.id, regionName: region.name, base: { staff: staff, arrive: round(arrive, 1), backlog: backlog, threshold: threshold, capacity: round(staff * ppp, 1), net: round(staff * ppp - arrive, 1) },
      assumption: { perPerson: ppp, workdays: wd, rampWeek1: 0.5, arriveIsAverage: true },
      addStaff: add, weeks: weeks, rows: rows,
      reachedThresholdWeek: reached,
      minAddToStopGrowth: minAdd,
      addToReachThresholdInWeeks: needAdd,
      clearingDays: (staff + add) * ppp - arrive > 0 ? round(backlog / ((staff + add) * ppp - arrive), 1) : null,
      note: (staff * ppp - arrive) <= 0 && add === 0 ? "当前产能低于日均到达，积压不会自行下降" : "",
      caseCheck: caseReconciliation(region, backlog, threshold)
    };
  }
  function caseReconciliation(region, backlog, threshold) {
    if (region.id !== "XG") return null;
    var need = (backlog - threshold) / (3 * D.REPORT.meta.workdays);
    return {
      ref: "D6 案例 C-2025-08",
      text: "案例称增配 4 人后 3 周内积压由 600 降至 260 单（周降约 113 单）。按本模型 6 单/人日 与到达 129 单/日，4 人（含首周 50% 爬坡）3 周仅能降约 63 单。",
      impliedDailyNet: round(need, 1),
      conclusion: "案例隐含额外投入（加班/更多外协）或到达口径更低，本样本无法复现该效果，引用案例效果前需核对投入口径。"
    };
  }

  /* ---------- 行动方案 ---------- */
  function actions(region) {
    var dg = diagnose(region), wi = whatIf(region.id, { addStaff: 0, weeks: 4 }), out = [], seen = {};
    dg.hypotheses.forEach(function (h) {
      var p = SK.playbook.filter(function (x) { return x.id === h.id; })[0];
      p.actions.forEach(function (a) {
        if (seen[a.id]) return; seen[a.id] = 1;
        var extra = null;
        if (a.id === "A7" && wi.minAddToStopGrowth !== null && wi.minAddToStopGrowth !== undefined) { var w4 = whatIf(region.id, { addStaff: wi.minAddToStopGrowth, weeks: 4 }); extra = { minAdd: wi.minAddToStopGrowth, needsAdd: w4.addToReachThresholdInWeeks }; }
        out.push({ id: a.id, action: a.action, owner: a.owner, horizon: a.horizon, verify: a.verify, risk: a.risk, from: h.id, confidence: h.confidence, extra: extra });
      });
    });
    return out;
  }

  var API = { version: "1.0.0", retrieve: retrieve, metricsTable: metricsTable, checkRegion: checkRegion, conditions: conditions, diagnose: diagnose, whatIf: whatIf, actions: actions, getRegion: getRegion, round: round, avg: avg, hash: hash, report: D.REPORT, metrics: D.METRICS, dict: D.DATA_DICT, kb: KB, skill: SK };
  if (isNode) module.exports = API; else g.JDEngine = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
