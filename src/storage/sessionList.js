// 会话列表领域：会话增删改、克隆、群聊、迁移、孤儿恢复、活动会话指针、向量索引对账。
// 从 src/storage/sessions.js 拆出（纯搬运，无行为变化）。依赖 sessionCore（键/状态/列表原语）
// 与 sessionMessages（消息/摘要）、sessionFiles（图片回收），方向单向无循环。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  buildClonedSession,
  buildPreview,
  buildRestoredSession,
  collectMessageSpeakers,
  createEmptySession,
  createGroupSession as buildGroupSession,
  isMessageGroup,
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
import { CORRUPT_BACKUP_SUFFIX, readJson } from './io.js';
import { markMediaWrite } from '../mediaProtection.js';
import { collectChatImageFiles, collectVoiceFiles } from './sessionFiles.js';
import {
  getMessagesBySession,
  getMessagesBySessionStatus,
  getSessionSummariesStatus,
} from './sessionMessages.js';
import {
  ACTIVE_SESSION_KEY,
  LEGACY_MESSAGES_KEY,
  MESSAGES_KEY_PREFIX,
  SESSION_ROLLBACK_BACKUP_KEY,
  bumpSessionSummaryRevision,
  deletedSessionIds,
  enqueueSessionMutation,
  getActiveSessionId,
  legacySessionId,
  messagesKey,
  readSessionsStatus,
  requireSessions,
  saveSessionsInternal,
  sessionDraftKey,
  sessionMessagesKey,
  sessionSummariesKey,
  setActiveSessionIdInternal,
} from './sessionCore.js';

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
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[vector] reconciliation failed', error);
    }
  }
  return report;
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
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[vector] session cleanup failed', error);
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
  await collectVoiceFiles();
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
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[vector] batch session cleanup failed', error);
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
  await collectVoiceFiles();
  return { sessions: remaining, activeSessionId };
}

async function setSessionPinnedInternal(sessionId, pinned) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target) return null;
  const updated = { ...target, pinned: pinned === true };
  if (updated.pinned === target.pinned) return updated;
  const sorted = sortSessions(sessions.map(session => (
    session.id === sessionId ? updated : session
  )));
  await saveSessionsInternal(sorted);
  return updated;
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

// 置顶/取消置顶：在会话队列内读-改-写，避免调用方用内存旧快照整表覆盖，
// 把并发写入（如主动消息落库新建的会话）打回旧值。
export function setSessionPinned(sessionId, pinned) {
  return enqueueSessionMutation(() => setSessionPinnedInternal(sessionId, pinned));
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

export { MESSAGES_KEY_PREFIX };
