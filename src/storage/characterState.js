// 角色保存的跨域编排（2026-10-07 快赢1 自 storage.js 门面迁出）。
//
// 职责：保存角色库 + 活动角色（失败回滚）→ 标记媒体写修订 → 清理向量索引 →
// 清理已删角色的消息键 → 跑 characterLifecycle 注册的各域清理钩子。
// 「删角色时要清什么」由各域在自己模块里注册（谁的数据谁负责），本文件只跑钩子。

import AsyncStorage from '@react-native-async-storage/async-storage';
import { markMediaWrite } from './mediaProtection.js';
import {
  DEFAULT_CHARACTER,
  getActiveCharacterId,
  getCharacterLibrary,
  saveCharacterLibrary,
  setActiveCharacterId,
} from './characters.js';
import { clearVectorIndex } from './vector.js';
import { messagesKey } from './sessions.js';
import { runCharacterCleanup } from './characterLifecycle.js';

export async function saveCharacterState(list, activeId, deletedIds, clearVectorIds = []) {
  const previousList = await getCharacterLibrary().catch(() => null);
  const previousActiveId = await getActiveCharacterId().catch(() => '');
  for (const item of Array.isArray(list) ? list : []) {
    markMediaWrite(item && item.avatarUri);
    markMediaWrite(item && item.bgUri);
  }
  await saveCharacterLibrary(list);
  try {
    await setActiveCharacterId(activeId);
  } catch (error) {
    if (previousList) await saveCharacterLibrary(previousList).catch(() => {});
    if (previousActiveId) await setActiveCharacterId(previousActiveId).catch(() => {});
    throw error;
  }
  const vectorIds = Array.isArray(clearVectorIds)
    ? clearVectorIds
    : (clearVectorIds ? [clearVectorIds] : []);
  for (const id of vectorIds) {
    if (id && id !== DEFAULT_CHARACTER.id) {
      try {
        await clearVectorIndex(id);
      } catch (error) {
        if (__DEV__) console.warn('[vector] character cleanup failed', error);
      }
    }
  }
  const removed = Array.isArray(deletedIds) ? deletedIds : (deletedIds ? [deletedIds] : []);
  for (const id of removed) {
    if (id && id !== DEFAULT_CHARACTER.id) {
      try {
        await AsyncStorage.removeItem(messagesKey(id));
      } catch (error) {}
    }
  }
  // 角色删除后的跨域清理交给注册机制：各域在自己模块里注册（见 storage/characterLifecycle.js），
  // 这里只负责跑钩子。此前是硬编码清单，新增域必须记得回来改本函数——@easychat2_affinity
  // （好感度）就是这么漏掉的；moments 的清理更是写在 CharacterScreen 里、门面不知道。
  // 钩子内部各自容错，单个域失败不阻断其余域（runCharacterCleanup 逐个 try/catch）。
  const removedCharacters = removed.filter(id => id && id !== DEFAULT_CHARACTER.id);
  await runCharacterCleanup(removedCharacters);
}
