/* 数据层 v1.0.0 — 脱敏经营周报（虚构"示例市"三个区县，数字为教学构造值） */
(function (g) {
  var REPORT = {
    meta: {
      tenant: "示例市分公司（脱敏）",
      reportId: "OPS-WK-2026W43",
      period: "2026-10-19 ~ 2026-10-25",
      weekLabel: "2026-W43",
      unit: "区县维度",
      source: "经营周报（教学脱敏样本）",
      owner: "市场经营部",
      workdays: 7
    },
    weeks: ["2026-W40", "2026-W41", "2026-W42", "2026-W43"],
    regions: [
      {
        id: "CD", name: "城东区",
        series: {
          bbNetAdd:      [1420, 1385, 1402, 1368],  // 宽带宽带净增(户)
          churnRate:     [0.95, 1.02, 0.98, 1.01],  // 宽带月离网率(%)
          fusionPen:     [62.1, 62.6, 63.0, 63.4],  // 融合渗透率(%)
          arpu:          [78.5, 78.9, 79.2, 79.0],  // 综合ARPU(元)
          complaints:    [42, 40, 38, 41],          // 投诉工单(件/周)
          installBacklog:[180, 175, 168, 160],      // 装维积压(单,周末时点)
          installStaff:  [22, 22, 22, 22],          // 装维在岗(人)
          installArrive: [128, 126, 130, 127],      // 装维日到达(单/日)
          channelOrders: [980, 1002, 1015, 1023]    // 渠道月订单(单)
        },
        note: "波动在正常区间"
      },
      {
        id: "CX", name: "城西区",
        series: {
          bbNetAdd:      [1180, 1210, 1245, 1288],
          churnRate:     [1.10, 1.08, 1.15, 1.12],
          fusionPen:     [48.2, 50.1, 52.3, 54.0],
          arpu:          [72.1, 72.6, 73.4, 74.1],
          complaints:    [55, 52, 49, 46],
          installBacklog:[240, 235, 230, 222],
          installStaff:  [20, 20, 20, 20],
          installArrive: [119, 118, 120, 117],
          channelOrders: [760, 772, 790, 805]
        },
        note: "融合拉动，质量改善"
      },
      {
        id: "XG", name: "新港区",
        series: {
          bbNetAdd:      [880, 902, 915, 931],
          churnRate:     [1.42, 1.58, 1.91, 2.34],
          fusionPen:     [39.8, 39.5, 38.9, 38.4],
          arpu:          [68.2, 67.5, 66.8, 65.9],
          complaints:    [88, 96, 110, 131],
          installBacklog:[320, 385, 470, 612],
          installStaff:  [18, 18, 18, 18],
          installArrive: [129, 128, 130, 129],
          channelOrders: [610, 600, 585, 572]
        },
        note: "离网与积压同步恶化"
      }
    ]
  };

  /* 指标口径（与 RAG 文档 D1 同源；引擎只按此计算，不另造算法） */
  var METRICS = {
    bbNetAdd:       { name: "宽带净增",    unit: "户/周",  dir: "up",   target: 1300, decimals: 0 },
    churnRate:      { name: "宽带离网率",  unit: "%",      dir: "down", target: 1.50, decimals: 2 },
    fusionPen:      { name: "融合渗透率",  unit: "%",      dir: "up",   target: 55.0, decimals: 1 },
    arpu:           { name: "综合ARPU",    unit: "元",     dir: "up",   target: 72.0, decimals: 1 },
    complaints:     { name: "投诉工单",    unit: "件/周",  dir: "down", target: 60,   decimals: 0 },
    installBacklog: { name: "装维积压",    unit: "单",     dir: "down", target: 250,  decimals: 0 },
    channelOrders:  { name: "渠道订单",    unit: "单/月",  dir: "up",   target: 780,  decimals: 0 }
  };

  /* 数据字典：可用字段 + 明确不支持的问题域（证据不足拦截的依据） */
  var DATA_DICT = {
    available: [
      { field: "bbNetAdd",       level: "区县×周", source: "经营周报", note: "含净增口径" },
      { field: "churnRate",      level: "区县×周", source: "经营周报", note: "滚动月口径" },
      { field: "fusionPen",      level: "区县×周", source: "经营周报", note: "" },
      { field: "arpu",           level: "区县×周", source: "经营周报", note: "综合口径" },
      { field: "complaints",     level: "区县×周", source: "客服工单系统", note: "" },
      { field: "installBacklog", level: "区县×周", source: "装维工单系统", note: "周末时点" },
      { field: "installStaff",   level: "区县×周", source: "人力资源台账", note: "在岗人数" },
      { field: "installArrive",  level: "区县×日", source: "装维工单系统", note: "日均到达" },
      { field: "channelOrders",  level: "区县×月", source: "渠道系统", note: "含门店/线上" }
    ],
    unsupported: [
      { topic: "5G专网",        regex: "5G\\s*专网|专网收入",      reason: "本样本未提供政企/专网收入科目" },
      { topic: "政企DICT",      regex: "DICT|政企|集客",           reason: "本样本不含政企条线数据" },
      { topic: "智家增值",      regex: "智家|增值业务收入|IPTV",   reason: "无增值业务收入明细" },
      { topic: "渠道佣金",      regex: "佣金|酬金|代理费",         reason: "无佣金/酬金结算数据" },
      { topic: "客户个体清单",  regex: "名单|身份证|手机号",       reason: "涉及个人信息，样本已脱敏且不提供" },
      { topic: "成本与利润",    regex: "成本|毛利|利润|投入产出比", reason: "未提供成本口径，无法计算收益" },
      { topic: "地市外比较",    regex: "其他市|全省|对标地市",     reason: "样本仅含示例市三个区县" }
    ]
  };

  var D = { REPORT: REPORT, METRICS: METRICS, DATA_DICT: DATA_DICT };
  if (typeof module === "object" && module.exports) module.exports = D;
  else g.JDData = D;
})(typeof globalThis !== "undefined" ? globalThis : this);
