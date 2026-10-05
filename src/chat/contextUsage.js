// 上下文占用估算（纯函数，可 Node 直测）。
//
// 用途：工作区面板的「上下文占用」显示 + 聊天的 80% 自动压缩阈值。
// - token 估算复用本地模型裁剪的同一估算器（localContext.estimateMessagesTokens），
//   口径一致；这是**估算**不是精确计费（在线 API 不返回 usage）。
// - 窗口大小：模型声明的 contextWindow（每模型一份能力）> 本地模型的 n_ctx >
//   保守默认 32000（未声明时按最小常见窗口保守处理，宁可早压缩不溢出）。

import { estimateMessagesTokens } from '../localModel/localContext.js';

export const DEFAULT_CONTEXT_WINDOW = 32000;
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