// 会话消息与记忆摘要存储领域：按会话分键的消息读写、摘要读写与边界推进、输入草稿、全库搜索。
// 从 src/storage/sessions.js 拆出（纯搬运，无行为变化）。消息与摘要互相依赖（写消息要读摘要、
// 推进摘要边界要读消息），故合并为同一模块，避免 ESM 循环。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  buildPreview,
  createEmptySession,
  sortSessions,
} from '../context/sessionLibrary.js';
import {
  CORRUPT_BACKUP_SUFFIX,
  backupCorruptValue,
  readJsonStatus,
} from './io.js';
import { markMediaWrite } from './mediaProtection.js';
import { tActive } from '../i18n/index.js';
import { mergeProactiveMessage } from '../proactive/proactiveInbox.js';
import {
  collectChatImageFiles,
  imageUrisFromMessages,
} from './sessionFiles.js';
import {
  bumpSessionSummaryRevision,
  deletedSessionIds,
  enqueueSessionMutation,
  getActiveSessionId,
  getSessions,
  isSessionSummaryRevisionCurrent,
  readSessionsStatus,
  requireSessions,
  saveSessionsInternal,
  sessionDraftKey,
  sessionMessagesKey,
  sessionSummariesKey,
} from './sessionCore.js';

export async function getMessagesBySessionStatus(sessionId) {
  const key = sessionMessagesKey(sessionId);
  const stored = await readJsonStatus(key);
  // 读失败、或结构不是数组（合法 JSON 但类型不对）都算损坏：先留副本，
  // 调用方据此提示“记录未删除”，并避免把它误当成空会话被后续写盘覆盖。
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return { status: 'corrupt', messages: [] };
  }
  return {
    status: stored.status === 'missing' ? 'missing' : 'ok',
    messages: Array.isArray(stored.value) ? stored.value.filter(item => item && !item.pending) : [],
  };
}

export async function getMessagesBySession(sessionId) {
  const { messages } = await getMessagesBySessionStatus(sessionId);
  return messages;
}

async function saveMessagesBySessionInternal(sessionId, messages, characterId = '', protectedUris = []) {
  const id = String(sessionId || '');
  if (deletedSessionIds.has(id)) return [];
  const persistable = (messages || []).filter(item => item && !item.pending);
  const imageUris = imageUrisFromMessages(persistable);
  imageUris.forEach(markMediaWrite);
  const previousStatus = await getMessagesBySessionStatus(sessionId);
  if (previousStatus.status === 'corrupt') {
    throw new Error(tActive('error.storage.chatLogReadFailed'));
  }
  const previousImages = previousStatus.status === 'corrupt'
    ? new Set()
    : imageUrisFromMessages(previousStatus.messages);
  const nextImages = imageUrisFromMessages(persistable);
  const removedImage = [...previousImages].some(uri => !nextImages.has(uri));
  await AsyncStorage.setItem(sessionMessagesKey(sessionId), JSON.stringify(persistable));
  if (removedImage && previousStatus.status !== 'corrupt') {
    await collectChatImageFiles(protectedUris);
  }
  const sessionsStatus = await readSessionsStatus();
  // 会话列表读不出时只保留消息体落盘，绝不用空/部分列表整表覆盖（否则会真丢会话）。
  if (sessionsStatus.status === 'corrupt') return persistable;
  const sessions = sessionsStatus.sessions;
  const existing = sessions.find(session => session.id === sessionId);
  if (existing) {
    const updated = sessions.map(session =>
      session.id === sessionId
        ? { ...session, preview: buildPreview(persistable), updatedAt: Date.now() }
        : session
    );
    await saveSessionsInternal(sortSessions(updated));
    return persistable;
  }
  // 会话条目缺失（历史版本的 startNewSession 会误删），但消息体还在：
  // 只要调用方能给出归属角色，就补回这一行，避免“消息还在、会话却永远看不见”。
  // 只补“仍然是当前会话”的那一个：删除会话会立刻把 activeSessionId 切到新会话，
  // 因此这条判断能挡住“用飞行中的写盘请求把已删除的会话复活”。
  const ownerId = String(characterId || '');
  if (persistable.length > 0 && ownerId) {
    const activeId = await getActiveSessionId();
    if (activeId === String(sessionId)) {
      const summaryStatus = await getSessionSummariesStatus(sessionId);
      if (summaryStatus.status === 'corrupt') {
        throw new Error(tActive('error.storage.summaryReadFailed'));
      }
      const timestamps = persistable
        .map(item => Number(item.timestamp))
        .filter(value => Number.isFinite(value));
      const restored = {
        ...createEmptySession(ownerId, sessions),
        id: String(sessionId),
        characterId: ownerId,
        preview: buildPreview(persistable),
        createdAt: timestamps.length ? Math.min(...timestamps) : Date.now(),
        updatedAt: timestamps.length ? Math.max(...timestamps) : Date.now(),
      };
      const boundary = String(
        summaryStatus.summaries.length > 0
          ? summaryStatus.summaries[summaryStatus.summaries.length - 1].boundary
          : ''
      );
      if (boundary && persistable.some(item => String(item.id || '') === boundary)) {
        restored.summarizedUpTo = boundary;
      }
      await saveSessionsInternal(sortSessions([...sessions, restored]));
    }
  }
  return persistable;
}

export function saveMessagesBySession(sessionId, messages, characterId = '', protectedUris = []) {
  return enqueueSessionMutation(() => saveMessagesBySessionInternal(
    sessionId,
    messages,
    characterId,
    protectedUris
  ));
}

// 把一条主动消息写入角色的单聊会话。
// - 指定 sessionTargetId（衔接某段历史对话）且该会话仍属于此角色：写入该会话；
// - 否则新建一段会话并写入（首次触发新建后由调用方回填绑定，之后固定复用）。
// 幂等：消息 id 由原生按 slotId+日期派生，重复消费不会产生重复消息。
// 返回 { sessionId, created }：created=true 表示本次新建了会话，调用方应把槽绑定到该 id。
export function appendProactiveMessage(characterId, incoming) {
  const ownerId = String(characterId || '');
  const source = incoming && typeof incoming === 'object' ? incoming : {};
  const messageId = String(source.id || '');
  const text = String(source.text || '').trim();
  const targetSessionId = String(source.sessionTargetId || '');
  return enqueueSessionMutation(async () => {
    if (!ownerId || !messageId || !text) return { sessionId: '', created: false };
    const sessionsStatus = await readSessionsStatus();
    if (sessionsStatus.status === 'corrupt') {
      throw new Error(tActive('error.storage.sessionListReadFailed'));
    }
    const sessions = sessionsStatus.sessions;
    let target = null;
    let created = false;
    if (targetSessionId) {
      target = sessions.find(session => (
        session.type !== 'group'
        && String(session.id || '') === targetSessionId
        && String(session.characterId || '') === ownerId
      )) || null;
    }
    // 未命中（未指定 / 指定会话已删）：先在角色已有单聊会话里找是否已含该消息 id，
    // 命中则复用它，使「同槽同日不重复」不依赖绑定写入成功（需求 1.5 幂等）。
    if (!target) {
      const owned = sessions.filter(
        session => session.type !== 'group' && String(session.characterId || '') === ownerId
      );
      for (const candidate of owned) {
        const candidateStatus = await getMessagesBySessionStatus(candidate.id);
        if (candidateStatus.status === 'corrupt') {
          throw new Error(tActive('error.storage.chatLogReadFailed'));
        }
        if (candidateStatus.messages.some(item => item && String(item.id || '') === messageId)) {
          target = candidate;
          break;
        }
      }
    }
    if (!target) {
      target = createEmptySession(ownerId, sessions);
      await saveSessionsInternal(sortSessions([...sessions, target]));
      created = true;
    }
    const status = await getMessagesBySessionStatus(target.id);
    if (status.status === 'corrupt') {
      throw new Error(tActive('error.storage.chatLogReadFailed'));
    }
    const timestamp = Number(source.createdAt) || Date.now();
    const next = mergeProactiveMessage(status.messages, {
      id: messageId,
      text,
      timestamp,
    });
    // 幂等命中（无新增）时不必写盘
    if (next.length === status.messages.length) return { sessionId: target.id, created };
    await saveMessagesBySessionInternal(target.id, next, ownerId);
    return { sessionId: target.id, created };
  });
}

// ---------- 记忆摘要 ----------

function normalizeSessionSummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    summary: String(source.summary || ''),
    keywords: (Array.isArray(source.keywords) ? source.keywords : [])
      .map(item => String(item || '').trim())
      .filter(Boolean),
    boundary: String(source.boundary || ''),
    createdAt: Number(source.createdAt) || 0,
  };
}

export async function getSessionSummariesStatus(sessionId) {
  const key = sessionSummariesKey(sessionId);
  const stored = await readJsonStatus(key);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return { status: 'corrupt', summaries: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', summaries: [] };
  const summaries = stored.value
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
  return { status: 'ok', summaries };
}

export async function getSessionSummaries(sessionId) {
  const { summaries } = await getSessionSummariesStatus(sessionId);
  return summaries;
}

async function saveSessionSummariesInternal(sessionId, list) {
  const normalized = (Array.isArray(list) ? list : [])
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
  await AsyncStorage.setItem(sessionSummariesKey(sessionId), JSON.stringify(normalized));
  return normalized;
}

async function setSessionSummarizedUpToInternal(sessionId, messageId, options = {}) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target) throw new Error(tActive('error.storage.sessionNotFound'));
  const nextBoundary = String(messageId || '');
  if (!nextBoundary) {
    if (!target.summarizedUpTo) return target;
    const updated = { ...target, summarizedUpTo: '' };
    await saveSessionsInternal(sessions.map(session => (
      session.id === sessionId ? updated : session
    )));
    return updated;
  }
  const messages = await getMessagesBySession(sessionId);
  const newIndex = messages.findIndex(item => item.id === nextBoundary);
  if (newIndex < 0) throw new Error(tActive('error.storage.summaryBoundaryInvalid'));
  const oldIndex = messages.findIndex(item => item.id === target.summarizedUpTo);
  if (
    options.allowBackward !== true
    && target.summarizedUpTo
    && oldIndex >= 0
    && newIndex <= oldIndex
  ) {
    return target;
  }
  const updated = { ...target, summarizedUpTo: nextBoundary };
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

export function setSessionSummarizedUpTo(sessionId, messageId, expectedRevision = null) {
  return enqueueSessionMutation(() => {
    if (expectedRevision !== null && !isSessionSummaryRevisionCurrent(sessionId, expectedRevision)) {
      throw new Error(tActive('error.storage.summaryReset'));
    }
    return setSessionSummarizedUpToInternal(sessionId, messageId);
  });
}

export function resetSessionSummaries(sessionId) {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(async () => {
    const sessions = await requireSessions();
    const target = sessions.find(session => session.id === sessionId);
    if (!target) throw new Error(tActive('error.storage.sessionNotFound'));
    const key = sessionSummariesKey(sessionId);
    const cleared = sessions.map(session => (
      session.id === sessionId ? { ...session, summarizedUpTo: '' } : session
    ));
    await saveSessionsInternal(cleared);
    try {
      await AsyncStorage.removeItem(key);
    } catch (error) {
      await saveSessionsInternal(sessions).catch(restoreError => {
        if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[storage] summary boundary restore failed', restoreError);
      });
      throw error;
    }
    return cleared;
  });
}

export function invalidateSessionSummaries(sessionId, keepSummaries = [], nextBoundary = '') {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(async () => {
    const sessions = await requireSessions();
    const target = sessions.find(session => session.id === sessionId);
    if (!target) throw new Error(tActive('error.storage.sessionNotFound'));
    const previousStatus = await getSessionSummariesStatus(sessionId);
    if (previousStatus.status === 'corrupt') {
      throw new Error(tActive('error.storage.summaryReadFailed'));
    }
    const kept = (Array.isArray(keepSummaries) ? keepSummaries : [])
      .map(normalizeSessionSummary)
      .filter(item => item.summary.trim().length > 0);
    await saveSessionSummariesInternal(sessionId, kept);
    try {
      await setSessionSummarizedUpToInternal(sessionId, nextBoundary, { allowBackward: true });
    } catch (error) {
      await saveSessionSummariesInternal(sessionId, previousStatus.summaries).catch(restoreError => {
        if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[storage] summary rollback failed', restoreError);
      });
      throw error;
    }
    return kept;
  });
}

export function appendSessionSummary(sessionId, entry, expectedRevision = null) {
  const task = enqueueSessionMutation(async () => {
    if (expectedRevision !== null && !isSessionSummaryRevisionCurrent(sessionId, expectedRevision)) {
      throw new Error(tActive('error.storage.summaryReset'));
    }
    const { status, summaries } = await getSessionSummariesStatus(sessionId);
    if (status === 'corrupt') throw new Error(tActive('error.storage.summaryReadFailed'));
    const normalizedEntry = normalizeSessionSummary(entry);
    const next = [...summaries, normalizedEntry];
    await saveSessionSummariesInternal(sessionId, next);
    try {
      await setSessionSummarizedUpToInternal(sessionId, normalizedEntry.boundary);
    } catch (error) {
      if (
        expectedRevision === null
        || isSessionSummaryRevisionCurrent(sessionId, expectedRevision)
      ) {
        await saveSessionSummariesInternal(sessionId, summaries).catch(() => {});
      }
      throw error;
    }
    return next;
  });
  return task;
}

// ---------- 输入草稿 ----------

// 草稿读写不经过会话变更队列：它是高频、独立的旁路数据，进队列反而会让
// 每次输入都排在一次消息写盘之后。按会话分键天然互相隔离。
export async function getSessionDraft(sessionId) {
  const id = String(sessionId || '');
  if (!id) return '';
  try {
    const raw = await AsyncStorage.getItem(sessionDraftKey(id));
    return typeof raw === 'string' ? raw : '';
  } catch (error) {
    return '';
  }
}

export async function saveSessionDraft(sessionId, text) {
  const id = String(sessionId || '');
  if (!id) return '';
  const value = String(text || '');
  if (!value) {
    await AsyncStorage.removeItem(sessionDraftKey(id)).catch(() => {});
    return '';
  }
  await AsyncStorage.setItem(sessionDraftKey(id), value).catch(() => {});
  return value;
}

export async function clearSessionDraft(sessionId) {
  return saveSessionDraft(sessionId, '');
}

// ---------- 全库搜索 ----------

export async function searchMessages(keyword, options = {}) {
  const signal = options && options.signal ? options.signal : null;
  const throwIfAborted = () => {
    if (signal && signal.aborted) {
      const error = new Error('搜索已取消');
      error.name = 'AbortError';
      throw error;
    }
  };
  throwIfAborted();
  const query = String(keyword || '').trim();
  if (!query) return [];
  const sessions = await getSessions();
  throwIfAborted();
  if (sessions.length === 0) return [];
  const needle = query.toLowerCase();
  const results = [];
  for (let offset = 0; offset < sessions.length; offset += 8) {
    throwIfAborted();
    const batch = sessions.slice(offset, offset + 8);
    const states = await Promise.all(batch.map(async session => ({
      session,
      state: await getMessagesBySessionStatus(session.id).catch(() => ({
        status: 'corrupt',
        messages: [],
      })),
    })));
    throwIfAborted();
    for (const { session, state } of states) {
      if (!state || state.status !== 'ok') continue;
      for (const message of state.messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const text = String(
          message.text
          || (message.image && (message.image.stickerName || message.image.name))
          || ''
        );
        if (!text || !text.toLowerCase().includes(needle)) continue;
        results.push({
          sessionId: session.id,
          sessionType: session.type || 'single',
          sessionName: String(session.name || ''),
          characterId: session.characterId,
          messageId: message.id,
          role: message.role,
          text,
          updatedAt: session.updatedAt || 0,
        });
      }
    }
  }
  results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return results;
}

export { CORRUPT_BACKUP_SUFFIX };
