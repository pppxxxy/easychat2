// 会话存储的核心层：变更队列、存储键、跨模块共享状态、会话列表读写原语、摘要版本号。
// 从 src/storage/sessions.js 拆出（纯搬运，无行为变化）。本层不依赖任何兄弟会话模块，
// 其余会话模块（files/messages/list）都依赖它，以此消除 ESM 循环依赖。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeSession } from '../context/sessionLibrary.js';
import { DEFAULT_CHARACTER } from './characters.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';
import { tActive } from '../i18n/index.js';

export const SESSIONS_KEY = '@easychat2_sessions';
const SESSION_ROLLBACK_BACKUP_KEY = '@easychat2_sessions__rollback_backup';
const SESSION_SUMMARIES_PREFIX = '@easychat2_session_summaries';
// 每个会话的输入框草稿：按会话分键，避免把可能很大的集合塞进单键。
const SESSION_DRAFT_PREFIX = '@easychat2_session_draft';
const ACTIVE_SESSION_KEY = '@easychat2_active_session';
const MESSAGES_KEY_PREFIX = '@easychat2_messages';
const LEGACY_MESSAGES_KEY = '@easychat2_messages';
// 对话分支：每个会话一份轻量索引 + 每条分支正文一个键。
// 索引是写盘提交点（先写条目、后写索引）；条目按 <sessionId>::<branchId> 分键，
// 避免把分支正文塞进消息单键（Android 单值读取上限）。
const BRANCH_INDEX_PREFIX = '@easychat2_branch_index';
const BRANCH_ITEM_PREFIX = '@easychat2_branch_item';

// 跨模块共享的可变状态：全部集中在本层，兄弟模块 import 后引用同一实例。
const sessionMutation = createMutationQueue();
export const deletedSessionIds = new Set();
const sessionSummaryRevisions = new Map();
export const protectedChatImageUris = new Set();
export const protectedVoiceUris = new Set();

export function enqueueSessionMutation(task) {
  return sessionMutation.enqueue(task);
}

// 等待当前挂起的会话写入全部落定。迁移（migrateLegacyMessages）也在 sessionMutationQueue
// 里，但会话列表读取（getSessions）不经过队列；外部刷新若在迁移写盘中途读取，会拿到中间态。
// 刷新前 await 这个钩子即可保证读到迁移完成后的最终状态。
export function whenSessionMutationsSettled() {
  return sessionMutation.settle();
}

export function messagesKey(characterId) {
  return `${MESSAGES_KEY_PREFIX}::${characterId || DEFAULT_CHARACTER.id}`;
}

export function sessionMessagesKey(sessionId) {
  return `${MESSAGES_KEY_PREFIX}::${sessionId}`;
}

export function sessionSummariesKey(sessionId) {
  return `${SESSION_SUMMARIES_PREFIX}::${String(sessionId || '')}`;
}

export function sessionDraftKey(sessionId) {
  return `${SESSION_DRAFT_PREFIX}::${String(sessionId || '')}`;
}

export function sessionBranchIndexKey(sessionId) {
  return `${BRANCH_INDEX_PREFIX}::${String(sessionId || '')}`;
}

export function sessionBranchItemKey(sessionId, branchId) {
  return `${BRANCH_ITEM_PREFIX}::${String(sessionId || '')}::${String(branchId || '')}`;
}

// 某会话全部分支条目键的前缀：用于会话删除/孤儿清理时批量识别。
export function sessionBranchItemPrefix(sessionId) {
  return `${BRANCH_ITEM_PREFIX}::${String(sessionId || '')}::`;
}

export function legacySessionId(characterId) {
  return `legacy-${characterId}`;
}

export { MESSAGES_KEY_PREFIX, LEGACY_MESSAGES_KEY, ACTIVE_SESSION_KEY, BRANCH_ITEM_PREFIX };

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

// 会话列表的读取状态：损坏时先备份原始值再当作空列表，避免调用方
// 用空列表把“暂时读不出”的真实数据整表覆盖掉（Android cursor window 等）。
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

// J3：设置会话级 agent 模式记忆（read/write；'' 清除 = 跟随全局）。
// 返回是否成功（缺会话/缺参数 → false）。
export async function setSessionAgentMode(sessionId, mode) {
  const id = String(sessionId || '').trim();
  const value = mode === 'read' || mode === 'write' ? mode : '';
  if (!id) return false;
  return enqueueSessionMutation(async () => {
    const sessions = await requireSessions();
    const target = sessions.find(item => item && item.id === id);
    if (!target) return false;
    if (target.agentMode === value) return true; // 幂等
    const next = sessions.map(item => (
      item && item.id === id ? normalizeSession({ ...item, agentMode: value }) : item
    ));
    await saveSessionsInternal(next);
    return true;
  });
}

// 读改写路径：列表损坏时必须中止，否则会把 SESSIONS_KEY 覆盖成空/单条。
export async function requireSessions() {
  const { status, sessions } = await readSessionsStatus();
  if (status === 'corrupt') {
    throw new Error(tActive('error.storage.sessionRecordReadFailed'));
  }
  return sessions;
}

export async function saveSessionsInternal(sessions) {
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
      throw new Error(tActive('error.storage.sessionRecordReadFailed'));
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

export async function setActiveSessionIdInternal(id) {
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

// 待发送语音的本地文件保护：录音完成后、消息落盘前，文件已存在于 voice/，
// 若此时触发回收会被误删。与图片保护同构。
export function setProtectedVoiceUris(uris) {
  protectedVoiceUris.clear();
  (Array.isArray(uris) ? uris : []).forEach(uri => {
    const value = String(uri || '');
    if (value.includes('/voice/')) protectedVoiceUris.add(value);
  });
}

export function bumpSessionSummaryRevision(sessionId) {
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

export {
  SESSION_ROLLBACK_BACKUP_KEY,
};
