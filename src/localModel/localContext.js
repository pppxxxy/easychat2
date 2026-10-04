// 本地模型的上下文预算：纯函数、无 RN 依赖，供 adapter 在推理前按 contextSize 裁剪历史。
//
// 为什么需要：本地模型的 n_ctx 是硬上限（默认 2048），而 buildRequestMessages 组的是
// 全量历史 + 系统提示 + 世界书注入。在线 API 动辄 128K 无感，本地聊到几十轮必然溢出，
// llama.cpp 会静默截断或报错，用户只看到「模型突然失忆/答非所问」。
// 这里按字符量粗估 token（够用即可），超限时从最旧的**非系统**消息开始丢弃，
// 系统提示（人设/世界书）与最近几轮始终保留，保住 llama 的前缀复用。

// 每个非文本模态部分折算的 token（图像/音频的粗略占用，仅用于预算，不需精确）。
const IMAGE_PART_TOKENS = 256;
const AUDIO_PART_TOKENS = 512;
// 单条消息的角色/分隔开销。
const PER_MESSAGE_OVERHEAD = 4;

const CJK_PATTERN = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

// 粗估一段文本的 token：CJK 约 1 token/字，其余按 4 字符/token。
export function estimateTextTokens(text) {
  const source = String(text || '');
  if (!source) return 0;
  let cjk = 0;
  for (const char of source) {
    if (CJK_PATTERN.test(char)) cjk += 1;
  }
  const other = source.length - cjk;
  return Math.ceil(cjk + other / 4);
}

function contentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  content.forEach(part => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'image_url') tokens += IMAGE_PART_TOKENS;
    else if (part.type === 'input_audio') tokens += AUDIO_PART_TOKENS;
    else if (typeof part.text === 'string') tokens += estimateTextTokens(part.text);
  });
  return tokens;
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  return PER_MESSAGE_OVERHEAD + contentTokens(message.content);
}

export function estimateMessagesTokens(messages) {
  return (Array.isArray(messages) ? messages : []).reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0
  );
}

// 按 contextSize 裁剪消息。规则：
// - 所有 system 消息恒保留（人设/世界书/格式约束丢了等于换了个人），
// - 其余消息从最新往回保留到预算用尽，最旧的先丢（保住 llama 前缀缓存），
// - 至少保留最后 minKeep 条非系统消息（通常是最后一条 user）。
// 返回 { messages, removedCount, estimatedTokens, budget }；未超限时原样返回 removedCount=0。
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
  const result = list.filter(message => (
    message && message.role === 'system' ? true : keptSet.has(message)
  ));
  const removedCount = list.length - result.length;
  return { messages: result, removedCount, estimatedTokens, budget };
}
