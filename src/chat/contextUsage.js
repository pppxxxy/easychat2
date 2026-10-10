// 上下文占用估算（纯函数，可 Node 直测）。
//
// 用途：工作区面板的「上下文占用」显示 + 聊天的 80% 自动压缩阈值。
// - token 估算复用本地模型裁剪的同一估算器（localContext.estimateMessagesTokens），
//   口径一致；这是**估算**不是精确计费（在线 API 不返回 usage）。
// - 窗口大小：模型声明的 contextWindow（每模型一份能力）> 本地模型的 n_ctx >
//   保守默认 32000（未声明时按最小常见窗口保守处理，宁可早压缩不溢出）。

import { estimateMessagesTokens } from '../localModel/localContext.js';
import {
  DEFAULT_AUTOCOMPACT_RATIO,
  DEFAULT_HEADROOM_TOKENS,
  resolveAutoCompactPolicy,
} from './compactionPolicy.js';

// 未声明窗口时的兜底（tokens）。取 200000：主流在线模型（DeepSeek / GPT / Claude / Gemini
// 的新一代）上下文都在 128k~200k 这一档，32k 会让「上下文占用」显示虚高、80% 自动压缩
// 过早触发（对话还没多长就被压缩，摘要反而丢信息）。
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const AUTO_COMPACT_RATIO = 0.8;

// 会话消息（{ role, text }）→ 估算 token。
export function estimateHistoryTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return estimateMessagesTokens(list.map(item => ({
    role: item && item.role,
    content: String((item && item.text) || ''),
  })));
}

// 窗口解析：声明的 contextWindow 优先，其次本地模型 n_ctx，最后保守默认。
export function resolveContextWindow({ declared = 0, localContextSize = 0 } = {}) {
  const values = [Number(declared), Number(localContextSize)];
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function computeContextUsage(messages, windowSize) {
  const window = Number.isFinite(Number(windowSize)) && Number(windowSize) > 0
    ? Math.floor(Number(windowSize))
    : DEFAULT_CONTEXT_WINDOW;
  const tokens = estimateHistoryTokens(messages);
  return { tokens, window, ratio: window > 0 ? tokens / window : 0 };
}

// 是否到达自动压缩线（默认 80%）。
export function shouldAutoCompact(contextUsage, { ratio = AUTO_COMPACT_RATIO } = {}) {
  return !!(contextUsage
    && Number.isFinite(contextUsage.ratio)
    && contextUsage.ratio >= ratio);
}

// 触发阈值 = floor(min(W × ratio, W − O − headroom))。
// **Z/M/D 整合后：唯一来源是 chat/compactionPolicy.js**，这里只做委托，保留 M 系调用点不动
//（M 系原值 ratio 0.8 / headroom 65536 已成为 policy 的默认余量）。
export const COMPACTION_HEADROOM_TOKENS = DEFAULT_HEADROOM_TOKENS;
export function resolveCompactionThreshold(windowSize, {
  ratio = DEFAULT_AUTOCOMPACT_RATIO,
  outputCap = 0,
  headroomTokens = DEFAULT_HEADROOM_TOKENS,
} = {}) {
  // 用 outputReserveTokens（而非 maxOutputTokens）传：M 口径里 outputCap=0 表示**不预留**，
  // 而 policy 的 maxOutputTokens=0 表示「未声明 → 用默认预留」，语义不同，不能混。
  return resolveAutoCompactPolicy({
    contextWindow: windowSize,
    outputReserveTokens: Math.max(0, Number(outputCap) || 0),
    ratio,
    headroomTokens,
  }).thresholdTokens;
}

// token 口径的自动压缩判据（配合 resolveCompactionThreshold）。
export function shouldAutoCompactTokens(tokens, windowSize, options) {
  const threshold = resolveCompactionThreshold(windowSize, options);
  return threshold > 0 && Number(tokens) >= threshold;
}