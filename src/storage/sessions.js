// 会话 / 消息 / 记忆摘要 / 聊天图片清理存储领域。从 src/storage.js 原样外提（无行为变化）。
// 会话列表单键 + 消息按会话分键 + 摘要按会话分键；聊天图片清理随会话消息一起（会话删除会触发它）。
// 注：saveCharacterState（跨领域编排）与头像/表情/孤儿图片清理留在 storage.js barrel；
// reconcileVectorIndexes 因需会话列表读取而随本模块（sessions → vector 单向依赖）。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

import {
  getMediaWriteRevision,
  getNextRecentMediaExpiry,
  isMediaWriteRevisionCurrent,
  isRecentMediaUri,
  markMediaWrite,
} from '../mediaProtection.js';
import {
  buildClonedSession,
  buildPreview,
  buildRestoredSession,
  collectMessageSpeakers,
  createEmptySession,
  createGroupSession as buildGroupSession,
  isMessageGroup,
  normalizeSession,
  regenerateMessageIds,
  sortSessions,
} from '../context/sessionLibrary.js';
import { shouldIndexSession } from '../vectorMemory/scope.js';
import { DEFAULT_CHARACTER, getCharacterLibrary } from './characters.js';
import {
  VECTOR_INDEX_PREFIX,
  readVectorIndexStatus,
  removeVectorIndexForSession,
  removeVectorIndexForSessions,
  updateVectorIndex,
} from './vector.js';
import {
  CORRUPT_BACKUP_SUFFIX,
  backupCorruptValue,
  readJson,
  readJsonStatus,
  readLargeAsyncStorageValue,
} from './io.js';

export const SESSIONS_KEY = '@easychat2_sessions';
const SESSION_ROLLBACK_BACKUP_KEY = '@easychat2_sessions__rollback_backup';
const SESSION_SUMMARIES_PREFIX = '@easychat2_session_summaries';
// 每个会话的输入框草稿：按会话分键，避免把可能很大的集合塞进单键。
const SESSION_DRAFT_PREFIX = '@easychat2_session_draft';
const ACTIVE_SESSION_KEY = '@easychat2_active_session';
const MESSAGES_KEY_PREFIX = '@easychat2_messages';
const LEGACY_MESSAGES_KEY = '@easychat2_messages';

let sessionMutationQueue = Promise.resolve();
const deletedSessionIds = new Set();
const sessionSummaryRevisions = new Map();
const protectedChatImageUris = new Set();

function enqueueSessionMutation(task) {
  const next = sessionMutationQueue.then(task, task);
  sessionMutationQueue = next.catch(() => {});
  return next;
}

// 等待当前挂起的会话写入全部落定。迁移（migrateLegacyMessages）也在 sessionMutationQueue
// 里，但会话列表读取（getSessions）不经过队列；外部刷新若在迁移写盘中途读取，会拿到中间态。
// 刷新前 await 这个钩子即可保证读到迁移完成后的最终状态。
export function whenSessionMutationsSettled() {
  return sessionMutationQueue.catch(() => {});
}

export function messagesKey(characterId) {
  return `${MESSAGES_KEY_PREFIX}::${characterId || DEFAULT_CHARACTER.id}`;
}

function sessionMessagesKey(sessionId) {
  return `${MESSAGES_KEY_PREFIX}::${sessionId}`;
}

function legacySessionId(characterId) {
  return `legacy-${characterId}`;
}

export async function reconcileVectorIndexes() {
  const sessionsStatus = await readSessionsStatus();
  if (sessionsStatus.status === 'corrupt') {
    throw new Error('会话列表读取失败，请稍后重试');
  }
  const sessionMap = new Map(
    sessionsStatus.sessions.map(session => [String(session.id || ''), session])
  );
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    throw new Error('向量索引列表读取失败，请稍后重试');
  }
  const prefix = `${VECTOR_INDEX_PREFIX}::`;
  const vectorKeys = (Array.isArray(keys) ? keys : [])
    .filter(key => typeof key === 'string' && key.startsWith(prefix));
  const report = {
    scannedKeys: vectorKeys.length,
    removed: 0,
    legacyRetained: 0,
    failedKeys: [],
  };
  for (const key of vectorKeys) {
    const characterId = key.slice(prefix.length);
    if (!characterId) continue;
    const status = await readVectorIndexStatus(characterId);
    if (status.status === 'missing') continue;
    if (status.status === 'corrupt') {
      report.failedKeys.push(key);
      continue;
    }
    report.legacyRetained += status.index.filter(item => !String(item.sessionId || '')).length;
    try {
      const result = await updateVectorIndex(characterId, current => {
        const next = current.filter(item => {
          const sessionId = String(item.sessionId || '');
          if (!sessionId) return true;
          const session = sessionMap.get(sessionId);
          return shouldIndexSession(session);
        });
        if (next.length === current.length) return undefined;
        return next.length > 0 ? next : null;
      });
      report.removed += Math.max(0, status.index.length - result.length);
    } catch (error) {
      report.failedKeys.push(key);
      if (__DEV__) console.warn('[vector] reconciliation failed', error);
    }
  }
  return report;
}

function ensureUniqueSessionIds(list) {
  // 消息体按会话 id 存键。若把重复 id 重命名成一个新 id，新 id 下没有消息，
  // 等于凭空孤立一份聊天记录；而消息键仍挂在原 id 上。所以这里保留首次出现的条目，
  // 丢弃重复条目，保证 id 与消息键始终一一对应。
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const id = String(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

// 会话列表的读取状态：损坏时先备份原始值再当作空列表，避免调用方
// 用空列表把“暂时读不出”的真实数据整表覆盖掉（Android cursor window 等）。
async function readRollbackBackup() {
  try {
    const raw = await AsyncStorage.getItem(SESSION_ROLLBACK_BACKUP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

export async function readSessionsStatus() {
  const stored = await readJsonStatus(SESSIONS_KEY);
  const backup = await readRollbackBackup();
  if (stored.status === 'missing' || stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    if (stored.status === 'corrupt') await backupCorruptValue(SESSIONS_KEY);
    if (backup.length > 0) {
      // 上次回滚写盘再次失败时留了备份，启动时用它恢复，避免会话列表永久丢失。
      await saveSessionsInternal(backup);
      await AsyncStorage.removeItem(SESSION_ROLLBACK_BACKUP_KEY).catch(() => {});
      return { status: 'ok', sessions: ensureUniqueSessionIds(backup.map(normalizeSession)) };
    }
    return stored.status === 'missing'
      ? { status: 'missing', sessions: [] }
      : { status: 'corrupt', sessions: [] };
  }
  if (backup.length > 0) {
    // 主列表可读，说明之前要么回滚成功、要么已不需要备份，清掉陈旧副本。
    await AsyncStorage.removeItem(SESSION_ROLLBACK_BACKUP_KEY).catch(() => {});
  }
  return {
    status: 'ok',
    sessions: ensureUniqueSessionIds(stored.value.map(normalizeSession)),
  };
}

// 只读路径：损坏时返回空列表（UI 容忍空列表，且不会写回）。
export async function getSessions() {
  const { sessions } = await readSessionsStatus();
  return sessions;
}

// 读改写路径：列表损坏时必须中止，否则会把 SESSIONS_KEY 覆盖成空/单条。
async function requireSessions() {
  const { status, sessions } = await readSessionsStatus();
  if (status === 'corrupt') {
    throw new Error('会话记录读取失败，请稍后重试');
  }
  return sessions;
}

async function saveSessionsInternal(sessions) {
  const list = ensureUniqueSessionIds(
    (Array.isArray(sessions) ? sessions : []).map(normalizeSession)
  );
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  return list;
}

export function saveSessions(sessions) {
  return enqueueSessionMutation(async () => {
    const status = await readSessionsStatus();
    if (status.status === 'corrupt') {
      throw new Error('会话记录读取失败，请稍后重试');
    }
    return saveSessionsInternal(sessions);
  });
}

export async function getActiveSessionId() {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
    return raw ? String(JSON.parse(raw)) : '';
  } catch (error) {
    return '';
  }
}

async function setActiveSessionIdInternal(id) {
  await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(String(id || '')));
}

export function setActiveSessionId(id) {
  return enqueueSessionMutation(() => setActiveSessionIdInternal(id));
}

export function setProtectedChatImageUris(uris) {
  protectedChatImageUris.clear();
  (Array.isArray(uris) ? uris : []).forEach(uri => {
    const value = String(uri || '');
    if (value.includes('/chat-images/')) protectedChatImageUris.add(value);
  });
}

function imageUrisFromMessages(messages) {
  const result = new Set();
  (Array.isArray(messages) ? messages : []).forEach(item => {
    const uri = String(item && item.image && item.image.uri || '');
    if (uri.includes('/chat-images/')) result.add(uri);
  });
  return result;
}

async function collectChatImageFilesInternal(protectedUris = []) {
  const revision = getMediaWriteRevision();
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    return false;
  }
  const messageKeys = keys.filter(key => (
    key === MESSAGES_KEY_PREFIX || String(key).startsWith(`${MESSAGES_KEY_PREFIX}::`)
  ));
  const referenced = new Set([
    ...protectedChatImageUris,
    ...(Array.isArray(protectedUris) ? protectedUris : [])
      .map(uri => String(uri || ''))
      .filter(uri => uri.includes('/chat-images/')),
  ]);
  for (const key of messageKeys) {
    if (String(key).endsWith(CORRUPT_BACKUP_SUFFIX)) return false;
    let raw = null;
    try {
      raw = await AsyncStorage.getItem(key);
    } catch (error) {
      raw = await readLargeAsyncStorageValue(key);
    }
    if (raw === null || raw === undefined) return false;
    if (!raw) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return false;
    }
    if (!Array.isArray(parsed)) return false;
    imageUrisFromMessages(parsed).forEach(uri => referenced.add(uri));
  }
  const directory = `${FileSystem.documentDirectory || ''}chat-images/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  let skippedRecent = false;
  for (const entry of entries) {
    if (!isMediaWriteRevisionCurrent(revision)) return false;
    const uri = `${directory}${entry}`;
    if (isRecentMediaUri(uri)) {
      skippedRecent = true;
      continue;
    }
    if (referenced.has(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  if (skippedRecent) scheduleMediaCollectRetry();
  return true;
}

let mediaCollectRetryTimer = null;

function scheduleMediaCollectRetry() {
  const expiry = getNextRecentMediaExpiry();
  if (!expiry) return;
  const delay = Math.max(1000, expiry - Date.now() + 50);
  if (mediaCollectRetryTimer) clearTimeout(mediaCollectRetryTimer);
  mediaCollectRetryTimer = setTimeout(() => {
    mediaCollectRetryTimer = null;
    collectChatImageFiles().catch(() => {});
  }, delay);
}

// 回收会读取全部会话消息并删文件；与新媒体写入或另一轮回收并发时容易交错。
// 统一排进同一 promise 队列，保证任意时刻只有一次回收在跑。
let mediaCollectQueue = Promise.resolve();

export function collectChatImageFiles(protectedUris = []) {
  const run = mediaCollectQueue
    .catch(() => {})
    .then(() => collectChatImageFilesInternal(protectedUris));
  mediaCollectQueue = run.catch(() => {});
  return run;
}

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
    throw new Error('聊天记录读取失败，请稍后重试');
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
        throw new Error('记忆摘要读取失败，请稍后重试');
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

async function setSessionSummarizedUpToInternal(sessionId, messageId, options = {}) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target) throw new Error('会话不存在');
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
  if (newIndex < 0) throw new Error('总结边界无效');
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
      throw new Error('会话摘要已重置');
    }
    return setSessionSummarizedUpToInternal(sessionId, messageId);
  });
}

function sessionSummariesKey(sessionId) {
  return `${SESSION_SUMMARIES_PREFIX}::${String(sessionId || '')}`;
}

function sessionDraftKey(sessionId) {
  return `${SESSION_DRAFT_PREFIX}::${String(sessionId || '')}`;
}

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

function bumpSessionSummaryRevision(sessionId) {
  const id = String(sessionId || '');
  const next = (sessionSummaryRevisions.get(id) || 0) + 1;
  sessionSummaryRevisions.set(id, next);
  return next;
}

export function getSessionSummaryRevision(sessionId) {
  return sessionSummaryRevisions.get(String(sessionId || '')) || 0;
}

export function isSessionSummaryRevisionCurrent(sessionId, revision) {
  return getSessionSummaryRevision(sessionId) === Number(revision || 0);
}

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

export function resetSessionSummaries(sessionId) {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(async () => {
    const sessions = await requireSessions();
    const target = sessions.find(session => session.id === sessionId);
    if (!target) throw new Error('会话不存在');
    const key = sessionSummariesKey(sessionId);
    const cleared = sessions.map(session => (
      session.id === sessionId ? { ...session, summarizedUpTo: '' } : session
    ));
    await saveSessionsInternal(cleared);
    try {
      await AsyncStorage.removeItem(key);
    } catch (error) {
      await saveSessionsInternal(sessions).catch(restoreError => {
        if (__DEV__) console.warn('[storage] summary boundary restore failed', restoreError);
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
    if (!target) throw new Error('会话不存在');
    const previousStatus = await getSessionSummariesStatus(sessionId);
    if (previousStatus.status === 'corrupt') {
      throw new Error('记忆摘要读取失败，请稍后重试');
    }
    const kept = (Array.isArray(keepSummaries) ? keepSummaries : [])
      .map(normalizeSessionSummary)
      .filter(item => item.summary.trim().length > 0);
    await saveSessionSummariesInternal(sessionId, kept);
    try {
      await setSessionSummarizedUpToInternal(sessionId, nextBoundary, { allowBackward: true });
    } catch (error) {
      await saveSessionSummariesInternal(sessionId, previousStatus.summaries).catch(restoreError => {
        if (__DEV__) console.warn('[storage] summary rollback failed', restoreError);
      });
      throw error;
    }
    return kept;
  });
}

export function appendSessionSummary(sessionId, entry, expectedRevision = null) {
  const task = enqueueSessionMutation(async () => {
    if (expectedRevision !== null && !isSessionSummaryRevisionCurrent(sessionId, expectedRevision)) {
      throw new Error('会话摘要已重置');
    }
    const { status, summaries } = await getSessionSummariesStatus(sessionId);
    if (status === 'corrupt') throw new Error('记忆摘要读取失败，请稍后重试');
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

async function readLegacyMessages(characterId) {
  let stored = await readJson(messagesKey(characterId), null);
  if ((!Array.isArray(stored) || stored.length === 0)
    && characterId === DEFAULT_CHARACTER.id) {
    stored = await readJson(LEGACY_MESSAGES_KEY, null);
  }
  return Array.isArray(stored) ? stored.filter(item => item && !item.pending) : [];
}

async function startNewSessionInternal(characterId, opening = null) {
  // 这里以前会先扫描每个会话的消息体，只把“读得到内容”的会话写回列表。
  // 于是任何一次读取失败（例如值过大触发 Android cursor window）都会让该会话
  // 被静默地从会话列表里删除：消息体还在，但会话再也看不见、也删不掉，
  // 只有下次扫描恰好成功时才会“复活”。新建对话无权删掉别的会话。
  const sessions = await requireSessions();
  const previousActiveId = await getActiveSessionId().catch(() => '');
  const created = createEmptySession(characterId, sessions);
  created.greetingSelected = opening !== null && opening !== undefined;
  const openingText = String(opening && opening.text || '').trim();
  const openingTemplate = String(opening && opening.template || openingText).trim();
  const messageKey = sessionMessagesKey(created.id);
  try {
    if (openingText) {
      const greeting = {
        id: `greeting-${created.id}`,
        role: 'assistant',
        text: openingText,
        timestamp: Date.now(),
        kind: 'greeting',
        greetingTemplate: openingTemplate,
      };
      created.preview = buildPreview([greeting]);
      await AsyncStorage.setItem(messageKey, JSON.stringify([greeting]));
    }
    const next = sortSessions([...sessions, created]);
    await saveSessionsInternal(next);
    await setActiveSessionIdInternal(created.id);
    return created;
  } catch (error) {
    const existingRollback = await AsyncStorage.getItem(SESSION_ROLLBACK_BACKUP_KEY).catch(() => null);
    if (!existingRollback) {
      await AsyncStorage.setItem(
        SESSION_ROLLBACK_BACKUP_KEY,
        JSON.stringify(sessions)
      ).catch(() => {});
    }
    let restored = true;
    await saveSessionsInternal(sessions).catch(() => { restored = false; });
    if (restored) await AsyncStorage.removeItem(SESSION_ROLLBACK_BACKUP_KEY).catch(() => {});
    if (openingText) await AsyncStorage.removeItem(messageKey).catch(() => {});
    if (previousActiveId) {
      await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(previousActiveId)).catch(() => {});
    }
    throw error;
  }
}

async function setSessionGreetingSelectedInternal(sessionId, selected = true) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target || target.type === 'group') return target || null;
  const updated = { ...target, greetingSelected: selected !== false };
  if (updated.greetingSelected === target.greetingSelected) return target;
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

async function createGroupSessionInternal(members, name, extras = {}) {
  const sessions = await requireSessions();
  const previousActiveId = await getActiveSessionId().catch(() => '');
  const created = buildGroupSession(members, name, sessions, Date.now(), extras);
  const next = sortSessions([...sessions, created]);
  try {
    await saveSessionsInternal(next);
    await setActiveSessionIdInternal(created.id);
    return created;
  } catch (error) {
    await saveSessionsInternal(sessions).catch(() => {});
    if (previousActiveId) {
      await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(previousActiveId)).catch(() => {});
    }
    throw error;
  }
}

async function updateSessionInfoInternal(sessionId, patch = {}) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target || target.type !== 'group') return target || null;
  const source = patch && typeof patch === 'object' ? patch : {};
  const updated = { ...target };
  if (source.name !== undefined) updated.name = String(source.name || '');
  if (source.avatarUri !== undefined) updated.avatarUri = String(source.avatarUri || '');
  if (source.bgUri !== undefined) updated.bgUri = String(source.bgUri || '');
  updated.updatedAt = Date.now();
  markMediaWrite(updated.avatarUri);
  markMediaWrite(updated.bgUri);
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

async function updateSessionMemberProfilesInternal(sessionId, memberProfiles) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target || target.type !== 'group') return target || null;
  const incoming = memberProfiles && typeof memberProfiles === 'object' ? memberProfiles : {};
  const merged = { ...(target.memberProfiles || {}) };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    const id = String(key || '').trim();
    const text = String(value || '').trim();
    if (!id || !text || merged[id]) continue;
    merged[id] = text;
    changed = true;
  }
  if (!changed) return target;
  const updated = { ...target, memberProfiles: merged };
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

async function cloneSessionInternal(sessionId) {
  const sessions = await requireSessions();
  const source = sessions.find(session => session.id === sessionId);
  if (!source) throw new Error('会话不存在');
  const messageState = await getMessagesBySessionStatus(sessionId);
  if (messageState.status === 'corrupt') {
    throw new Error('聊天记录读取失败，无法克隆');
  }
  const messages = messageState.messages;
  const now = Date.now();
  const copy = buildClonedSession(sessions, source, messages, now);
  const copyKey = sessionMessagesKey(copy.id);
  await AsyncStorage.setItem(
    copyKey,
    JSON.stringify(regenerateMessageIds(messages, now))
  );
  try {
    await saveSessionsInternal(sortSessions([...sessions, copy]));
  } catch (error) {
    await AsyncStorage.removeItem(copyKey).catch(() => {});
    throw error;
  }
  return copy;
}

async function deleteSessionInternal(sessionId) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  const activeId = await getActiveSessionId();
  const remaining = sessions.filter(session => session.id !== sessionId);
  await saveSessionsInternal(remaining);
  if (target && shouldIndexSession(target)) {
    try {
      await removeVectorIndexForSession(target.characterId, sessionId);
    } catch (error) {
      if (__DEV__) console.warn('[vector] session cleanup failed', error);
    }
  }
  deletedSessionIds.add(String(sessionId));
  try {
    await AsyncStorage.multiRemove([
      sessionMessagesKey(sessionId),
      sessionSummariesKey(sessionId),
      sessionDraftKey(sessionId),
    ]);
  } catch (error) {}
  await collectChatImageFiles();
  if (activeId === sessionId) {
    const nextActive = remaining[0] || null;
    if (nextActive) {
      await setActiveSessionIdInternal(nextActive.id);
      return { sessions: remaining, activeSessionId: nextActive.id, created: null };
    }
    const ownerId = target && target.type !== 'group'
      ? String(target.characterId || DEFAULT_CHARACTER.id)
      : DEFAULT_CHARACTER.id;
    const created = createEmptySession(ownerId, remaining);
    const next = sortSessions([...remaining, created]);
    await saveSessionsInternal(next);
    await setActiveSessionIdInternal(created.id);
    return { sessions: next, activeSessionId: created.id, created };
  }
  return { sessions: remaining, activeSessionId: activeId, created: null };
}

async function deleteSessionsInternal(sessionIds) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  const sessions = await requireSessions();
  if (ids.length === 0) {
    return { sessions, activeSessionId: await getActiveSessionId() };
  }
  const idSet = new Set(ids);
  const remaining = sessions.filter(session => !idSet.has(session.id));
  await saveSessionsInternal(remaining);
  // 批量删除也要同步持久化的活动会话指针：删除的正好是当前会话时，
  // 内存里 AppContext 会重算，但存储若继续指向已删除 id，下次启动会读到悬空指针。
  const activeBefore = await getActiveSessionId();
  let activeSessionId = activeBefore;
  if (idSet.has(String(activeBefore))) {
    activeSessionId = remaining[0] ? remaining[0].id : '';
    await setActiveSessionIdInternal(activeSessionId);
  }
  const vectorTargets = new Map();
  for (const id of ids) {
    const target = sessions.find(session => session.id === id);
    if (!target || !shouldIndexSession(target)) continue;
    const ownerId = String(target.characterId);
    const targetIds = vectorTargets.get(ownerId) || [];
    targetIds.push(id);
    vectorTargets.set(ownerId, targetIds);
  }
  for (const [ownerId, targetIds] of vectorTargets) {
    try {
      await removeVectorIndexForSessions(ownerId, targetIds);
    } catch (error) {
      if (__DEV__) console.warn('[vector] batch session cleanup failed', error);
    }
  }
  ids.forEach(id => deletedSessionIds.add(String(id)));
  try {
    await AsyncStorage.multiRemove(ids.flatMap(id => [
      sessionMessagesKey(id),
      sessionSummariesKey(id),
      sessionDraftKey(id),
    ]));
  } catch (error) {}
  await collectChatImageFiles();
  return { sessions: remaining, activeSessionId };
}

export function saveMessagesBySession(sessionId, messages, characterId = '', protectedUris = []) {
  return enqueueSessionMutation(() => saveMessagesBySessionInternal(
    sessionId,
    messages,
    characterId,
    protectedUris
  ));
}

export function startNewSession(characterId, opening = null) {
  return enqueueSessionMutation(() => startNewSessionInternal(characterId, opening));
}

export function setSessionGreetingSelected(sessionId, selected = true) {
  return enqueueSessionMutation(() => setSessionGreetingSelectedInternal(sessionId, selected));
}

export function createGroupSession(members, name, extras = {}) {
  return enqueueSessionMutation(() => createGroupSessionInternal(members, name, extras));
}

export function updateSessionInfo(sessionId, patch = {}) {
  return enqueueSessionMutation(() => updateSessionInfoInternal(sessionId, patch));
}

export function updateSessionMemberProfiles(sessionId, memberProfiles) {
  return enqueueSessionMutation(() => updateSessionMemberProfilesInternal(sessionId, memberProfiles));
}

export function cloneSession(sessionId) {
  return enqueueSessionMutation(() => cloneSessionInternal(sessionId));
}

export function deleteSession(sessionId) {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(() => deleteSessionInternal(sessionId));
}

export function deleteSessions(sessionIds) {
  (Array.isArray(sessionIds) ? sessionIds : []).forEach(id => bumpSessionSummaryRevision(id));
  return enqueueSessionMutation(() => deleteSessionsInternal(sessionIds));
}

export function restoreSession(sessionId, characterId) {
  return enqueueSessionMutation(() => restoreSessionInternal(sessionId, characterId));
}

export function migrateLegacyMessages(characters) {
  return enqueueSessionMutation(() => migrateLegacyMessagesInternal(characters));
}

// 找出"消息体还在、会话记录却丢了"的孤儿对话。
// 历史版本的 startNewSession 会把读不到消息体的会话从列表里静默删除，
// 结果消息留在 @easychat2_messages::<id>，但列表里再也看不到、也删不掉。
export async function findOrphanSessions() {
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    throw new Error('会话列表读取失败，请稍后重试');
  }
  const prefix = `${MESSAGES_KEY_PREFIX}::`;
  const ids = (Array.isArray(keys) ? keys : [])
    .filter(key => typeof key === 'string' && key.startsWith(prefix))
    // 损坏备份键（<消息键>__corrupt_backup）不是真实消息体，排除掉避免误当孤儿
    .filter(key => !key.endsWith(CORRUPT_BACKUP_SUFFIX))
    .map(key => key.slice(prefix.length))
    .filter(Boolean);
  if (ids.length === 0) return [];

  const { status, sessions } = await readSessionsStatus();
  // 列表读不出时不能判定孤儿（否则会把所有消息体都误判成“会话丢失”），
  // 明确抛错让调用方提示“读不到”，而不是伪装成“没有丢失的对话”。
  if (status === 'corrupt') throw new Error('会话列表读取失败，请稍后重试');
  const known = new Set(sessions.map(session => session.id));
  // 老版本按角色 id 存消息（messagesKey(characterId)），键的形状和会话键一样，
  // 会把它们当成孤儿。这里按角色库排除，避免把历史遗留键恢复成重复的对话。
  const characters = await getCharacterLibrary().catch(() => []);
  const characterIds = new Set(
    (Array.isArray(characters) ? characters : []).map(item => String((item && item.id) || ''))
  );
  const candidates = ids.filter(id => !known.has(id) && !characterIds.has(id));
  if (candidates.length === 0) return [];

  // 逐批读取，最多同时打开 4 个消息体。Android 的 CursorWindow 对单个值有读取上限，
  // 大库一次性并发打开全部键会显著提高读取失败概率，这里用有界并发换取稳定性。
  const entries = [];
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const batchEntries = await Promise.all(batch.map(async sessionId => {
      const state = await getMessagesBySessionStatus(sessionId);
      return { sessionId, state };
    }));
    entries.push(...batchEntries);
  }

  const orphans = [];
  for (const entry of entries) {
    const sessionId = entry && entry.sessionId;
    const state = entry && entry.state;
    if (!sessionId || !state || state.status !== 'ok') continue;
    const messages = state.messages.filter(item => (
      item && (item.role === 'user' || item.role === 'assistant')
    ));
    if (messages.length === 0) continue;
    const timestamps = messages
      .map(item => Number(item.timestamp))
      .filter(value => Number.isFinite(value));
    const firstReply = messages.find(item => (
      item.role === 'assistant' && String(item.text || '').trim()
    ));
    orphans.push({
      sessionId,
      messageCount: messages.length,
      preview: buildPreview(messages),
      createdAt: timestamps.length ? Math.min(...timestamps) : 0,
      updatedAt: timestamps.length ? Math.max(...timestamps) : 0,
      greeting: firstReply ? String(firstReply.text || '') : '',
      // 群聊消息带 speakerId：把发言人带出去，恢复时才能还原成群聊
      speakers: collectMessageSpeakers(messages),
    });
  }
  orphans.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return orphans;
}

// 把孤儿对话按指定角色补回会话列表，id 沿用原值，消息与已有的记忆摘要都会接上。
// 群聊（消息里带多个 speakerId）不需要归属角色，会还原成群聊并保留成员。
async function restoreSessionInternal(sessionId, characterId) {
  const id = String(sessionId || '');
  const owner = String(characterId || '');
  if (!id) throw new Error('恢复参数不完整');
  const sessions = await requireSessions();
  const existing = sessions.find(session => session.id === id);
  if (existing) {
    deletedSessionIds.delete(id);
    return existing;
  }
  const messages = await getMessagesBySession(id);
  if (messages.length === 0) throw new Error('这段对话没有可恢复的消息');
  if (!isMessageGroup(messages) && !owner) throw new Error('恢复参数不完整');
  const restored = buildRestoredSession({ sessionId: id, characterId: owner, messages });
  // 会话摘要还在（单独按 sessionId 存）：把总结边界接到最后一条摘要的边界上，
  // 免得下次总结把已经总结过的消息再总结一遍（弹窗承诺“记忆摘要会回来”）。
  const summaryStatus = await getSessionSummariesStatus(id);
  if (summaryStatus.status === 'corrupt') {
    throw new Error('记忆摘要读取失败，请稍后重试');
  }
  if (summaryStatus.summaries.length > 0) {
    const boundary = String(summaryStatus.summaries[summaryStatus.summaries.length - 1].boundary || '');
    if (boundary && messages.some(item => item && String(item.id) === boundary)) {
      restored.summarizedUpTo = boundary;
    }
  }
  await saveSessionsInternal(sortSessions([...sessions, restored]));
  deletedSessionIds.delete(id);
  return restored;
}

async function migrateLegacyMessagesInternal(characters) {
  const list = Array.isArray(characters) ? characters : [];
  const sessions = await requireSessions();
  const existingIds = new Set(sessions.map(session => session.id));
  const migrated = [];
  for (const character of list) {
    const characterId = character && character.id;
    if (!characterId) continue;
    const sessionId = legacySessionId(characterId);
    if (existingIds.has(sessionId)) continue;
    const messages = await readLegacyMessages(characterId);
    if (messages.length === 0) continue;
    const timestamps = messages
      .map(item => Number(item && item.timestamp))
      .filter(value => Number.isFinite(value));
    const fallback = Date.now();
    const createdAt = timestamps.length ? Math.min(...timestamps) : fallback;
    const updatedAt = timestamps.length ? Math.max(...timestamps) : fallback;
    const session = {
      id: sessionId,
      characterId: String(characterId),
      preview: buildPreview(messages),
      pinned: false,
      createdAt,
      updatedAt,
      clonedFrom: '',
    };
    await AsyncStorage.setItem(sessionMessagesKey(sessionId), JSON.stringify(messages));
    existingIds.add(sessionId);
    migrated.push(session);
  }
  if (migrated.length > 0) {
    await saveSessionsInternal(sortSessions([...sessions, ...migrated]));
  }
  return migrated;
}
