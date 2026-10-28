/* Skill 清单 v1.0.0 — telecom-ops-decision（引擎按此驱动检查、归因与行动方案） */
(function (g) {
  var SKILL = {
    id: "telecom-ops-decision",
    name: "电信经营周报决策 Skill",
    version: "1.0.0",
    owner: "经营分析组",
    purpose: "把一份经营周报转成可复核的结构化判断、原因假设与带验证指标的行动方案，并在证据不足时拦截。",

    inputs: {
      required: [
        { field: "report.period", label: "统计周期", why: "所有环比与趋势判断依赖周期口径" },
        { field: "report.regions[].series", label: "区县指标序列", why: "至少 2 周数据才能判断趋势" },
        { field: "report.weeks", label: "周序列", why: "确定趋势窗口长度" }
      ],
      optional: [
        { field: "installStaff", label: "装维在岗人数", why: "缺失时产能测算降级为说明性结论" },
        { field: "installArrive", label: "装维日均到达", why: "缺失时无法做积压核验" }
      ],
      minWeeks: 2,
      outOfScopePolicy: "问题所需字段不在 dataDict.available 内 → 输出证据不足并拦截，不用经验值替代"
    },

    /* 工作流节点（应用与测试都按此顺序执行并留痕） */
    steps: [
      { id: "intake",      name: "输入校验",     owner: "engine", output: "校验结果/缺失项" },
      { id: "route",       name: "意图路由",     owner: "engine", output: "路由类型 + 置信度" },
      { id: "scope_check", name: "证据边界检查", owner: "engine", output: "可用/不可用 + 拦截原因" },
      { id: "retrieve",    name: "RAG 检索",     owner: "retriever", output: "命中片段 + 出处 + 分数" },
      { id: "compute",     name: "指标计算",     owner: "engine", output: "当前值/环比/趋势/阈值" },
      { id: "diagnose",    name: "原因假设排序", owner: "engine", output: "假设 + 支持证据 + 置信度" },
      { id: "gate",        name: "证据闸门",     owner: "engine", output: "pass / blocked + 理由" },
      { id: "plan",        name: "行动方案",     owner: "engine", output: "动作 + 责任 + 验证指标 + 复核时点" },
      { id: "report",      name: "结构化输出",   owner: "engine", output: "结论卡 + 运行记录" }
    ],

    /* 检查规则：阈值来自 RAG D1/D2/D5，与文档同源 */
    checks: [
      { id: "C1", metric: "churnRate",      rule: ">= 1.50", severity: "high",   ref: "D1", label: "离网率触碰红线" },
      { id: "C2", metric: "installBacklog", rule: "> 250",   severity: "high",   ref: "D2", label: "积压超清理阈值" },
      { id: "C3", metric: "complaints",     rule: "> 60",    severity: "medium", ref: "D5", label: "投诉超周阈值" },
      { id: "C4", metric: "fusionPen",      rule: "< 55.0",  severity: "medium", ref: "D3", label: "融合渗透率低于目标" },
      { id: "C5", metric: "arpu",           rule: "< 72.0",  severity: "low",    ref: "D1", label: "综合ARPU低于目标" },
      { id: "C6", metric: "bbNetAdd",       rule: "trend_down", severity: "low", ref: "D1", label: "净增连续下滑" },
      { id: "C7", metric: "installBacklog", rule: "cross_check", severity: "medium", ref: "D2", label: "积压增量口径核验" }
    ],

    /* 归因 playbook：触发条件 → 假设 → 动作（全部可追溯，不含自由发挥） */
    playbook: [
      {
        id: "P1",
        trigger: "backlog_high && complaints_high",
        hypothesis: "装维交付超时是投诉与离网的主因，链条为积压上升→P2超时→安装类投诉→合约窗口离网",
        weight: 0.9, refs: ["D2", "D5", "D6"],
        actions: [
          { id: "A1", action: "P1/P2 分级清理：P1 当日、P2 三日内承诺兑现，剩余资源排 P3", owner: "网络运营部", horizon: "本周内", verify: "P2 三日达成率 ≥ 95%", risk: "挤压 P3，需向客户同步排期" },
          { id: "A2", action: "临时外协承接 P3 与部分 P2，自有人员保 P1", owner: "网络运营部", horizon: "1~2 周", verify: "积压周下降 ≥ 100 单", risk: "外协成本口径未提供，收益无法在本样本测算" },
          { id: "A3", action: "超时工单客户主动告知与预约改期，降低安抚型投诉", owner: "客户服务部", horizon: "本周内", verify: "安装类投诉周环比下降", risk: "仅治表，需与 A1 同步" }
        ]
      },
      {
        id: "P2",
        trigger: "churn_high && fusion_down",
        hypothesis: "融合渗透率下滑削弱黏性，单宽带用户在合约到期窗口更易离网",
        weight: 0.7, refs: ["D1", "D3"],
        actions: [
          { id: "A4", action: "装维上门随销融合套餐 A，优先存量单宽用户", owner: "市场经营部", horizon: "2~4 周", verify: "融合渗透率周提升 ≥ 0.5pp", risk: "折扣拉低当期 ARPU，须看 12 个月留存" },
          { id: "A5", action: "存量单宽用户定向外呼升级（配合随销，不做单点依赖）", owner: "市场经营部", horizon: "2 周", verify: "外呼转化率 ≥ 3%", risk: "外呼转化低于随销，产能有限" }
        ]
      },
      {
        id: "P3",
        trigger: "channel_down && churn_high",
        hypothesis: "渠道订单连续下滑削弱新增与存量触点，加速客户流失",
        weight: 0.5, refs: ["D4"],
        actions: [
          { id: "A6", action: "对连续两月低于基准 70% 的门店做产能辅导与政策复核", owner: "渠道管理部", horizon: "2 周", verify: "门店订单回升至基准 85%", risk: "需排除竞品集中促销等外部因素" }
        ]
      },
      {
        id: "P4",
        trigger: "staff_shortage",
        hypothesis: "在岗人数不足导致产能低于到达，积压无法自行下降",
        weight: 0.85, refs: ["D2", "D8"],
        actions: [
          { id: "A7", action: "按边际递减假设补员或外协，第 1 周按 50% 产能计", owner: "网络运营部", horizon: "1~2 周", verify: "日产能 ≥ 日均到达，积压转降", risk: "新人 1~2 周爬坡，首周效果打折" },
          { id: "A8", action: "同步上调 P2 承诺口径并向客户显性告知", owner: "客户服务部", horizon: "本周内", verify: "承诺兑现率不下降", risk: "告知口径需与市场部统一" }
        ]
      }
    ],

    /* 人工确认边界：满足条件必须停下来等人确认 */
    confirmation: {
      requiredBefore: [
        { when: "涉及对外承诺变更（SLA/口径/价格）", reason: "影响客户承诺与合规" },
        { when: "涉及增员/外协等资源投入", reason: "成本口径缺失，收益无法验证" },
        { when: "证据闸门为 blocked", reason: "结论不可用，须补数据" }
      ],
      alwaysHumanOwned: ["是否采纳建议", "资源投入决策", "对外口径与价格调整"]
    },

    /* 失败与降级语义 */
    failure: {
      insufficientEvidence: "输出'证据不足'，列所需字段/来源/口径/周期，不做替代推断",
      missingOptionalField: "标注'降级'，把相关结论改写为待补数据后再判断",
      outOfScopeRegion: "拦截并说明样本范围"
    }
  };
  if (typeof module === "object" && module.exports) module.exports = SKILL;
  else g.JDSkill = SKILL;
})(typeof globalThis !== "undefined" ? globalThis : this);
