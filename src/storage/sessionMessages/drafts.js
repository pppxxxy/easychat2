// 会话输入草稿：按会话分键的高频旁路读写。
// 从 src/storage/sessionMessages.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { sessionDraftKey } from '../sessionCore.js';

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
