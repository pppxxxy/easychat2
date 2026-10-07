// 孤儿会话扫描与恢复。从 src/storage/sessionList.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  buildPreview,
  buildRestoredSession,
  collectMessageSpeakers,
  isMessageGroup,
  sortSessions,
} from '../../context/sessionLibrary.js';
import { getCharacterLibrary } from '../characters.js';
import { CORRUPT_BACKUP_SUFFIX } from '../io.js';
import { tActive } from '../../i18n/index.js';
import {
  getMessagesBySession,
  getMessagesBySessionStatus,
  getSessionSummariesStatus,
} from '../sessionMessages.js';
import {
  MESSAGES_KEY_PREFIX,
  deletedSessionIds,
  enqueueSessionMutation,
  readSessionsStatus,
  requireSessions,
  saveSessionsInternal,
} from '../sessionCore.js';

// 找出"消息体还在、会话记录却丢了"的孤儿对话。
// 历史版本的 startNewSession 会把读不到消息体的会话从列表里静默删除，
// 结果消息留在 @easychat2_messages::<id>，但列表里再也看不到、也删不掉。
export async function findOrphanSessions() {
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    throw new Error(tActive('error.storage.sessionListReadFailed'));
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
  if (status === 'corrupt') throw new Error(tActive('error.storage.sessionListReadFailed'));
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
  if (!id) throw new Error(tActive('error.storage.restoreParamsIncomplete'));
  const sessions = await requireSessions();
  const existing = sessions.find(session => session.id === id);
  if (existing) {
    deletedSessionIds.delete(id);
    return existing;
  }
  const messages = await getMessagesBySession(id);
  if (messages.length === 0) throw new Error(tActive('error.storage.noRestorableMessages'));
  if (!isMessageGroup(messages) && !owner) throw new Error(tActive('error.storage.restoreParamsIncomplete'));
  const restored = buildRestoredSession({ sessionId: id, characterId: owner, messages });
  // 会话摘要还在（单独按 sessionId 存）：把总结边界接到最后一条摘要的边界上，
  // 免得下次总结把已经总结过的消息再总结一遍（弹窗承诺“记忆摘要会回来”）。
  const summaryStatus = await getSessionSummariesStatus(id);
  if (summaryStatus.status === 'corrupt') {
    throw new Error(tActive('error.storage.summaryReadFailed'));
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

export function restoreSession(sessionId, characterId) {
  return enqueueSessionMutation(() => restoreSessionInternal(sessionId, characterId));
}
