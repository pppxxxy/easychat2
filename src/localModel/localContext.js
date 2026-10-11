// 本地模型的上下文预算：纯函数、无 RN 依赖，供 adapter 在推理前按 contextSize 裁剪历史。
//
// 为什么需要：本地模型的 n_ctx 是硬上限（默认 2048），而 buildRequestMessages 组的是
// 全量历史 + 系统提示 + 世界书注入。在线 API 动辄 128K 无感，本地聊到几十轮必然溢出，
// llama.cpp 会静默截断或报错，用户只看到「模型突然失忆/答非所问」。
// 这里按字符量粗估 token（够用即可），超限时从最旧的**非系统**消息开始丢弃，
// 系统提示（人设/世界书）与最近几轮始终保留，保住 llama 的前缀复用。
//
// 与 resultClearing 的关系：配对完整性的判据**共用** findOrphanToolMessages
//（agent/resultClearing.js）——裁剪与结果清除是同一个不变量的两个执行者，
// 判据分两份就会出现「一处修了另一处仍拆配对」。
import { findOrphanToolMessages } from '../agent/resultClearing.js';
import { estimateMessageTokens, estimateMessagesTokens } from './tokenEstimate.js';

// 兼容出口：估算器的实现在 tokenEstimate.js（叶子模块，供 resultClearing 共用而不成环）。
// 既有调用点（sessionStats / contextUsage / sessionCompaction）继续从这里取。
export { estimateMessageTokens, estimateMessagesTokens, estimateTextTokens } from './tokenEstimate.js';

// 按 contextSize 裁剪消息。规则：
// - 所有 system 消息恒保留（人设/世界书/格式约束丢了等于换了个人），
// - 其余消息从最新往回保留到预算用尽，最旧的先丢（保住 llama 前缀缓存），
// - 至少保留最后 minKeep 条非系统消息（通常是最后一条 user），
// - **裁剪后必须仍是合法的 toolUse↔toolResult 配对**（见下）。
// 返回 { messages, removedCount, estimatedTokens, budget }；未超限时原样返回 removedCount=0。

// 配对修正（P1，2026-10-11）：把「丢了 assistant(tool_calls) 却留下 tool 结果」或
// 「留下 assistant(tool_calls) 却丢了它的部分结果」修掉。
//
// 为什么必须有：只按预算丢最旧的非 system 消息**完全不看配对**。OpenAI 兼容端点对
// 孤儿的 tool 结果（没有对应 tool_calls）与缺结果的 tool_calls 直接 400——在线路径
// （network/api.js 的 trimOnlineMessages）与本地路径（localModel/adapter.js）共用这条
// 裁剪，所以两边都会炸。而 tool 消息在纯文本体积上很小，最容易被「先丢最旧的」切在
// 一组配对中间。
//
// 判据复用 agent/resultClearing.js 的 findOrphanToolMessages（本就是为这件事写的，
// 此前全仓零调用），只做**丢弃**不做补回：补回要重新申请预算，会把刚裁掉的上下文
// 又拉回来，且被补回的那条本来就超预算。
export function repairToolPairing(messages) {
  let list = Array.isArray(messages) ? messages : [];
  // 迭代到没有孤儿为止：丢一条 assistant(tool_calls) 可能让它的 tool 结果变成孤儿，
  // 再丢那些 tool 结果又可能让更早的 assistant 缺结果。每轮至少少一条，必然收敛。
  for (let guard = 0; guard < list.length + 1; guard += 1) {
    const orphans = findOrphanToolMessages(list);
    if (orphans.length === 0) return list;
    const drop = new Set(orphans.map(orphan => orphan.index));
    list = list.filter((unused, index) => !drop.has(index));
  }
  return list;
}

export function trimMessagesToContext(messages, {
  contextSize = 0,
  reserveOutputTokens = 512,
  minKeep = 1,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const ctx = Math.floor(Number(contextSize) || 0);
  const estimatedTokens = estimateMessagesTokens(list);
  if (ctx <= 0) return { messages: list, removedCount: 0, estimatedTokens, budget: 0 };
  const budget = Math.max(64, ctx - Math.max(0, Math.floor(Number(reserveOutputTokens) || 0)));
  if (estimatedTokens <= budget) {
    return { messages: list, removedCount: 0, estimatedTokens, budget };
  }

  const systemMessages = list.filter(message => message && message.role === 'system');
  const otherMessages = list.filter(message => !message || message.role !== 'system');
  const systemTokens = estimateMessagesTokens(systemMessages);
  const keepMinimum = Math.max(0, Math.floor(Number(minKeep) || 0));

  // 从最新往回收集，直到再加一条就超预算。
  const keptReversed = [];
  let used = systemTokens;
  for (let index = otherMessages.length - 1; index >= 0; index -= 1) {
    const message = otherMessages[index];
    const cost = estimateMessageTokens(message);
    const mustKeep = keptReversed.length < keepMinimum;
    if (!mustKeep && used + cost > budget) break;
    used += cost;
    keptReversed.push(message);
  }
  const kept = keptReversed.reverse();
  // 保持原始顺序：system 在前，其余按原相对顺序。
  const keptSet = new Set(kept);
  const selected = list.filter(message => (
    message && message.role === 'system' ? true : keptSet.has(message)
  ));
  // 配对修正：裁剪不得拆散 toolUse↔toolResult（否则端点 400）。
  const result = repairToolPairing(selected);
  const removedCount = list.length - result.length;
  return { messages: result, removedCount, estimatedTokens, budget };
}
