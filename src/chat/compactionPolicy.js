// 自动压缩的 token 预算策略 —— **全仓唯一阈值来源**（Z 系 #5 起，Z/M/D 整合后）。
//
// 口径：阈值 = min(窗口 × 比例, 窗口 − 输出预留 − 余量)。先给输出留够，再算能装多少历史。
// 比例法对大窗口够用，对小窗口不成立（窗口 32k 时 85% = 27.2k，留给输出的只有 ~4.8k）。
//
// 整合说明（2026-10-10，三条线各自独立收敛到同一公式）：
// - Z 系：本模块（双规则取严 + 连续失败上限 + 模型输出预留参数）；
// - M 系：`chat/contextUsage.resolveCompactionThreshold`（余量 65536）——已改为委托本模块，
//   唯一来源在这里；
// - D 系：把 0.8/0.85/0.7 三个**语义不同**的阈值具名化（见下），避免被「顺手统一」。
//
// 纯模块：零 import、零原生依赖，Node 直测。

// 模型未声明输出上限时的兜底预留。
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 32_000;
// 额外余量：**采用 M 系的 65536**（Z 系旧值 13000 偏小，同窗口下会晚压约 50k token）。
// 这个数字决定「压得多早」，需真机实测后再调；集中在这里，别散落到调用点。
export const DEFAULT_HEADROOM_TOKENS = 65_536;

// 三个阈值语义不同，各自具名（D 系整合）；历史上 ChatScreen 把 0.85/0.7 硬编码在渲染里、
// 常量却是 0.8，看着像笔误——**不是笔误**，命名清楚以免下次有人「顺手统一」。
export const MEMORY_SUMMARY_RATIO = 0.8;        // 记忆总结绕过条数阈值的通用口径
export const SESSION_AUTO_COMPACT_RATIO = 0.85; // 会话空闲自动压缩
export const SESSION_COMPACT_HINT_RATIO = 0.7;  // 「建议压缩」提示条
export const DEFAULT_AUTOCOMPACT_RATIO = SESSION_AUTO_COMPACT_RATIO;

// 连续失败上限：压缩反复失败（模型报错/解析失败）时不再无限重试。
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 解析策略：窗口优先取声明值；输出预留优先取模型声明（caps.maxOutput），其次默认；
// 余量默认 65536。thresholdTokens = min(窗口×比例, 窗口−预留−余量)；
// 预算非正（窗口太小）时退回比例上限，保证阈值恒 > 0，不会每轮都触发。
export function resolveAutoCompactPolicy({
  contextWindow = 0,
  maxOutputTokens = 0,
  ratio = DEFAULT_AUTOCOMPACT_RATIO,
  outputReserveTokens,
  headroomTokens,
  // 兼容旧调用名（Z 系曾叫 bufferTokens）。
  bufferTokens,
} = {}) {
  const window = positiveInt(contextWindow);
  const ratioValue = Number(ratio) > 0 && Number(ratio) <= 1 ? Number(ratio) : DEFAULT_AUTOCOMPACT_RATIO;
  const reserve = Number.isFinite(Number(outputReserveTokens))
    ? Math.max(0, Math.floor(Number(outputReserveTokens)))
    : (positiveInt(maxOutputTokens) || DEFAULT_OUTPUT_RESERVE_TOKENS);
  const headroomInput = Number.isFinite(Number(headroomTokens))
    ? Number(headroomTokens)
    : (Number.isFinite(Number(bufferTokens)) ? Number(bufferTokens) : DEFAULT_HEADROOM_TOKENS);
  const headroom = Math.max(0, Math.floor(headroomInput));
  if (window <= 0) {
    return {
      contextWindow: 0,
      outputReserveTokens: reserve,
      headroomTokens: headroom,
      ratio: ratioValue,
      budgetTokens: 0,
      thresholdTokens: 0,
    };
  }
  const ratioCeiling = Math.floor(window * ratioValue);
  const budget = window - reserve - headroom;
  const thresholdTokens = budget > 0 ? Math.min(ratioCeiling, budget) : ratioCeiling;
  return {
    contextWindow: window,
    outputReserveTokens: reserve,
    headroomTokens: headroom,
    ratio: ratioValue,
    budgetTokens: budget,
    thresholdTokens: Math.max(1, thresholdTokens),
  };
}

export function shouldAutoCompactByBudget(tokens, policy) {
  const threshold = Number(policy && policy.thresholdTokens);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  return Number(tokens) >= threshold;
}

// 两条规则取更严者：字节阈值（AsyncStorage 落盘上限）与 token 预算（上下文窗口）。
export function shouldCompactAnyRule({ bytes = 0, tokens = 0, byteThreshold = 0, policy = null } = {}) {
  const limit = Number(byteThreshold);
  const byBytes = Number.isFinite(limit) && limit > 0 && Number(bytes) > limit;
  const byTokens = shouldAutoCompactByBudget(tokens, policy);
  return { compact: byBytes || byTokens, byBytes, byTokens };
}

export function shouldStopAutoCompact(failures) {
  return Number(failures) >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
}
