/* UI 层 v1.0.0 — 只做渲染与交互；所有数字来自 data/kb/skill/engine/agent，
   页面无网络请求、无随机数、无当前时间参与计算，相同输入必然得到相同画面与相同导出文件 */
(function () {
  var E = JDEngine, A = JDAgent, R = E.report;
  var state = { region: R.regions[0].id, add: 4, weeks: 4, last: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function sx(v) { return (v >= 0 ? "+" : "") + v; }

  /* ---------- 通用迷你折线（单序列 + 目标线，独立刻度，不共轴） ---------- */
  function spark(values, opt) {
    opt = opt || {};
    var W = opt.w || 300, H = opt.h || 74, pad = 6;
    var target = opt.target;
    var pool = values.slice();
    if (typeof target === "number") pool.push(target);
    var mn = Math.min.apply(null, pool), mx = Math.max.apply(null, pool);
    if (mn === mx) { mn -= 1; mx += 1; }
    var span = mx - mn, mg = span * 0.18; mn -= mg; mx += mg;
    var n = values.length;
    var x = function (i) { return pad + (W - pad * 2) * (n === 1 ? 0.5 : i / (n - 1)); };
    var y = function (v) { return H - pad - (H - pad * 2) * (v - mn) / (mx - mn); };
    var pts = values.map(function (v, i) { return x(i) + "," + y(v); }).join(" ");
    var area = x(0) + "," + (H - pad) + " " + pts + " " + x(n - 1) + "," + (H - pad);
    var g = ['<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opt.alt || "趋势") + '">'];
    g.push('<polygon points="' + area + '" fill="' + (opt.color || "#38bdf8") + '" opacity="0.10"/>');
    if (typeof target === "number") {
      g.push('<line x1="' + pad + '" y1="' + y(target) + '" x2="' + (W - pad) + '" y2="' + y(target) + '" stroke="#f87171" stroke-width="1" stroke-dasharray="4 3" opacity="0.75"/>');
      g.push('<text x="' + (W - pad - 2) + '" y="' + (y(target) - 3) + '" fill="#f87171" font-size="9" text-anchor="end">阈值 ' + target + '</text>');
    }
    g.push('<polyline points="' + pts + '" fill="none" stroke="' + (opt.color || "#38bdf8") + '" stroke-width="1.8" stroke-linejoin="round"/>');
    values.forEach(function (v, i) { g.push('<circle cx="' + x(i) + '" cy="' + y(v) + '" r="2.2" fill="' + (opt.color || "#38bdf8") + '"/>'); });
    g.push("</svg>");
    return g.join("");
  }

  /* 单卡片：标题 + 当前值 + 周环比 + 迷你线 */
  function metricCard(title, values, opt) {
    opt = opt || {};
    var cur = values[values.length - 1], prev = values[values.length - 2];
    var d = +(cur - prev).toFixed(opt.decimals == null ? 1 : opt.decimals);
    var tol = opt.tolerance == null ? 0 : opt.tolerance;
    var tone = opt.dir === "down" ? (d > tol ? "bad" : d < -tol ? "ok" : "") : (d < -tol ? "bad" : d > tol ? "ok" : "");
    var arrow = d > 0 ? "▲" : d < 0 ? "▼" : "＝";
    return '<div class="card mini"><div class="sub">' + esc(title) + "</div>" +
      '<div class="kpi" style="font-size:18px">' + cur + '<small>' + esc(opt.unit || "") + "</small></div>" +
      '<div class="sub ' + (tone === "bad" ? "txt-bad" : tone === "ok" ? "txt-ok" : "") + '">周环比 ' + arrow + " " + Math.abs(d) + (opt.unit || "") +
      (typeof opt.target === "number" ? "｜目标 " + (opt.dir === "down" ? "≤" : "≥") + opt.target : "") + "</div>" +
      spark(values, opt) + "</div>";
  }

  /* ---------- 顶部 KPI ---------- */
  function renderMeta() {
    $("ver").textContent = "v" + E.version + " · " + A.versionId().slice(0, 8);
    $("metaline").textContent = R.meta.tenant + "｜" + R.meta.reportId + "｜" + R.meta.weekLabel + "｜" + R.meta.period + "｜口径：" + R.meta.unit;
    $("fperiod").textContent = R.meta.period + "（" + R.meta.workdays + " 天/周，来源：" + R.meta.source + "）";
  }

  function renderKpis() {
    var region = E.getRegion(state.region), c = E.checkRegion(region), dg = E.diagnose(region);
    var S = region.series;
    var stateTxt = dg.state === "attributed" ? "已归因" : dg.state === "unattributed" ? "异常未归因（已降级）" : "无异常";
    var stateTone = dg.state === "attributed" ? "warn" : dg.state === "unattributed" ? "bad" : "ok";
    var box = $("kpis"); box.innerHTML = "";
    box.appendChild(el("div", "card",
      '<div class="sub">' + esc(region.name) + " 风险分</div>" +
      '<div class="kpi">' + c.score + '<small>/ 满分 ' + E.skill.checks.reduce(function (a, x) { return a + ({ high: 3, medium: 2, low: 1 }[x.severity] || 0); }, 0) + "</small></div>" +
      '<div class="sub">命中 <b>' + c.fired.length + "</b> / " + c.checks.length + ' 条检查规则；归因状态 <span class="pill ' + stateTone + '">' + stateTxt + '</span></div>'));
    box.appendChild(el("div", "card",
      '<div class="sub">装维积压（周末时点）</div>' +
      '<div class="kpi">' + S.installBacklog[S.installBacklog.length - 1] + '<small>单</small></div>' +
      '<div class="sub">阈值 ≤ ' + E.metrics.installBacklog.target + " 单｜周变化 " + sx(S.installBacklog[3] - S.installBacklog[2]) + "</div>" +
      spark(S.installBacklog, { target: E.metrics.installBacklog.target, color: "#f87171", alt: "装维积压趋势" })));
    box.appendChild(el("div", "card",
      '<div class="sub">日均产能 vs 日均到达</div>' +
      '<div class="kpi">' + (S.installStaff[3] * 6) + '<small>单/日</small></div>' +
      '<div class="sub">到达 ' + S.installArrive[3] + " 单/日｜净 " + sx(S.installStaff[3] * 6 - S.installArrive[3]) + " 单/日（" + S.installStaff[3] + " 人 × 6 单/人日）</div>" +
      spark(S.installArrive, { color: "#fbbf24", alt: "日均到达趋势" })));
  }

  /* ---------- 区县切换 ---------- */
  function renderTabs() {
    var box = $("tabs"); box.innerHTML = "";
    R.regions.forEach(function (r) {
      var c = E.checkRegion(r), dg = E.diagnose(r);
      var tone = dg.state === "attributed" ? "w" : dg.state === "unattributed" ? "b" : "";
      var b = el("button", "tab" + (r.id === state.region ? " on" : ""),
        '<span class="dot ' + tone + '"></span>' + esc(r.name) + ' <span class="sub">风险 ' + c.score + "</span>");
      b.onclick = function () { state.region = r.id; renderAll(); };
      box.appendChild(b);
    });
  }

  /* ---------- 图表：全部独立刻度，不共轴，避免视觉放大 ---------- */
  function renderCharts() {
    var r = E.getRegion(state.region), S = r.series, M = E.metrics;
    $("chart1").innerHTML =
      '<div class="sub" style="margin-bottom:2px">安装积压（单，周末时点）</div>' +
      spark(S.installBacklog, { target: M.installBacklog.target, color: "#f87171", w: 520, h: 92, alt: "安装积压" }) +
      '<div class="sub" style="margin:8px 0 2px">日产能（在岗×6）与日均到达（单/日）</div>' +
      spark(S.installStaff.map(function (v) { return v * 6; }), { color: "#38bdf8", w: 520, h: 64, alt: "日产能" }) +
      spark(S.installArrive, { color: "#fbbf24", w: 520, h: 64, alt: "日均到达" }) +
      '<div class="sub" style="margin-top:4px">周序列：' + R.weeks.join(" → ") + "</div>";
    $("chart2").innerHTML =
      metricCard("宽带月离网率", S.churnRate, { unit: "%", dir: "down", target: M.churnRate.target, decimals: 2, color: "#f87171", alt: "离网率" }) +
      metricCard("融合渗透率", S.fusionPen, { unit: "%", dir: "up", target: M.fusionPen.target, decimals: 1, color: "#34d399", alt: "融合渗透率" }) +
      metricCard("投诉工单", S.complaints, { unit: " 件/周", dir: "down", target: M.complaints.target, decimals: 0, color: "#fbbf24", alt: "投诉工单" });
  }

  /* ---------- 规则检查 ---------- */
  function renderChecks() {
    var r = E.getRegion(state.region), c = E.checkRegion(r), ul = $("checks");
    $("riskline").textContent = "· 命中 " + c.fired.length + " 条，风险分 " + c.score;
    ul.innerHTML = "";
    c.checks.forEach(function (x) {
      var tone = x.fired ? "bad" : "ok";
      var text = x.fired ? x.detail : "未触发（" + x.rule + "）：" + x.detail;
      var li = el("li", "", '<span class="tag ' + tone + '">' + (x.fired ? "命中" : "正常") + "</span>" +
        '<span><b>' + esc(x.label) + "</b> " + esc(text) + ' <span class="sub mono">' + esc(x.ref) + "</span></span>");
      ul.appendChild(li);
    });
    var c7 = c.checks.filter(function (x) { return x.id === "C7"; })[0];
    if (c7) {
      ul.appendChild(el("li", "", '<span class="tag ' + (c7.fired ? "w" : "ok") + '">口径</span><span><b>产能-积压交叉核验</b> ' +
        esc(c7.fired ? "实际积压变化与理论产能不一致，已按 10% 折扣下调归因置信度" : "实际积压变化与理论产能一致，归因不打折") + "</span>"));
    }
  }

  /* ---------- What-if ---------- */
  function renderWhatIf() {
    var w = E.whatIf(state.region, { addStaff: state.add, weeks: state.weeks });
    $("addv").textContent = state.add;
    var html = '<div class="sub">当前 ' + w.base.staff + " 人 × " + w.assumption.perPerson + " 单/人日 × " + w.assumption.workdays +
      " 天 = " + w.base.capacity + " 单/日；日均到达 " + w.base.arrive + " 单，当前净 " + sx(w.base.net) + " 单/日" +
      (w.note ? "（" + esc(w.note) + "）" : "") + "。</div>";
    html += '<table class="tbl" style="margin-top:8px"><tr><th>周</th><th>在岗（人）</th><th>产能（单/日）</th><th>净（单/日）</th><th>周末积压（单）</th><th>趋势</th></tr>';
    w.rows.forEach(function (x) {
      var bad = x.trend !== "下降";
      html += "<tr><td>" + x.label + "</td><td>" + x.headcount + "</td><td>" + x.capacity + '</td><td class="' + (x.net >= 0 ? "txt-ok" : "txt-bad") + '">' +
        sx(x.net) + '</td><td class="' + (x.backlog > w.base.threshold ? "txt-bad" : "txt-ok") + '">' + x.backlog + "</td><td>" + x.trend + "</td></tr>";
    });
    html += "</table>";
    html += '<div class="alert ' + (w.reachedThresholdWeek ? "ok" : "warn") + '" style="margin-top:8px">' +
      "止涨最少需增 <b>" + w.minAddToStopGrowth + "</b> 人；" + w.weeks + " 周内回到阈值（≤" + w.base.threshold + " 单）需增 <b>" +
      w.addToReachThresholdInWeeks + "</b> 人" +
      (w.reachedThresholdWeek ? "；当前参数下第 " + w.reachedThresholdWeek + " 周达标" : "；当前参数下 " + w.weeks + " 周内未达标") +
      (w.clearingDays != null ? "；按现净额清空积压约 " + w.clearingDays + " 个工作日" : "") + "。</div>";
    if (w.caseCheck) {
      html += '<div class="alert warn" style="margin-top:8px"><b>历史案例一致性核验（' + esc(w.caseCheck.ref) + "）</b><br>" + esc(w.caseCheck.text) +
        "<br><b>结论：</b>" + esc(w.caseCheck.conclusion) + "</div>";
    }
    html += '<div class="sub" style="margin-top:6px">假设：每增 1 人 +' + w.assumption.perPerson + " 单/日；新进人员首周按 50% 产能爬坡；到达量取 " +
      R.weeks.length + " 周均值（" + w.base.arrive + " 单/日）。计算为确定性复算，非估算。</div>";
    $("whatif").innerHTML = html;
  }

  /* ---------- 极简 Markdown → HTML（只支持 **粗体** / - 列表 / 空行分段） ---------- */
  function md(t) {
    var lines = String(t).split("\n"), out = [], buf = [];
    function flush() { if (buf.length) { out.push("<ul>" + buf.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul>"); buf = []; } }
    lines.forEach(function (ln) {
      var b = ln.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      if (/^\s*-\s+/.test(ln)) { buf.push(b.replace(/^\s*-\s+/, "")); return; }
      flush();
      if (ln.trim() === "") { out.push(""); return; }
      out.push("<p>" + b + "</p>");
    });
    flush();
    return out.join("");
  }

  function renderTrace(r, question) {
    var hits = E.retrieve(question, 4);
    var steps = [];
    steps.push({ t: "输入解析：意图 " + r.intent + "｜区县 " + (r.regionName || "—"), c: r.status === "ok" ? "ok" : "blocked" });
    steps.push({ t: "数据取数：" + (r.status === "out_of_scope" ? "越界，未取数" : "命中样本 " + R.weeks.length + " 周"), c: r.status === "out_of_scope" ? "blocked" : "ok" });
    steps.push({ t: "RAG 检索：返回 " + hits.length + " 个片段（" + hits.map(function (h) { return h.docId; }).join("/") + "）", c: hits.length ? "ok" : "degraded" });
    steps.push({ t: "规则检查：命中 " + (r.checks || []).filter(function (c) { return c.fired; }).length + " 条", c: "ok" });
    steps.push({ t: "归因：" + (r.diagnosisState === "attributed" ? "有假设 " + r.hypotheses.length + " 个" : r.diagnosisState === "unattributed" ? "降级并给补证清单" : "无异常"), c: r.diagnosisState === "unattributed" ? "degraded" : r.diagnosisState === "attributed" ? "ok" : "skipped" });
    steps.push({ t: "证据闸门：" + (r.status === "insufficient_evidence" ? "不足，拒答" : "通过（可追到数据行与文档）"), c: r.status === "insufficient_evidence" ? "blocked" : "ok" });
    steps.push({ t: "动作输出：" + (r.actions || []).length + " 条（含责任人与验证方式）", c: (r.actions || []).length ? "ok" : "skipped" });
    $("trace").innerHTML = steps.map(function (s) { return '<span class="step ' + s.c + '">' + esc(s.t) + "</span>"; }).join("") +
      '<span class="step">版本 ' + esc(A.versionId().slice(0, 8)) + "</span>";
  }

  function ask(q) {
    q = (q || "").trim();
    if (!q) return;
    var r = A.answer(q);
    $("answer").innerHTML = '<div class="ans">' + md(r.text) + "</div>";
    renderTrace(r, q);
    state.last = { question: q, result: r };
  }

  function renderSamples() {
    var qs = [
      "新港区为什么离网率上升，我该怎么办？",
      "城西区这周有什么异常？",
      "城南区装维积压要不要增员，增多少人？",
      "城东区这周要不要干预？",
      "城北区的离网率是多少？",
      "新港区竞品降价幅度是多少？"
    ];
    $("samples").innerHTML = "";
    qs.forEach(function (q) {
      var b = el("button", "ghost", esc(q.length > 22 ? q.slice(0, 21) + "…" : q));
      b.style.fontSize = "12px"; b.style.padding = "6px 10px"; b.title = q;
      b.onclick = function () { $("q").value = q; ask(q); };
      $("samples").appendChild(b);
    });
  }

  /* ---------- 运行记录导出：内容只由输入决定，同输入 → 同文件 ---------- */
  function exportRecord() {
    var region = E.getRegion(state.region), c = E.checkRegion(region), dg = E.diagnose(region), w = E.whatIf(state.region, { addStaff: state.add, weeks: state.weeks });
    var rec = {
      app: "电信经营决策助手", version: E.version, versionId: A.versionId(),
      dataReport: R.meta.reportId, period: R.meta.period, region: region.id,
      regionName: region.name, riskScore: c.score,
      checks: c.checks.map(function (x) { return { id: x.id, label: x.label, fired: x.fired, detail: x.detail, ref: x.ref }; }),
      conditions: dg.conditions, diagnosisState: dg.state,
      hypotheses: dg.hypotheses.map(function (h) { return { id: h.id, confidence: h.confidence, refs: h.refs, hypothesis: h.hypothesis }; }),
      evidenceGap: dg.evidenceGap, counterEvidence: dg.counterEvidence,
      whatIf: { addStaff: w.addStaff, weeks: w.weeks, base: w.base, assumption: w.assumption, rows: w.rows, minAddToStopGrowth: w.minAddToStopGrowth, needForThreshold: w.addToReachThresholdInWeeks, caseCheck: w.caseCheck },
      question: state.last ? state.last.question : null,
      answer: state.last ? state.last.result.text : null,
      citations: state.last ? (state.last.result.citations || []) : []
    };
    var body = JSON.stringify(rec, null, 2);
    var blob = new Blob([body], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "run-" + region.id + "-add" + state.add + "w" + state.weeks + "-" + E.hash(body) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function renderAll() { renderTabs(); renderKpis(); renderCharts(); renderChecks(); renderWhatIf(); }

  function init() {
    renderMeta(); renderSamples(); renderAll();
    $("ask").onclick = function () { ask($("q").value); };
    $("q").addEventListener("keydown", function (e) { if (e.key === "Enter") ask($("q").value); });
    $("export").onclick = exportRecord;
    $("add").oninput = function () { state.add = +this.value; $("addv").textContent = state.add; renderWhatIf(); };
    $("wk").onchange = function () { state.weeks = +this.value; renderWhatIf(); };
    ask("新港区为什么离网率上升，我该怎么办？");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
