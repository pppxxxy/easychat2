// 记忆冲突记录存储域：按角色保存「哪两条记忆被判为矛盾、用户怎么处理」。
//
// 为什么要落盘而不是只留在内存：矛盾判定要花一次模型调用，用户点开记忆页
// 不该每次都重新判；而且「忽略」这个选择必须记住，否则下次扫描又把同一对
// 抛出来烦人。
//
// 记录同时保存两条记忆当时的文本快照：记忆被删/合并后，记录仍能显示
// 「当时判的是哪两条」，不会变成一对无法解读的空键。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

export const MEMORY_CONFLICT_PREFIX = '@easychat2_memory_conflicts';

// 每个角色最多留多少条记录：冲突对数量天然有限（候选上限 12/次），
// 上限只是防御异常数据把键撑大。
export const MAX_CONFLICT_RECORDS = 100;

const conflictMutation = createMutationQueue();

// 空 id 不落任何桶：与 vector.js 同一条约束——无归属的记录会串到别人身上。
function conflictStorageKey(characterId) {
  const id = String(characterId || '').trim();
  return id ? `${MEMORY_CONFLICT_PREFIX}::${id}` : '';
}

function normalizeConflictRecord(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    key: String(source.key || ''),
    aKey: String(source.aKey || ''),
    bKey: String(source.bKey || ''),
    aText: String(source.aText || ''),
    bText: String(source.bText || ''),
    score: Number(source.score) || 0,
    conflict: source.conflict === true,
    reason: String(source.reason || ''),
    at: Number(source.at) || 0,
    // '' | 'kept-a' | 'kept-b' | 'merged' | 'ignored'
    resolution: String(source.resolution || ''),
  };
}

function normalizeConflictList(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map(normalizeConflictRecord)
    .filter(item => item.key);
  // 超出上限时丢最旧的（按判定时间），保留最近的判定结果。
  if (list.length <= MAX_CONFLICT_RECORDS) return list;
  return [...list]
    .sort((a, b) => a.at - b.at)
    .slice(list.length - MAX_CONFLICT_RECORDS);
}

export async function getMemoryConflicts(characterId) {
  const key = conflictStorageKey(characterId);
  if (!key) return [];
  const stored = await readJsonStatus(key);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return [];
  }
  if (stored.status === 'missing') return [];
  return normalizeConflictList(stored.value);
}

async function writeConflictList(characterId, records) {
  const key = conflictStorageKey(characterId);
  const list = normalizeConflictList(records);
  if (!key) return list;
  if (list.length === 0) {
    await AsyncStorage.removeItem(key);
    return list;
  }
  await AsyncStorage.setItem(key, JSON.stringify(list));
  return list;
}

function enqueue(characterId, task) {
  return conflictMutation.enqueue(task, conflictStorageKey(characterId) || 'memory-conflicts:no-owner');
}

// 读-改-写：按 key 合并新判定，保留已有记录的 resolution（用户已做的选择
// 不能被一次重扫覆盖掉）。
export function upsertMemoryConflicts(characterId, records) {
  const incoming = normalizeConflictList(records);
  if (incoming.length === 0) return Promise.resolve(getMemoryConflicts(characterId));
  return enqueue(characterId, async () => {
    const current = await getMemoryConflicts(characterId);
    const byKey = new Map(current.map(item => [item.key, item]));
    incoming.forEach(item => {
      const existing = byKey.get(item.key);
      byKey.set(item.key, existing
        ? { ...item, resolution: existing.resolution }
        : item);
    });
    return writeConflictList(characterId, [...byKey.values()]);
  });
}

export function resolveMemoryConflict(characterId, pairKey, resolution) {
  const key = String(pairKey || '');
  const value = String(resolution || '');
  if (!key) return Promise.resolve([]);
  return enqueue(characterId, async () => {
    const current = await getMemoryConflicts(characterId);
    return writeConflictList(
      characterId,
      current.map(item => (item.key === key ? { ...item, resolution: value } : item))
    );
  });
}

// 记忆被删除（保留其中一条 / 手动清理）后，把牵涉它的记录一并清掉：
// 留着指向已不存在记忆的冲突记录，只会让界面显示一对空壳。
export function removeMemoryConflictsForMemories(characterId, memoryKeys) {
  const targets = new Set(
    (Array.isArray(memoryKeys) ? memoryKeys : [memoryKeys])
      .map(key => String(key || ''))
      .filter(Boolean)
  );
  if (targets.size === 0) return Promise.resolve(getMemoryConflicts(characterId));
  return enqueue(characterId, async () => {
    const current = await getMemoryConflicts(characterId);
    return writeConflictList(
      characterId,
      current.filter(item => !targets.has(item.aKey) && !targets.has(item.bKey))
    );
  });
}

export function clearMemoryConflicts(characterId) {
  const key = conflictStorageKey(characterId);
  if (!key) return Promise.resolve();
  return enqueue(characterId, () => AsyncStorage.removeItem(key));
}
