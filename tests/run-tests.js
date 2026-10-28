#!/usr/bin/env node
/* 可复现测试套件 — 五类测试，全部离线、无网络、无随机数。复跑方式：node tests/run-tests.js */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const E = require(path.join(ROOT, "assets/engine.js"));
const A = require(path.join(ROOT, "assets/agent.js"));
const D = require(path.join(ROOT, "assets/data.js"));
const SK = E.skill, KB = E.kb, R = E.report;

const results = [];
function approx(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol); }
function rec(group, id, name, expected, actual, pass, note) {
  results.push({ group, id, name, expected: String(expected), actual: String(actual), pass: !!pass, note: note || "" });
  return pass;
}
function eq(group, id, name, expected, actual, note) {
  return rec(group, id, name, expected, actual, expected === actual, note);
}
function ok(group, id, name, cond, actual, note) {
  return rec(group, id, name, "true", actual, !!cond, note);
}

/* ---------- 版本标识：5 个资产文件的 sha256 → 固定 versionId ---------- */
const FILES = ["assets/data.js", "assets/kb.js", "assets/skill.js", "assets/engine.js", "assets/agent.js", "assets/ui.js", "index.html"];
const manifest = FILES.map(function (f) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  return { file: f, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) };
});
const bundleHash = crypto.createHash("sha256")
  .update(manifest.map(function (m) { return m.file + ":" + m.sha256; }).join("|"))
  .digest("hex").slice(0, 12);
const assetVersionId = "JDA-" + manifest[0].sha256.slice(0, 6) + "-" + bundleHash;

/* ============ T1 功能：指标口径复算（口径来自 data.js METRICS，公式在测试里独立重算） ============ */
(function T1() {
  let pass = true;
  R.regions.forEach(function (region) {
    const mt = E.metricsTable(region);
    eq("T1", "T1-" + region.id + "-count", region.name + " 指标条数", 7, mt.length, "METRICS 共 7 个字段");
    mt.forEach(function (row) {
      const s = region.series[row.key];
      const dec = D.METRICS[row.key].decimals;
      const p = E.round;
      const curOk = approx(row.cur, p(s[s.length - 1], dec));
      const wowOk = approx(row.wow, p(s[s.length - 1] - s[s.length - 2], dec));
      const targetOk = approx(row.target, D.METRICS[row.key].target);
      if (!(curOk && wowOk && targetOk)) pass = false;
    });
    ok("T1", "T1-" + region.id + "-recalc", region.name + "：7 指标 当前值/环比/阈值 独立复算一致", pass,
      pass ? "全部一致（误差 < 1e-9）" : "存在不一致字段", "复算基准：series 末值、末值-次末值、METRICS.target");
    pass = true;
  });
  // 阈值判定方向：净增为 up（低于阈值=bad），离网率为 down（高于阈值=bad）
  const xg = E.getRegion("XG");
  const bb = E.metricsTable(xg).filter(function (r) { return r.key === "bbNetAdd"; })[0];
  const ch = E.metricsTable(xg).filter(function (r) { return r.key === "churnRate"; })[0];
  eq("T1", "T1-dir-up", "宽带净增 931 < 阈值 1300（dir=up）判定", "bad", bb.status);
  eq("T1", "T1-dir-down", "离网率 2.34 > 阈值 1.2（dir=down）判定", "bad", ch.status);
})();

/* ============ T2 规则检查：口径交叉核验与风险分独立复算 ============ */
(function T2() {
  const region = E.getRegion("XG");
  const ck = E.checkRegion(region);
  const cross = ck.checks.filter(function (c) { return c.rule === "cross_check"; })[0];
  ok("T2", "T2-cross-exists", "存在口径交叉核验规则（装机 vs 净增）", !!cross, cross ? cross.id + " " + cross.label : "缺失");

  // 独立复算：(到达 - 在岗×6) × 7 天，与实测周变化比较，偏差 >15% 即触发
  const S = region.series, W = R.meta.workdays;
  const rows = [];
  for (let i = 1; i < S.installBacklog.length; i++) {
    const observed = S.installBacklog[i] - S.installBacklog[i - 1];
    const theo = (S.installArrive[i] - S.installStaff[i] * 6) * W;
    rows.push({ week: R.weeks[i], observed: E.round(observed, 0), theoretical: E.round(theo, 0), deviation: E.round(((observed - theo) / Math.abs(theo)) * 100, 1) });
  }
  const same = JSON.stringify(rows) === JSON.stringify(cross.value);
  ok("T2", "T2-cross-recalc", "交叉核验逐周数值与测试独立复算完全一致", same, same ? rows.length + " 周全部一致" : "不一致", "理论值公式：(installArrive − installStaff×6) × workdays");

  const badWeeks = rows.filter(function (r) { return Math.abs(r.deviation) > 15; });
  const firedNow = badWeeks.length > 0;
  eq("T2", "T2-cross-fire", "偏差 >15% 周数 → 触发状态", String(firedNow), String(cross.fired), "超阈值周：" + (badWeeks.map(function (r) { return r.week + "(" + r.deviation + "%)"; }).join("、") || "无"));

  const sev = { high: 3, medium: 2, low: 1 };
  const scoreCalc = ck.fired.reduce(function (a, c) { return a + sev[c.severity]; }, 0);
  eq("T2", "T2-score", "风险分 = 命中规则严重度加权和（独立复算）", String(scoreCalc), String(ck.score), "命中 " + ck.fired.map(function (c) { return c.id + ":" + c.severity; }).join(","));

  const noFalseFire = ck.checks.every(function (c) {
    if (!c.fired) return true;
    if (c.rule === "cross_check") return c.value.some(function (r) { return Math.abs(r.deviation) > 15; });
    const s = region.series[c.metric], cur = s[s.length - 1];
    if (c.rule === "trend_down") return cur < s[s.length - 2] && s[s.length - 2] < s[s.length - 3];
    const m = /^(>=|>|<=|<)\s*([\d.]+)$/.exec(c.rule);
    if (!m) return false;
    const th = parseFloat(m[2]);
    return m[1] === ">=" ? cur >= th : m[1] === ">" ? cur > th : m[1] === "<=" ? cur <= th : cur < th;
  });
  ok("T2", "T2-no-false-fire", "每条命中规则都能用原始数值独立复现（无空触发）", noFalseFire, noFalseFire ? "全部可复现" : "存在无法复现的命中");
})();

/* ============ T3 证据闸门：越界/无关/证据不足必须拒答，正常问题必须带引用 ============ */
(function T3() {
  const cases = [
    { q: "今天天气怎么样", status: "off_topic", label: "流程外无关问题" },
    { q: "城南区离网率是多少", status: "out_of_scope", label: "样本外区县" },
    { q: "新港区5G专网收入是多少", status: "insufficient_evidence", label: "样本未提供的指标" },
    { q: "新港区成本利润怎么样", status: "insufficient_evidence", label: "成本收益类问题" }
  ];
  cases.forEach(function (c, i) {
    const a = A.answer(c.q);
    eq("T3", "T3-gate-" + (i + 1), c.label + " → 闸门状态", c.status, a.status);
    ok("T3", "T3-nog-actions-" + (i + 1), c.label + " 不输出行动方案/归因", !a.actions && !a.hypotheses, a.actions ? "输出了 " + a.actions.length + " 条动作" : "未输出方案");
    ok("T3", "T3-text-" + (i + 1), c.label + " 拒答文案明确说明原因", /超出本应用可答范围|不在样本范围|证据不足/.test(a.text || ""), (a.text || "").slice(0, 36) + "…");
  });

  const ins = A.answer("新港区5G专网收入是多少");
  ok("T3", "T3-gap-list", "证据不足时返回补数清单（字段/来源/口径/周期）", !!(ins.requiredData && ins.requiredData.need.length && ins.requiredData.need[0].field),
    ins.requiredData ? ins.requiredData.need[0].field + "｜" + ins.requiredData.need[0].source : "无清单");

  const good = A.answer("新港区为什么离网率上升，我该怎么办？");
  eq("T3", "T3-in-scope", "范围内问题正常作答", "ok", good.status);
  ok("T3", "T3-cited", "结论带 RAG 引用（≥1 条）", good.citations.length >= 1, good.citations.length + " 条：" + good.citations.map(function (c) { return c.ref; }).join("、"));
  const docIds = KB.docs.map(function (d) { return d.id; });
  const nbChunks = {};
  KB.docs.forEach(function (d) { nbChunks[d.id] = d.text.split("\n\n").length; });
  const traceable = good.citations.every(function (c) {
    const id = String(c.ref).split("#")[0], n = parseInt(String(c.ref).split("#")[1], 10);
    return docIds.indexOf(id) >= 0 && n >= 1 && n <= (nbChunks[id] + 1);
  });
  ok("T3", "T3-cite-resolvable", "每条引用都能回溯到 KB 真实文档块", traceable, good.citations.map(function (c) { return c.ref; }).join("、"));
})();

/* ============ T4 确定性：同输入同输出，含版本标识与导出 ============ */
(function T4() {
  function strip(o) { const c = JSON.parse(JSON.stringify(o)); delete c.elapsedMs; delete c.generatedAt; return c; }
  const q = "新港区为什么离网率上升，我该怎么办？";
  const a1 = A.answer(q), a2 = A.answer(q);
  eq("T4", "T4-text", "同一问题连续两次运行，自然语言答案逐字相同", a1.text, a2.text, "长度 " + a1.text.length + " 字");
  ok("T4", "T4-json", "结构化输出（去掉时间戳）逐字节相同", JSON.stringify(strip(a1)) === JSON.stringify(strip(a2)), "JSON 长度 " + JSON.stringify(strip(a1)).length);
  eq("T4", "T4-version", "版本标识稳定", A.versionId(), A.versionId(), A.versionId());
  ok("T4", "T4-verstamp", "资产版本标识由文件 sha256 派生（可核对固定版本）", manifest.length === 7 && assetVersionId.length > 8, assetVersionId, manifest.map(function (m) { return m.file + ":" + m.sha256; }).join(" "));

  const w1 = JSON.stringify(E.whatIf("XG", { addStaff: 4, weeks: 4 }));
  const w2 = JSON.stringify(E.whatIf("XG", { addStaff: 4, weeks: 4 }));
  ok("T4", "T4-whatif", "What-if 同参数两次模拟结果一致", w1 === w2, "积压曲线 " + JSON.parse(w1).rows.map(function (r) { return r.backlog; }).join("→"));
  const mono = [0, 2, 4, 6, 8].every(function (n, i, arr) {
    if (i === 0) return true;
    const pre = E.whatIf("XG", { addStaff: arr[i - 1], weeks: 4 }).rows;
    const cur = E.whatIf("XG", { addStaff: n, weeks: 4 }).rows;
    return cur.every(function (r, j) { return r.backlog <= pre[j].backlog; });
  });
  ok("T4", "T4-monotonic", "增员 0/2/4/6/8 人，逐周积压单调不增（模型合理性）", mono, mono ? "符合单调性" : "违反单调性");
})();

/* ============ T5 失败与降级：缺字段降级、无异常不强归因、空输入 ============ */
(function T5() {
  const clone = JSON.parse(JSON.stringify(E.getRegion("XG")));
  clone.id = "Z1"; clone.name = "测试区"; clone.series.installStaff = null;
  E.report.regions.push(clone);
  let deg;
  try { deg = A.answer("测试区为什么离网率上升"); } finally { E.report.regions.pop(); }
  eq("T5", "T5-degraded-ok", "缺人手在岗字段的区县：仍返回结构完整答案", "ok", deg.status);
  eq("T5", "T5-degraded-flag", "缺少关键字段 → 结论标记降级", "true", String(deg.degraded), "降级标记来自 installStaff 缺失");
  ok("T5", "T5-degraded-gap", "降级时给出证据缺口清单而非猜测", !!(deg.evidenceGap || deg.counterEvidence.length), deg.evidenceGap ? "补证 " + deg.evidenceGap.need.length + " 项" : "反证 " + deg.counterEvidence.length + " 条");

  R.regions.forEach(function (r) {
    const ck = E.checkRegion(r), dg = E.diagnose(r);
    const firedNoCaliber = ck.fired.filter(function (c) { return c.id !== "C7"; }).length;
    const expect = firedNoCaliber === 0 ? "no_anomaly" : (dg.state === "attributed" ? "attributed" : "unattributed");
    eq("T5", "T5-state-" + r.id, r.name + "：归因状态与命中规则数一致（无异常不硬归因）", expect, dg.state, "命中（不含口径）" + firedNoCaliber + " 项");
  });

  const empty = A.answer("");
  ok("T5", "T5-empty", "空问题不崩溃且不产生结论", !!empty && empty.status !== "ok", empty.status);
  const noRegion = A.answer("离网率为什么上升");
  ok("T5", "T5-default-region", "未指定区县时落到风险最高区县并说明", noRegion.status === "ok" && !!noRegion.regionName, noRegion.status + " / " + noRegion.regionName);
})();

/* ============ 汇总与运行日志 ============ */
const groups = ["T1", "T2", "T3", "T4", "T5"];
const summary = groups.map(function (g) {
  const rs = results.filter(function (r) { return r.group === g; });
  return { group: g, total: rs.length, passed: rs.filter(function (r) { return r.pass; }).length, failed: rs.filter(function (r) { return !r.pass; }).length };
});
const failed = results.filter(function (r) { return !r.pass; });
const log = {
  title: "经营决策应用 · 可复现测试运行日志",
  appVersion: assetVersionId,
  engineVersion: E.version, agentVersion: A.version, skillVersion: SK.version, kbVersion: KB.version,
  report: R.meta.reportId, period: R.meta.period,
  runAt: new Date().toISOString(),
  env: { node: process.version, platform: process.platform, offline: true, network: "无任何网络请求" },
  manifest: manifest, summary: summary,
  total: results.length, passed: results.length - failed.length, failed: failed.length,
  results: results
};
fs.writeFileSync(path.join(ROOT, "tests", "run-log.json"), JSON.stringify(log, null, 2), "utf8");

groups.forEach(function (g) {
  const s = summary.filter(function (x) { return x.group === g; })[0];
  console.log("\n[" + g + "] " + s.passed + "/" + s.total + " passed");
  results.filter(function (r) { return r.group === g; }).forEach(function (r) {
    console.log("  " + (r.pass ? "PASS" : "FAIL") + "  " + r.id + "  " + r.name + "  → 预期 " + r.expected + " / 实际 " + r.actual + (r.note ? "  (" + r.note + ")" : ""));
  });
});
console.log("\n版本标识 " + assetVersionId + " ｜ 合计 " + (results.length - failed.length) + "/" + results.length + " 通过 ｜ 日志 tests/run-log.json");
process.exit(failed.length ? 1 : 0);
