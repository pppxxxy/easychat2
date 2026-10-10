// 上下文占用估算（纯函数，可 Node 直测）。
//
// 用途：工作区面板的「上下文占用」显示 + 聊天的 80% 自动压缩阈值。
// - token 估算复用本地模型裁剪的同一估算器（localContext.estimateMessagesTokens），
//   口径一致；这是**估算**不是精确计费（在线 API 不返回 usage）。
// - 窗口大小：模型声明的 contextWindow（每模型一份能力）> 本地模型的 n_ctx >
//   保守默认 32000（未声明时按最小常见窗口保守处理，宁可早压缩不溢出）。

import { estimateMessagesTokens } from '../localModel/localContext.js';

// 未声明窗口时的兜底（tokens）。取 200000：主流在线模型（DeepSeek / GPT / Claude / Gemini
// 的新一代）上下文都在 128k~200k 这一档，32k 会让「上下文占用」显示虚高、80% 自动压缩
// 过早触发（对话还没多长就被压缩，摘要反而丢信息）。
export const DEFAULT_CONTEXT_WINDOW = 200000;
// 「上下文偏高」的通用口径：**记忆总结**在占用达到它时绕过条数阈值（memorySummary.js），
// 工作区占用条也用它决定是否转警示色（FilesPanel）。它不是会话压缩阈值——见下面两个。
export const AUTO_COMPACT_RATIO = 0.8;
// 会话压缩（E2）的两条线：≥85% 空闲时静默自动压缩；≥70% 出「建议压缩」提示条。
// 与 AUTO_COMPACT_RATIO 是**两件事**，历史上 ChatScreen 把 0.85/0.7 硬编码在渲染里、
// 常量却是 0.8，看着像笔误（2026-10-10 核实：确为不同语义，不是笔误）。
// 命名清楚以免下次有人「顺手统一」——统一会让记忆总结的触发点或会话压缩的触发点跑偏。
export const SESSION_AUTO_COMPACT_RATIO = 0.85;
export const SESSION_COMPACT_HINT_RATIO = 0.7;

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

// 单段文本的 token 估算（与消息同口径：同一估算器，避免两套数字互相打架）。
export function estimateTextTokens(text) {
  const value = String(text === undefined || text === null ? '' : text).trim();
  if (!value) return 0;
  return estimateMessagesTokens([{ role: 'system', content: value }]);
}

// P2-7：上下文占用明细——把「谁在吃窗口」拆开给用户看。
//
// 输入是调用方**如实测量**得到的段（key + text 或 tokens），这里只做归一、排序与占比；
// 不猜、不补：没测量的部分就不出现在列表里（宁缺勿假）。
// 段顺序按 token 降序——用户一眼看到的是「最大那块是谁」。
export function buildContextBreakdown(segments, windowSize) {
  const window = Number.isFinite(Number(windowSize)) && Number(windowSize) > 0
    ? Math.floor(Number(windowSize))
    : DEFAULT_CONTEXT_WINDOW;
  const list = [];
  for (const raw of Array.isArray(segments) ? segments : []) {
    const key = String((raw && raw.key) || '').trim();
    if (!key) continue;
    const tokens = Number.isFinite(Number(raw && raw.tokens))
      ? Math.max(0, Math.floor(Number(raw.tokens)))
      : estimateTextTokens(raw && raw.text);
    if (tokens <= 0) continue;
    list.push({ key, tokens, ratio: window > 0 ? tokens / window : 0 });
  }
  list.sort((a, b) => b.tokens - a.tokens);
  const total = list.reduce((sum, item) => sum + item.tokens, 0);
  return { window, total, ratio: window > 0 ? total / window : 0, segments: list };
}