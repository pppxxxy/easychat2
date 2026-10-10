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
  MEMORY_SUMMARY_RATIO,
  SESSION_AUTO_COMPACT_RATIO,
  SESSION_COMPACT_HINT_RATIO,
  resolveAutoCompactPolicy,
} from './compactionPolicy.js';

// 未声明窗口时的兜底（tokens）。取 200000：主流在线模型（DeepSeek / GPT / Claude / Gemini
// 的新一代）上下文都在 128k~200k 这一档，32k 会让「上下文占用」显示虚高、80% 自动压缩
// 过早触发（对话还没多长就被压缩，摘要反而丢信息）。
export const DEFAULT_CONTEXT_WINDOW = 200000;
// 三个阈值**语义不同、各自具名**，值本身只在 compactionPolicy 定义一次（这里只转发，
// 免得两处各写一份「看着像笔误」的数字；改值只改 compactionPolicy）：
//   AUTO_COMPACT_RATIO        0.8 ——「上下文偏高」通用口径（记忆总结绕过条数阈值 /
//                                    工作区占用条转警示色），不是会话压缩阈值；
//   SESSION_AUTO_COMPACT_RATIO 0.85 —— 会话空闲静默自动压缩；
//   SESSION_COMPACT_HINT_RATIO 0.7  ——「建议压缩」提示条。
export const AUTO_COMPACT_RATIO = MEMORY_SUMMARY_RATIO;
export { SESSION_AUTO_COMPACT_RATIO, SESSION_COMPACT_HINT_RATIO };

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
  // 没给窗口就**不编一个**：拿默认窗口算出来的 ratio 是假数字（真窗口可能是 128k 或 200k），
  // 谁要是信了它，看到的就是错的占用率。给 0 表示「只有 token，没有占比」。
  const declared = Number(windowSize);
  const window = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : 0;
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