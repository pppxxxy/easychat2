// 自动压缩的 token 预算策略（Z 系采纳 #5，对照 zai-org/ZCode 的 compact/policy.ts）。
//
// 现状：聊天页用固定比例（85% of contextWindow）判断是否自动压缩。比例法对大窗口够用，
// 对小窗口不成立——窗口 32k 时 85% = 27.2k，留给输出的只有 ~4.8k，模型刚开口就被截断。
// ZCode 的口径是**先给输出留够**再算阈值：阈值 = 窗口 − 输出预留 − 缓冲。
// 本模块把这条口径、与「两条规则取更严者」「连续失败上限」抽成纯函数，供聊天页共用。
//
// 纯模块：零 import、零原生依赖，Node 直测。

export const DEFAULT_OUTPUT_RESERVE_TOKENS = 32_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_RATIO = 0.85;
// 连续失败上限：压缩反复失败（模型报错/解析失败）时不再无限重试。
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 解析策略：窗口优先取声明值；输出预留优先取模型声明，其次默认；缓冲默认 13k。
// thresholdTokens = min(窗口×比例, 窗口−预留−缓冲)，预算非正（窗口太小）时退回比例上限，
// 保证阈值恒 > 0，不会每轮都触发。
export function resolveAutoCompactPolicy({
  contextWindow = 0,
  maxOutputTokens = 0,
  ratio = DEFAULT_AUTOCOMPACT_RATIO,
  outputReserveTokens,
  bufferTokens,
} = {}) {
  const window = positiveInt(contextWindow);
  const ratioValue = Number(ratio) > 0 && Number(ratio) <= 1 ? Number(ratio) : DEFAULT_AUTOCOMPACT_RATIO;
  const reserve = Number.isFinite(Number(outputReserveTokens))
    ? Math.max(0, Math.floor(Number(outputReserveTokens)))
    : (positiveInt(maxOutputTokens) || DEFAULT_OUTPUT_RESERVE_TOKENS);
  const buffer = Number.isFinite(Number(bufferTokens))
    ? Math.max(0, Math.floor(Number(bufferTokens)))
    : AUTOCOMPACT_BUFFER_TOKENS;
  if (window <= 0) {
    return {
      contextWindow: 0,
      outputReserveTokens: reserve,
      bufferTokens: buffer,
      ratio: ratioValue,
      budgetTokens: 0,
      thresholdTokens: 0,
    };
  }
  const ratioCeiling = Math.floor(window * ratioValue);
  const budget = window - reserve - buffer;
  const thresholdTokens = budget > 0
    ? Math.min(ratioCeiling, budget)
    : ratioCeiling;
  return {
    contextWindow: window,
    outputReserveTokens: reserve,
    bufferTokens: buffer,
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
