// 记忆溯源：把向量索引里的每条记忆（对话片段）与它的来源会话 / 来源消息对应起来。
//
// 数据本身早就在索引里了——chunkMessages 写分段时就带了 sessionId 与 messageId，
// 只是从来没有界面把它摊开给用户看。本模块只做纯逻辑（分组 / 证据链 / 来源解析），
// 零 RN 依赖，Node 可直测；读消息体、渲染都在上层。
//
// 一条记忆的来源有两种：
// - 普通记忆：从某条消息切出来的分片，来源 = (sessionId, messageId)；
// - AI 合并记忆（origin === 'merged'）：合并前的两条记忆已被删除，来源只能靠
//   写入时留存的 mergedFrom 快照，否则证据链会随合并断掉。

// 证据链的上下文半径：源消息前后各取几条做上下文，让人看得出「当时在聊什么」。
export const MEMORY_CONTEXT_RADIUS = 2;

// 证据链最多展示多少条（前后上下文 + 源消息），防止一次渲染上百条消息。
export const MAX_EVIDENCE_MESSAGES = 12;

// 记忆的唯一键：与 storage/vector.js 的 vectorSegmentKey 同构（sessionId + id）。
// 这里刻意不 import 存储层，保持本模块纯函数、可单测。
export function memoryKey(item) {
  return `${String((item && item.sessionId) || '')}\u0000${String((item && item.id) || '')}`;
}

export function isMemoryItem(item) {
  return !!item
    && !!String(item.id || '')
    && typeof item.text === 'string'
    && item.text.trim().length > 0;
}

export function listMemories(index) {
  return (Array.isArray(index) ? index : []).filter(isMemoryItem);
}

// 按会话分组。组间顺序按「该组最新一条记忆的时间」降序（最近聊过的排前面）；
// 组内按时间升序（旧 → 新），让冲突的先后顺序一眼可见——「先记住喜欢猫、
// 后来记住讨厌猫」在升序下就是自然阅读顺序。
export function groupMemoriesBySession(memories, options = {}) {
  const nameOf = typeof options.sessionName === 'function' ? options.sessionName : () => '';
  const groups = new Map();
  listMemories(memories).forEach(item => {
    const sessionId = String(item.sessionId || '');
    if (!groups.has(sessionId)) groups.set(sessionId, []);
    groups.get(sessionId).push(item);
  });
  return [...groups.entries()]
    .map(([sessionId, items]) => {
      const sorted = [...items].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
      return {
        sessionId,
        name: String(nameOf(sessionId) || '').trim(),
        items: sorted,
        latestAt: sorted.reduce((max, item) => Math.max(max, Number(item.at) || 0), 0),
      };
    })
    .sort((a, b) => b.latestAt - a.latestAt);
}

// 一条记忆的来源描述（结构化，不拼文案——文案交给界面走 t()）。
// 普通记忆 = 它切出来的那条消息；合并记忆 = 合并前的若干条快照。
export function memorySources(memory) {
  const item = memory && typeof memory === 'object' ? memory : null;
  if (!item) return [];
  const merged = Array.isArray(item.mergedFrom) ? item.mergedFrom : [];
  if (item.origin === 'merged' && merged.length > 0) {
    return merged
      .filter(entry => entry && entry.id)
      .map(entry => ({
        sessionId: String(entry.sessionId || ''),
        messageId: String(entry.messageId || ''),
        text: String(entry.text || ''),
        at: Number(entry.at) || 0,
        merged: true,
      }));
  }
  return [{
    sessionId: String(item.sessionId || ''),
    messageId: String(item.messageId || ''),
    text: String(item.text || ''),
    at: Number(item.at) || 0,
    merged: false,
  }];
}

// 证据链：记忆是从哪条消息切出来的，加上前后各 radius 条消息作为上下文。
// 源消息可能已经不在（消息被删 / 重生成，而索引尚未对账）——如实返回 found:false，
// 由界面显示「原始消息已不在」，绝不伪造一条凑数。
export function buildEvidenceChain({ memory, messages, radius = MEMORY_CONTEXT_RADIUS } = {}) {
  const target = memory && typeof memory === 'object' ? memory : null;
  const list = (Array.isArray(messages) ? messages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .map(item => ({
      id: String(item.id || ''),
      role: String(item.role || ''),
      text: String(item.text || ''),
      at: Number(item.timestamp) || 0,
      speakerName: String(item.speakerName || ''),
    }));
  const messageId = String((target && target.messageId) || '');
  const index = messageId ? list.findIndex(item => item.id === messageId) : -1;
  if (index < 0) {
    return { found: false, messageId, source: null, before: [], after: [], truncated: false };
  }
  // 半径上限由总条数上限反推：前后各 span 条 + 源消息 1 条 ≤ MAX_EVIDENCE_MESSAGES。
  const maxSpan = Math.max(0, Math.floor((MAX_EVIDENCE_MESSAGES - 1) / 2));
  const requested = Number.isFinite(radius) && radius >= 0
    ? Math.trunc(radius)
    : MEMORY_CONTEXT_RADIUS;
  const span = Math.min(requested, maxSpan);
  const before = list.slice(Math.max(0, index - span), index);
  const after = list.slice(index + 1, index + 1 + span);
  return {
    found: true,
    messageId,
    source: list[index],
    before,
    after,
    truncated: requested > span,
  };
}

// 索引里出现过的会话 id 集合（去重、保序），供上层一次性把会话名读出来。
export function sessionIdsOf(memories) {
  const seen = new Set();
  const ids = [];
  listMemories(memories).forEach(item => {
    const sessionId = String(item.sessionId || '');
    if (!sessionId || seen.has(sessionId)) return;
    seen.add(sessionId);
    ids.push(sessionId);
  });
  return ids;
}
