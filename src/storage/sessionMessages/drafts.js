// 会话输入草稿：按会话分键的高频旁路读写。
// 从 src/storage/sessionMessages.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue } from '../io.js';
import { sessionDraftKey } from '../sessionCore.js';

// ---------- 输入草稿 ----------

// 草稿读写不经过会话变更队列：它是高频、独立的旁路数据，进队列反而会让
// 每次输入都排在一次消息写盘之后。按会话分键天然互相隔离。
//
// ⚠️ 那是**性能**取舍，与「读失败要不要当成没有草稿」是两件事。读侧照
// messages.js:32-45 的三态口径返回 { status, text }：「读不出」与「确实没有草稿」
// 一旦合并成同一个 ''，调用方（chat/useSessionMessages.js 的回填 effect）就会把
// draftTextRef 置空，紧接着 400ms 防抖写盘（或清空输入触发的 removeItem）直接
// 覆盖/删除用户那份**别处没有副本**的手打草稿，无任何备份。
// 对照 messages.js:37-39：消息体损坏尚且先 backupCorruptValue 留一份副本，
// 草稿更不能裸覆盖。status: 'ok' | 'missing' | 'corrupt'。
export async function getSessionDraft(sessionId) {
  const id = String(sessionId || '');
  if (!id) return { status: 'missing', text: '' };
  const key = sessionDraftKey(id);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing', text: '' };
    if (typeof raw === 'string') return { status: 'ok', text: raw };
    // 形状不对（正常不会出现）：按损坏处理，别把它当成空草稿覆盖掉。
    await backupCorruptValue(key);
    return { status: 'corrupt', text: '' };
  } catch (error) {
    // 读不出（Android CursorWindow 单值上限 / 权限失败都是这个形态）：先留副本再报
    // corrupt，与 messages.js:37-39 同一条纪律。瞬时失败能救回副本；持续失败时
    // backupCorruptValue 自己会记一条诊断（io.js:194-198），不会静默。
    await backupCorruptValue(key);
    return { status: 'corrupt', text: '' };
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
