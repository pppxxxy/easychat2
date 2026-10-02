// 角色日记存储领域。从 src/storage.js 原样外提（无行为变化）。
// 日记条目按「索引 + 单条分键」存储（与角色库/贴纸/世界书一致），避免整表塞进一个键；
// 设置单键保存：每角色的开关与全局 API 来源。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  normalizeDiaryEntry,
  normalizeDiarySettings,
  removeDiariesForCharacter,
} from '../diary/diary.js';
import { CORRUPT_BACKUP_SUFFIX, backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

const DIARY_SETTINGS_KEY = '@easychat2_diary_settings';
const DIARY_INDEX_KEY = '@easychat2_diary_index';
const DIARY_ITEM_PREFIX = '@easychat2_diary_item';

const diaryMutation = createMutationQueue();

function enqueueDiaryMutation(task) {
  return diaryMutation.enqueue(task);
}

function diaryItemKey(id) {
  return `${DIARY_ITEM_PREFIX}::${String(id || '')}`;
}

export async function getDiarySettings() {
  const stored = await readJsonStatus(DIARY_SETTINGS_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(DIARY_SETTINGS_KEY);
    return normalizeDiarySettings(null);
  }
  return normalizeDiarySettings(stored.status === 'ok' ? stored.value : null);
}

export async function saveDiarySettings(settings) {
  const normalized = normalizeDiarySettings(settings);
  await AsyncStorage.setItem(DIARY_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

async function readDiaryIndex() {
  const stored = await readJsonStatus(DIARY_INDEX_KEY);
  if (stored.status === 'missing') return { status: 'missing', ids: [] };
  if (stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    await backupCorruptValue(DIARY_INDEX_KEY);
    return { status: 'corrupt', ids: [] };
  }
  const ids = stored.value.map(item => String(item || '')).filter(Boolean);
  return { status: 'ok', ids: [...new Set(ids)] };
}

export async function getDiariesStatus() {
  const index = await readDiaryIndex();
  if (index.status === 'missing') return { status: 'missing', diaries: [] };
  if (index.status === 'corrupt') return { status: 'corrupt', diaries: [] };
  const diaries = [];
  for (const id of index.ids) {
    const stored = await readJsonStatus(diaryItemKey(id));
    // 索引在、条目丢了同样按损坏处理：先备份，避免后续写盘把残存的日记清掉。
    if (stored.status === 'missing') {
      await backupCorruptValue(diaryItemKey(id));
      return { status: 'corrupt', diaries: [] };
    }
    if (stored.status === 'corrupt' || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) {
      await backupCorruptValue(diaryItemKey(id));
      return { status: 'corrupt', diaries: [] };
    }
    const normalized = normalizeDiaryEntry(stored.value);
    if (!normalized.id || !normalized.characterId || !normalized.date) {
      await backupCorruptValue(diaryItemKey(id));
      return { status: 'corrupt', diaries: [] };
    }
    diaries.push(normalized);
  }
  return { status: 'ok', diaries };
}

export async function getDiaries() {
  const { diaries } = await getDiariesStatus();
  return diaries;
}

async function readDiariesForMutation() {
  const { status, diaries } = await getDiariesStatus();
  if (status === 'corrupt') {
    throw new Error('日记读取失败，请稍后重试');
  }
  return diaries;
}

async function writeDiaryCollection(diaries) {
  const list = (Array.isArray(diaries) ? diaries : [])
    .map(normalizeDiaryEntry)
    .filter(item => item.id && item.characterId && item.date);
  const ids = list.map(item => item.id);
  if (list.length > 0) {
    await AsyncStorage.multiSet(list.map(item => [diaryItemKey(item.id), JSON.stringify(item)]));
  }
  // 索引最后写：它是提交点，写成功即代表这一批条目已经落盘。
  await AsyncStorage.setItem(DIARY_INDEX_KEY, JSON.stringify(ids));
  // 清理索引里已不存在的旧条目，避免删除后残留在存储里。
  try {
    const keys = await AsyncStorage.getAllKeys();
    const active = new Set(ids);
    const stale = (Array.isArray(keys) ? keys : []).filter(key => (
      String(key).startsWith(`${DIARY_ITEM_PREFIX}::`)
      && !String(key).endsWith(CORRUPT_BACKUP_SUFFIX)
      && !active.has(String(key).slice(`${DIARY_ITEM_PREFIX}::`.length))
    ));
    if (stale.length > 0) await AsyncStorage.multiRemove(stale);
  } catch (error) {}
  return list;
}

export function saveDiaries(diaries) {
  return enqueueDiaryMutation(async () => {
    await readDiariesForMutation();
    return writeDiaryCollection(diaries);
  });
}

export function updateDiaries(updater) {
  return enqueueDiaryMutation(async () => {
    const current = await readDiariesForMutation();
    const next = typeof updater === 'function' ? await updater(current) : current;
    if (next === undefined) return current;
    return writeDiaryCollection(next);
  });
}

export async function deleteDiariesForCharacterDeletion(characterIds) {
  let removed = 0;
  await updateDiaries(list => {
    const next = removeDiariesForCharacter(list, characterIds);
    removed = (Array.isArray(list) ? list : []).length - next.length;
    return removed > 0 ? next : list;
  });
  return removed;
}