// 旧版按角色 id 的消息迁移到会话模型。从 src/storage/sessionList.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { buildPreview, sortSessions } from '../../context/sessionLibrary.js';
import { readLegacyMessages } from './mutations.js';
import {
  enqueueSessionMutation,
  legacySessionId,
  messagesKey,
  requireSessions,
  saveSessionsInternal,
  sessionMessagesKey,
} from '../sessionCore.js';

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
    // 会话登记成功后才删源键：确保删除是持久的（否则用户删掉自动迁移的会话后，
    // 源键仍在，下次启动会重新迁移让对话复活）。放在 saveSessions 之后，
    // 即使保存失败也不会先删源数据。
    for (const session of migrated) {
      const characterId = String(session.characterId || '');
      if (characterId) await AsyncStorage.removeItem(messagesKey(characterId));
    }
  }
  return migrated;
}

export function migrateLegacyMessages(characters) {
  return enqueueSessionMutation(() => migrateLegacyMessagesInternal(characters));
}
