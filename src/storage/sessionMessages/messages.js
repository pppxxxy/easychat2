// 会话消息载体：按会话分键的消息读/写/状态，以及主动消息落库。
// 从 src/storage/sessionMessages.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  buildPreview,
  createEmptySession,
  sortSessions,
} from '../../context/sessionLibrary.js';
import {
  backupCorruptValue,
  readJsonStatus,
} from '../io.js';
import { markMediaWrite } from '../mediaProtection.js';
import { tActive } from '../../i18n/index.js';
import { mergeProactiveMessage } from '../../proactive/proactiveInbox.js';
import {
  collectChatImageFiles,
  imageUrisFromMessages,
} from '../sessionFiles.js';
import {
  deletedSessionIds,
  enqueueSessionMutation,
  getActiveSessionId,
  readSessionsStatus,
  saveSessionsInternal,
  sessionMessagesKey,
} from '../sessionCore.js';
import { getSessionSummariesStatus } from './summaryStore.js';

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
