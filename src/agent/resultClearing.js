// K1：上下文里的工具结果清除（O1 落盘管道的消费方）。
//
// 定位：O1 管「进上下文前落盘」，K1 管「已在上下文里的逐步退役」，N2 管「整段历史重建」。
// 纯逻辑（只依赖纯 token 估算器，无原生依赖；Node 可直测）；落盘与钩子由宿主注入。

import { estimateTextTokens } from '../localModel/localContext.js';
//
// 纪律：
// - **unseen 保护**：某工具结果之后还没有 assistant 回复（模型还没消费它）→ 永不清除。
// - **工作台窗口**：最近 N 条工具结果无论是否消费都不清除（正在用的工作台）。
// - **门槛**：合并文本 ≤ minChars 不值得占位（占位符自身有成本）。
// - **驱逐**：超预算时从候选里按「批内从大到小」驱逐，回到预算内即停。
// - **清除前必先落盘**：落盘失败 → 跳过该条保原文（绝不写假指针）。
// - **配对纪律**：只替换 tool 消息的 content，绝不拆散 toolUse↔toolResult 关联。

export const RESULT_CLEARING_RECENT_WINDOW = 3;
export const RESULT_CLEARING_MIN_CHARS = 120;
// 会话有效字节预算：比 D3 手动压缩阈值（4MB）更早介入，让清除先兜住大部分压力。
export const RESULT_CLEARING_BUDGET_BYTES = 2 * 1024 * 1024;
// 占位符的近似长度（含路径），用于驱逐时的字节估算。
const PLACEHOLDER_ESTIMATE = 100;

// 与 D3 / compactionStatus 同口径的体积估算（JSON 序列化字符数）。
export function estimateContextBytes(messages) {
  try {
    return JSON.stringify(Array.isArray(messages) ? messages : []).length;
  } catch (error) {
    return 0;
  }
}

// 把「token 阈值」换算成 K1 判定的**字符**预算。
//
// 为什么需要它：`RESULT_CLEARING_BUDGET_BYTES` 默认 2MB，那是照「D3 会话压缩阈值 4MB 的一半」
// 定的——可那个 4MB 量的是**落库会话**，K1 量的是**本次请求**的 history。请求上下文的上限是
// 模型窗口（200k token 的中文上下文 ≈ 0.4MB 字符），**2MB 永远够不到**，于是 K1 在生产里
// 一次都不触发。宿主按模型窗口算出真实预算传进来，这个函数负责单位换算。
//
// 为什么不写死换算常数：本项目的估算口径是「CJK 1 token/字、其余 1/4 token/字」
//（`localModel/localContext.js`）。写死任一个都会让另一种内容偏 4 倍——按中文写死，
// 英文会话会早压 4 倍；按英文写死，中文会话永远不触发。所以用**本次消息自己**的
// 字符/token 比换算：分子与 K1 判定用的是同一个字符串，自比无偏。
//
// 估不出（空消息 / 非正阈值 / 0 token / 不可序列化）返回 0，调用方据此**不传**该选项，
// 于是回落到默认 2MB——即「拿不到窗口就保持旧行为」。
export function resolveContextBudgetBytes(messages, { thresholdTokens = 0 } = {}) {
  const limit = Number(thresholdTokens);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const list = Array.isArray(messages) ? messages : [];
  // 空数组也要挡住：`JSON.stringify([])` 是 `'[]'`（2 字符、估出 1 token），
  // 不挡会算出一个凭空的非零预算。
  if (!list.length) return 0;
  let serialized = '';
  try {
    serialized = JSON.stringify(list);
  } catch (error) {
    return 0;
  }
  if (!serialized) return 0;
  const tokens = estimateTextTokens(serialized);
  if (tokens <= 0) return 0;
  return Math.max(1, Math.floor((serialized.length / tokens) * limit));
}

function isToolMessage(item) {
  return !!item && item.role === 'tool';
}

// 某工具结果是否已被模型消费：其后存在 assistant 消息。
export function isToolResultConsumed(messages, index) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = index + 1; i < list.length; i += 1) {
    if (list[i] && list[i].role === 'assistant') return true;
  }
  return false;
}

// 占位文案（清除后替换 tool 消息 content）。
export function buildClearedPlaceholder(path) {
  return `[此前工具结果已存至 ${path || '<path>'}，可用 read_workspace_file 按 offset 取回]`;
}

// 候选：已消费 ∧ 不在最近 window 条工具结果内 ∧ 内容长度 > minChars。
export function collectClearableResults(messages, {
  recentWindow = RESULT_CLEARING_RECENT_WINDOW,
  minChars = RESULT_CLEARING_MIN_CHARS,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const toolIndices = [];
  list.forEach((item, index) => { if (isToolMessage(item)) toolIndices.push(index); });
  const windowSize = Math.max(0, Math.floor(Number(recentWindow) || 0));
  // 最近 windowSize 条工具结果受保护（工作台）。
  const protectedIndices = new Set(toolIndices.slice(Math.max(0, toolIndices.length - windowSize)));
  const candidates = [];
  for (const index of toolIndices) {
    if (protectedIndices.has(index)) continue;
    if (!isToolResultConsumed(list, index)) continue; // unseen 永不清除
    const length = String(list[index].content || '').length;
    if (length <= minChars) continue;
    candidates.push({ index, length });
  }
  return candidates;
}

// 驱逐计划：超预算时按「批内从大到小」（同大小按最旧优先）选到回预算内。
// 返回 { indices, bytesBefore, bytesAfter, cleared }。纯函数（占位符长度按近似值估算）。
export function planResultClearing(messages, {
  budgetBytes = RESULT_CLEARING_BUDGET_BYTES,
  recentWindow = RESULT_CLEARING_RECENT_WINDOW,
  minChars = RESULT_CLEARING_MIN_CHARS,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const bytesBefore = estimateContextBytes(list);
  if (!Number.isFinite(budgetBytes) || bytesBefore <= budgetBytes) {
    return { indices: [], bytesBefore, bytesAfter: bytesBefore, cleared: 0 };
  }
  const candidates = collectClearableResults(list, { recentWindow, minChars });
  candidates.sort((a, b) => (b.length - a.length) || (a.index - b.index));
  let bytes = bytesBefore;
  const indices = [];
  for (const candidate of candidates) {
    if (bytes <= budgetBytes) break;
    indices.push(candidate.index);
    bytes -= Math.max(0, candidate.length - PLACEHOLDER_ESTIMATE);
  }
  return { indices, bytesBefore, bytesAfter: Math.max(0, bytes), cleared: indices.length };
}

// 应用清除（异步，落盘由宿主注入）。落盘失败跳过该条保原文；只改 content，配对不变。
// persist(content, { toolCallId, toolName }) → { path } | null
// onCleared(path)：N3 readFileState 的失效钩子接口（本批只留接口，宿主可传）。
export async function applyResultClearing(messages, indices, { persist = null, onCleared = null } = {}) {
  const list = Array.isArray(messages) ? messages.map(item => ({ ...item })) : [];
  const cleared = [];
  if (typeof persist !== 'function') {
    return { messages: list, cleared }; // 无落盘能力 → 不清除（绝不写假指针）
  }
  for (const index of (Array.isArray(indices) ? indices : [])) {
    const message = list[index];
    if (!isToolMessage(message)) continue;
    const content = String(message.content || '');
    let stored = null;
    try {
      stored = await persist(content, { toolCallId: message.tool_call_id, toolName: '' });
    } catch (error) {
      stored = null;
    }
    if (!stored || !stored.path) continue; // 落盘失败 → 保原文
    message.content = buildClearedPlaceholder(stored.path);
    cleared.push({ index, path: stored.path });
    if (typeof onCleared === 'function') {
      try { onCleared(stored.path); } catch (error) { /* 钩子抛错不影响清除 */ }
    }
  }
  return { messages: list, cleared };
}

// 配对完整性自检：返回孤儿列表（tool 无对应 call / call 无对应 tool）。
// 清除只改 content，此函数在清除前后都应返回空。
export function findOrphanToolMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const callIds = new Set();
  const resultIds = new Set();
  list.forEach(item => {
    if (item && item.role === 'assistant' && Array.isArray(item.tool_calls)) {
      item.tool_calls.forEach(call => { if (call && call.id != null) callIds.add(String(call.id)); });
    }
    if (item && item.role === 'tool' && item.tool_call_id != null) resultIds.add(String(item.tool_call_id));
  });
  const orphans = [];
  list.forEach((item, index) => {
    if (item && item.role === 'tool' && !callIds.has(String(item.tool_call_id))) {
      orphans.push({ index, reason: 'tool-without-call', id: String(item.tool_call_id) });
    }
    if (item && item.role === 'assistant' && Array.isArray(item.tool_calls)) {
      item.tool_calls.forEach(call => {
        if (call && call.id != null && !resultIds.has(String(call.id))) {
          orphans.push({ index, reason: 'call-without-tool', id: String(call.id) });
        }
      });
    }
  });
  return orphans;
}
