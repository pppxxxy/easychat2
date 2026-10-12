// 旧版按角色 id 的消息迁移到会话模型。从 src/storage/sessionList.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { buildPreview, sortSessions } from '../../context/sessionLibrary.js';
import { DEFAULT_CHARACTER } from '../characters/shared.js';
import { backupCorruptValue, readJsonStatus } from '../io.js';
import { readLegacyMessages } from './mutations.js';
import {
  enqueueSessionMutation,
  legacySessionId,
  messagesKey,
  requireSessions,
  saveSessionsInternal,
  sessionMessagesKey,
  LEGACY_MESSAGES_KEY,
} from '../sessionCore.js';

// 迁移前的**状态探测**：源键读不出来时返回 false，调用方跳过该角色。
// 变体①（拒绝写回 / 拒绝破坏性动作），参考 src/storage/worldMap.js:34-40
// （updateWorldMap「读失败就抛错中止」）与 src/storage/cardForge.js:182-186。
//
// 为什么迁移路径必须区分「读失败」与「本来就没有」：
// readLegacyMessages（sessionList/mutations.js:72-79）用 readJson，读失败 → null → []，
// 迁移循环看到 messages.length === 0 就 `continue` 跳过该角色。于是用户的旧对话
// **既不迁移**（会话列表里看不见）**也不删除**（源键仍在）——一个既看不见也删不掉的孤儿。
// 而 :54 的成功路径 removeItem(messagesKey) 说明设计意图正是「迁完才删源」，
// 那么「没迁成」就绝不能走到删除那一步。
//
// 这里只探测 status，取值/过滤仍交给 readLegacyMessages（那份逻辑只留一处，
// 避免两处规则漂移）；回落规则与它保持一致：主键没有可用的数组时，默认角色再看更老的整键。
async function isLegacyMessagesReadable(characterId) {
  const primaryKey = messagesKey(characterId);
  const primary = await readJsonStatus(primaryKey);
  if (primary.status === 'corrupt') {
    // 留一份原始副本：源键是这批对话的唯一载体。
    await backupCorruptValue(primaryKey);
    return false;
  }
  const needsFallback = primary.status !== 'ok'
    || !Array.isArray(primary.value)
    || primary.value.length === 0;
  if (needsFallback && String(characterId) === String(DEFAULT_CHARACTER.id)) {
    const legacy = await readJsonStatus(LEGACY_MESSAGES_KEY);
    if (legacy.status === 'corrupt') {
      await backupCorruptValue(LEGACY_MESSAGES_KEY);
      return false;
    }
  }
  return true;
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
    // 读不出源消息就跳过（不迁移、不删源）：迁移是幂等的，下次启动会重试。
    if (!(await isLegacyMessagesReadable(characterId))) continue;
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
