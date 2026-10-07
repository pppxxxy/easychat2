// 会话增删改与读写内部实现，以及队列包裹的对外包装。
// 从 src/storage/sessionList.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  applySessionModelMark,
  buildClonedSession,
  buildPreview,
  createEmptySession,
  createGroupSession as buildGroupSession,
  regenerateMessageIds,
  sortSessions,
} from '../../context/sessionLibrary.js';
import { shouldIndexSession } from '../../vectorMemory/scope.js';
import { DEFAULT_CHARACTER } from '../characters.js';
import { migrateWorldMemoriesToSession, reconcileWorldMemories } from '../memoryOwnership.js';
import {
  removeVectorIndexForSession,
  removeVectorIndexForSessions,
} from '../vector.js';
import { readJson } from '../io.js';
import { tActive } from '../../i18n/index.js';
import { markMediaWrite } from '../mediaProtection.js';
import { collectChatImageFiles, collectVoiceFiles } from '../sessionFiles.js';
import { getMessagesBySessionStatus } from '../sessionMessages.js';
import { deleteAllBranchesInternal } from '../sessionBranches.js';
import {
  ACTIVE_SESSION_KEY,
  LEGACY_MESSAGES_KEY,
  SESSION_ROLLBACK_BACKUP_KEY,
  bumpSessionSummaryRevision,
  deletedSessionIds,
  enqueueSessionMutation,
  getActiveSessionId,
  messagesKey,
  requireSessions,
  saveSessionsInternal,
  sessionDraftKey,
  sessionMessagesKey,
  sessionSummariesKey,
  setActiveSessionIdInternal,
} from '../sessionCore.js';

export async function readLegacyMessages(characterId) {
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
  if (!source) throw new Error(tActive('error.storage.sessionNotFound'));
  const messageState = await getMessagesBySessionStatus(sessionId);
  if (messageState.status === 'corrupt') {
    throw new Error(tActive('error.storage.chatLogReadFailedClone'));
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
  await deleteAllBranchesInternal(sessionId);
  await collectChatImageFiles();
  await collectVoiceFiles();
  // 会话结构变了：卡上记忆要按新的会话数重新判定归属。删到 0 个会话、或删掉的是
  // 「唯一会话」以外的那个时，留在卡上的记忆就再没有合法读者——不退休的话，
  // 一旦会话数回到 1 又会被注入，用户感知就是「串了历史对话」。
  if (target && String(target.type || 'single') !== 'group') {
    await reconcileWorldMemories({ characterId: String(target.characterId || '') }).catch(() => {});
  }
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
  for (const id of ids) await deleteAllBranchesInternal(id);
  await collectChatImageFiles();
  await collectVoiceFiles();
  // 批量删除同样要销旧账：按受影响角色逐一重新判定卡上记忆的归属。
  const touchedCharacters = new Set(
    ids
      .map(sessionId => sessions.find(session => session.id === sessionId))
      .filter(target => target && String(target.type || 'single') !== 'group')
      .map(target => String(target.characterId || ''))
      .filter(Boolean)
  );
  for (const characterId of touchedCharacters) {
    await reconcileWorldMemories({ characterId }).catch(() => {});
  }
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
  // 单会话 → 多会话的迁移必须在会话队列**之外**做：它内部要 appendSessionSummary
  // （用同一个会话队列），在队列内调用会自我等待。迁移失败不影响新建（对账会兜住）。
  return migrateWorldMemoriesToSession(characterId)
    .catch(() => ({ migrated: 0 }))
    .then(() => enqueueSessionMutation(() => startNewSessionInternal(characterId, opening)));
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

// 会话模型标识落盘：只更新 modelKind/modelName 两个可选字段，不动 preview/updatedAt，
// 也不重排列表（updatedAt 未变）。必须在会话变更队列内读-改-写，与消息快照写盘
// （saveMessagesBySessionInternal 的 preview/updatedAt 更新）串行，互不覆盖。
async function markSessionModelInternal(sessionId, mark) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  const updated = applySessionModelMark(target, mark);
  if (!updated) return target || null;
  await saveSessionsInternal(sessions.map(session => (
    session.id === sessionId ? updated : session
  )));
  return updated;
}

export function markSessionModel(sessionId, mark) {
  return enqueueSessionMutation(() => markSessionModelInternal(sessionId, mark));
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
