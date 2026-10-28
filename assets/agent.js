/* Agent 层 v1.0.0 — 路由 + 九步工作流留痕 + 证据闸门 + 运行记录导出（确定性） */
(function (g) {
  var isNode = typeof module === "object" && module.exports;
  var E = isNode ? require("./engine.js") : g.JDEngine;
  var SK = E.skill, R = E.report;

  var INTENTS = [
    { id: "whatif", kw: ["如果", "假如", "what-if", "whatif", "增员", "加到", "多少人", "再加", "模拟"] },
    { id: "cause", kw: ["为什么", "原因", "归因", "怎么回事", "谁导致"] },
    { id: "action", kw: ["怎么办", "建议", "措施", "行动", "怎么改", "下一步"] },
    { id: "compare", kw: ["对比", "比较", "哪个区", "差异", "排序"] },
    { id: "metric", kw: ["多少", "趋势", "环比", "变化", "怎么样"] }
  ];

  function matchRegions(q) {
    var hit = [];
    R.regions.forEach(function (r) { if (q.indexOf(r.name) >= 0 || q.indexOf(r.id) >= 0) hit.push(r.id); });
    return hit;
  }
  /* 提到了区县但不在样本内 → 必须明确拒绝，绝不静默替换成别的区县 */
  function unknownRegion(q) {
    var known = R.regions.map(function (r) { return r.name; });
    var m = q.match(/[\u4e00-\u9fa5]{2,4}区/g) || [];
    for (var i = 0; i < m.length; i++) {
      var cand = m[i], ok = false;
      known.forEach(function (k) { if (k.indexOf(cand) >= 0 || cand.indexOf(k) >= 0) ok = true; });
      if (!ok) return cand;
    }
    return null;
  }
  /* 领域相关性词表：来自可用字段、指标名、区县与经营常用词 */
  var DOMAIN_TERMS = (function () {
    var t = ["经营", "周报", "指标", "风险", "口径", "阈值", "数据", "样本", "增员", "人", "周", "区", "工单", "装机", "渠道", "离网", "积压", "投诉", "融合", "渗透", "宽带", "拆机", "订单", "调度", "工单", "对比", "异常", "趋势", "复盘"];
    Object.keys(E.metrics).forEach(function (k) { var m = E.metrics[k]; if (m && m.name) t.push(m.name); if (m && m.field) t.push(m.field); });
    (E.dict.available || []).forEach(function (a) { if (a.field) t.push(a.field); });
    E.report.regions.forEach(function (r) { t.push(r.name); t.push(r.id); });
    return t;
  })();
  function offDomain(q) {
    for (var i = 0; i < DOMAIN_TERMS.length; i++) if (q.indexOf(DOMAIN_TERMS[i]) >= 0) return false;
    return true;
  }
  function detectIntent(q) {
    for (var i = 0; i < INTENTS.length; i++) {
      for (var j = 0; j < INTENTS[i].kw.length; j++) if (q.toLowerCase().indexOf(INTENTS[i].kw[j]) >= 0) return INTENTS[i].id;
    }
    return "judgment";
  }
  function scopeCheck(q) {
    var blocked = [];
    E.dict.unsupported.forEach(function (u) { if (new RegExp(u.regex, "i").test(q)) blocked.push(u); });
    return blocked;
  }
  function requiredData(u) {
    return {
      topic: u.topic,
      need: [
        { field: u.topic + " 相关明细指标", source: "对应业务系统（本样本未接入）", caliber: "需先登记口径手册", period: "近 8 周（与周报对齐）" }
      ],
      reason: u.reason,
      rule: "按 D7 证据不足规则：不以经验值替代数据，不做相邻指标推断"
    };
  }

  /* 九步工作流：每步都留痕，应用与测试共用 */
  function run(question, opts) {
    opts = opts || {};
    var trace = [], t0 = Date.now();
    function step(id, name, status, detail, payload) {
      trace.push({ step: id, name: name, status: status, detail: detail, payload: payload === undefined ? null : payload });
    }
    var q = String(question || "").trim();
    step("intake", "输入校验", q ? "ok" : "fail", q ? "问题长度 " + q.length + " 字；数据 " + R.meta.reportId + "（" + R.weeks.length + " 周）" : "未提供问题");

    var regions = matchRegions(q);
    var intent = detectIntent(q);
    var unknown = unknownRegion(q);
    step("route", "意图路由", unknown ? "blocked" : "ok", unknown ? "提及区县「" + unknown + "」不在样本范围（样本：" + R.regions.map(function (r) { return r.name; }).join("、") + "）" : "意图=" + intent + "；目标区县=" + (regions.length ? regions.join(",") : "未指定，取风险最高区县"), { intent: intent, regions: regions, unknown: unknown });

    /* 范围外区县：明确拒绝，不静默替换为其他区县 */
    if (unknown) {
      step("scope_check", "证据边界检查", "blocked", "区县不在样本范围");
      step("retrieve", "RAG 检索", "skipped", "范围外，不检索");
      step("compute", "指标计算", "skipped", "无该区县数据");
      step("diagnose", "原因假设排序", "skipped", "无该区县数据");
      step("gate", "证据闸门", "blocked", "范围外拦截：" + unknown);
      step("plan", "行动方案", "skipped", "无数据不输出方案");
      step("report", "结构化输出", "ok", "返回不支持范围说明");
      return finish({ status: "out_of_scope", question: q, intent: intent, unknownRegion: unknown, availableRegions: R.regions.map(function (r) { return r.name; }), trace: trace, t0: t0 });
    }

    /* 流程外问题：不含任何本样本主题词 → 明确拒答，不套用默认区县硬答 */
    if (offDomain(q)) {
      step("scope_check", "证据边界检查", "blocked", "问题与本样本经营主题无关");
      step("retrieve", "RAG 检索", "skipped", "无关问题，不检索");
      step("compute", "指标计算", "skipped", "无关问题");
      step("diagnose", "原因假设排序", "skipped", "无关问题");
      step("gate", "证据闸门", "blocked", "流程外问题拦截");
      step("plan", "行动方案", "skipped", "无关问题不输出方案");
      step("report", "结构化输出", "ok", "返回可答范围说明");
      return finish({
        status: "off_topic", question: q, intent: intent,
        availableRegions: E.report.regions.map(function (r) { return r.name; }),
        scope: "仅回答示例市三区县周报的经营指标（收入、离网、积压、投诉、融合渗透、渠道订单）及其归因、行动与增员模拟",
        trace: trace, t0: t0
      });
    }
    var blockedTopics = scopeCheck(q);
    step("scope_check", "证据边界检查", blockedTopics.length ? "blocked" : "ok",
      blockedTopics.length ? "命中不可用问题域：" + blockedTopics.map(function (b) { return b.topic; }).join("、") : "问题落在可用字段范围内");

    /* 证据不足：直接闸门拦截，不进入计算与归因 */
    if (blockedTopics.length) {
      var u = blockedTopics[0];
      step("retrieve", "RAG 检索", "ok", "检索口径与数据边界规则", E.retrieve("数据可用性 证据不足 规则 " + u.topic, 2).map(function (c) { return c.ref; }));
      step("compute", "指标计算", "skipped", "证据不足，未进入计算");
      step("diagnose", "原因假设排序", "skipped", "证据不足，不做归因");
      step("gate", "证据闸门", "blocked", "证据不足拦截：" + u.topic);
      step("plan", "行动方案", "skipped", "缺少数据，不输出行动结论");
      step("report", "结构化输出", "ok", "返回证据不足说明 + 所需数据清单");
      return finish({ status: "insufficient_evidence", question: q, intent: intent, topic: u.topic, requiredData: requiredData(u), citations: E.retrieve("数据可用性 证据不足 规则", 2), trace: trace, t0: t0 });
    }

    var targetId = regions[0] || rank()[0].region;
    var region = E.getRegion(targetId);
    if (!region) {
      step("gate", "证据闸门", "blocked", "区县不在样本范围");
      return finish({ status: "out_of_scope", question: q, intent: intent, trace: trace, t0: t0 });
    }

    var hits = E.retrieve(q + " 口径 阈值 规则", 4);
    step("retrieve", "RAG 检索", hits.length ? "ok" : "degraded", hits.map(function (c) { return c.ref + "(score " + c.score + ")"; }).join("；") || "无命中", hits);
    var mt = E.metricsTable(region), ck = E.checkRegion(region);
    step("compute", "指标计算", "ok", region.name + " 命中异常 " + ck.fired.length + " 项，风险分 " + ck.score, { metrics: mt, checks: ck.checks });
    var dg = E.diagnose(region);
    step("diagnose", "原因假设排序", dg.hypotheses.length ? "ok" : "degraded", dg.hypotheses.map(function (h) { return h.id + "(" + h.confidence + ")"; }).join("；") || "无假设成立", dg);

    var degraded = !region.series.installStaff || !region.series.installArrive;
    step("gate", "证据闸门", "pass", "边界内、可归因" + (degraded ? "（部分字段缺失，结论降级）" : ""));

    var acts = E.actions(region);
    step("plan", "行动方案", acts.length ? "ok" : "degraded", acts.length + " 条动作，均带责任方/验证指标/复核时点", acts);

    var out = { status: "ok", question: q, intent: intent, region: region.id, regionName: region.name, degraded: degraded, metrics: mt, checks: ck.checks, riskScore: ck.score, conditions: dg.conditions, diagnosisState: dg.state, evidenceGap: dg.evidenceGap, hypotheses: dg.hypotheses, counterEvidence: dg.counterEvidence, actions: acts, citations: hits, trace: trace, t0: t0 };
    if (opts.addStaff !== undefined || intent === "whatif") out.whatIf = E.whatIf(region.id, { addStaff: opts.addStaff === undefined ? 4 : opts.addStaff, weeks: opts.weeks === undefined ? 4 : opts.weeks });
    step("report", "结构化输出", "ok", "结论 + 证据 + 动作 + 运行记录");
    return finish(out);
  }

  function finish(o) {
    var t0 = o.t0; delete o.t0;
    o.version = versionId();
    o.elapsedMs = Date.now() - t0;
    o.generatedAt = new Date().toISOString();
    o.versions = { skill: SK.version, engine: E.version, kb: E.kb.version, data: "1.0.0", report: R.meta.reportId };
    return o;
  }
  function versionId() {
    var s = JSON.stringify(R) + "|" + SK.version + "|" + E.kb.version + "|" + E.version;
    return "jd-" + E.hash(s);
  }
  function rank() {
    return R.regions.map(function (r) { var c = E.checkRegion(r); return { region: r.id, name: r.name, score: c.score, fired: c.fired.length }; })
      .sort(function (a, b) { return b.score - a.score || a.region.localeCompare(b.region); });
  }

  /* 自然语言答案（模板化，不含自由发挥；每句可追到数据或文档） */
  function answer(question, opts) {
    var r = run(question, opts);
    if (r.status === "insufficient_evidence") {
      return { ...r, text: "**证据不足，无法作答。**\n\n问题涉及「" + r.topic + "」，本样本未提供该数据：" + r.requiredData.reason + "。\n\n需要补充：" + r.requiredData.need.map(function (n) { return n.field + "（来源：" + n.source + "，口径：" + n.caliber + "，周期：" + n.period + "）"; }).join("；") + "。\n\n依据：" + r.requiredData.rule + "（" + r.citations.map(function (c) { return c.ref; }).join("、") + "）" };
    }
    if (r.status === "off_topic") return { ...r, text: "**这个问题超出本应用可答范围，不作答。**\n\n问题「" + r.question + "」与本样本的经营主题无关。可答范围：" + r.scope + "（区县：" + r.availableRegions.join("、") + "）。\n\n请改问指标、原因、对策或增员模拟，例如「新港区为什么离网率上升，我该怎么办？」。" };
    if (r.status === "out_of_scope") return { ...r, text: "该区县不在样本范围（样本仅含 " + R.regions.map(function (x) { return x.name; }).join("、") + "），无法作答。" };
    var L = [];
    var bad = r.checks.filter(function (c) { return c.fired; });
    function fmt(b) {
      var v = b.value;
      if (Array.isArray(v)) return b.label + "：" + (b.detail || "见检查明细");
      return b.label + "：" + v;
    }
    L.push("**" + r.regionName + "结论**：风险分 " + r.riskScore + "，命中 " + bad.length + " 项异常" + (bad.length ? "（" + bad.map(fmt).join("；") + "）" : "") + "。");
    if (r.diagnosisState === "no_anomaly") L.push("\n**归因**：未命中干预阈值，属正常波动区间，无假设成立。建议只维持观察，不做干预。");
    if (r.diagnosisState === "unattributed" && r.evidenceGap) {
      L.push("\n**归因（降级）**：" + r.evidenceGap.note + "\n补证清单：" + r.evidenceGap.need.map(function (n) { return n.signal + " → 需补" + n.missing + "（用于" + n.use + "）"; }).join("；") + "\n处置：" + r.evidenceGap.action + "。");
    }
    if (r.hypotheses.length) L.push("\n**原因假设（按置信度）**：\n" + r.hypotheses.map(function (h) { return "- " + h.id + " 置信度 " + h.confidence + "：" + h.hypothesis + "（依据 " + h.refs.join("/") + "）"; }).join("\n"));
    if (r.counterEvidence.length) L.push("\n**反证与排除**：\n" + r.counterEvidence.map(function (c) { return "- " + c.text; }).join("\n"));
    if (r.actions.length) L.push("\n**行动方案**：\n" + r.actions.map(function (a) { return "- [" + a.id + "] " + a.action + "｜责任：" + a.owner + "｜周期：" + a.horizon + "｜验证：" + a.verify; }).join("\n"));
    if (r.whatIf) { var w = r.whatIf; L.push("\n**What-if（增员 " + w.addStaff + " 人，权重按首周 50% 爬坡）**：当前 " + w.base.staff + " 人 × 6 单/人日 = " + w.base.capacity + " 单/日，日均到达 " + w.base.arrive + " 单，净 " + w.base.net + " 单/日" + (w.note ? "（" + w.note + "）" : "") + "。" + (w.rows.length ? w.rows.map(function (x) { return x.label + " 收口积压 " + x.backlog + " 单（" + x.trend + "）"; }).join("；") + "。" : "") + " 止涨最少需增 " + w.minAddToStopGrowth + " 人；" + w.weeks + " 周内回到阈值需增 " + w.addToReachThresholdInWeeks + " 人。"); if (w.caseCheck) L.push("\n**与历史案例的一致性核验**：" + w.caseCheck.text + " → " + w.caseCheck.conclusion); }
    L.push("\n**出处**：" + r.citations.map(function (c) { return c.title + " v" + c.version + " " + c.ref; }).join("、"));
    return { ...r, text: L.join("\n") };
  }

  var API = { version: "1.0.0", run: run, answer: answer, rank: rank, versionId: versionId, detectIntent: detectIntent };
  if (isNode) module.exports = API; else g.JDAgent = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
