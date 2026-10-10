// 流式草稿：生成中把**已收到的部分回复**增量落盘，供 App 被杀/断线后恢复（Z 系采纳 #8）。
//
// 现状：流式期间回复只存在于内存（pending 消息），而读取侧会 filter 掉 pending——
// 一旦进程在生成中途被杀（移动端很常见），这段已经产出的文字**直接丢失**，用户只能重发。
//
// 做法：生成中按节流把「部分正文 + 推理 + 目标消息 id」写进一个按会话分键的草稿；
// 正常结束/取消/失败时清掉。下次加载该会话时若草稿还在（= 上次非正常中断），把它作为
// 一条「已恢复」消息并入时间线，用户看到的是半截回复而不是空白。
//
// 节流口径：正文增长超过 minDelta 立即写；否则至少间隔 minIntervalMs 才写（避免
// 逐 token 落盘）。storage 可注入（纯 Node 测试用假 storage）。
//
// 与 storage/diagnostics.js 同约束：顶层不 import 原生模块，用惰性 require。

export const STREAM_DRAFT_PREFIX = '@easychat2_stream_draft';
export const STREAM_DRAFT_MIN_INTERVAL_MS = 1500;
export const STREAM_DRAFT_MIN_DELTA = 40;
export const STREAM_DRAFT_MAX_CHARS = 200000;

export function streamDraftKey(sessionId) {
  return `${STREAM_DRAFT_PREFIX}::${String(sessionId || '')}`;
}

let asyncStorage;
let asyncStorageLoaded = false;
function getStorage(injected) {
  if (injected) return injected;
  if (!asyncStorageLoaded) {
    asyncStorageLoaded = true;
    try {
      asyncStorage = require('@react-native-async-storage/async-storage').default;
    } catch (error) {
      asyncStorage = null;
    }
  }
  return asyncStorage;
}

// 纯函数：草稿收敛（字段白名单 + 长度上限）。坏输入 → null。
export function normalizeStreamDraft(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const messageId = String(source.messageId || '');
  const text = String(source.text === undefined || source.text === null ? '' : source.text);
  if (!messageId || !text.trim()) return null;
  return {
    messageId,
    text: text.length > STREAM_DRAFT_MAX_CHARS ? text.slice(0, STREAM_DRAFT_MAX_CHARS) : text,
    reasoning: String(source.reasoning === undefined || source.reasoning === null ? '' : source.reasoning),
    at: Math.max(0, Math.floor(Number(source.at)) || 0),
  };
}

// 纯函数：是否该写这一版（节流）。正文没增长 → 不写；增长够多 → 立即写；否则看间隔。
export function shouldWriteStreamDraft({
  lastAt = 0,
  now = 0,
  lastLen = 0,
  nextLen = 0,
  minIntervalMs = STREAM_DRAFT_MIN_INTERVAL_MS,
  minDelta = STREAM_DRAFT_MIN_DELTA,
} = {}) {
  const len = Number(nextLen) || 0;
  const prevLen = Number(lastLen) || 0;
  if (len <= prevLen) return false;
  if (len - prevLen >= (Number(minDelta) || STREAM_DRAFT_MIN_DELTA)) return true;
  return (Number(now) || 0) - (Number(lastAt) || 0) >= (Number(minIntervalMs) || STREAM_DRAFT_MIN_INTERVAL_MS);
}

export async function saveStreamDraft(sessionId, draft, { storage = null } = {}) {
  const id = String(sessionId || '');
  const normalized = normalizeStreamDraft(draft);
  if (!id || !normalized) return false;
  const store = getStorage(storage);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    await store.setItem(streamDraftKey(id), JSON.stringify(normalized));
    return true;
  } catch (error) {
    return false;
  }
}

export async function readStreamDraft(sessionId, { storage = null } = {}) {
  const id = String(sessionId || '');
  if (!id) return null;
  const store = getStorage(storage);
  if (!store || typeof store.getItem !== 'function') return null;
  try {
    const raw = await store.getItem(streamDraftKey(id));
    if (!raw) return null;
    return normalizeStreamDraft(JSON.parse(raw));
  } catch (error) {
    return null;
  }
}

export async function clearStreamDraft(sessionId, { storage = null } = {}) {
  const id = String(sessionId || '');
  if (!id) return false;
  const store = getStorage(storage);
  if (!store || typeof store.removeItem !== 'function') return false;
  try {
    await store.removeItem(streamDraftKey(id));
    return true;
  } catch (error) {
    return false;
  }
}
