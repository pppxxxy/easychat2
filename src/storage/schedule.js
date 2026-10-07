// 角色作息存储：按角色保存一份可选的作息（起床/上班/下班/睡觉 + 启用开关）。
// 小而稳定的集合，单键存 map；沿用 readJsonStatus / backupCorruptValue 的损坏兜底。
// 角色删除时清理对应条目（模块内注册钩子，见 storage/characterLifecycle.js）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeSchedule } from '../chat/schedule.js';
import { onCharacterDeleted } from './characterLifecycle.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

export const CHARACTER_SCHEDULES_KEY = '@easychat2_character_schedules';

const scheduleMutation = createMutationQueue();

function normalizeMap(raw) {
  if (raw === null || raw === undefined) return {};
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.keys(source).forEach(key => {
    const id = String(key || '');
    if (!id) return;
    const value = source[key];
    if (!value || typeof value !== 'object') return;
    result[id] = normalizeSchedule(value);
  });
  return result;
}

export async function getAllCharacterSchedules() {
  const stored = await readJsonStatus(CHARACTER_SCHEDULES_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(CHARACTER_SCHEDULES_KEY);
    return {};
  }
  return normalizeMap(stored.status === 'ok' ? stored.value : null);
}

export async function getCharacterSchedule(characterId) {
  const id = String(characterId || '');
  if (!id) return null;
  const all = await getAllCharacterSchedules();
  return all[id] || null;
}

export function saveCharacterSchedule(characterId, schedule) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve(null);
  const normalized = normalizeSchedule(schedule);
  return scheduleMutation.enqueue(async () => {
    const all = await getAllCharacterSchedules();
    await AsyncStorage.setItem(
      CHARACTER_SCHEDULES_KEY,
      JSON.stringify({ ...all, [id]: normalized })
    );
    return normalized;
  });
}

export function deleteCharacterSchedule(characterId) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve(false);
  return scheduleMutation.enqueue(async () => {
    const all = await getAllCharacterSchedules();
    if (!all[id]) return false;
    const next = { ...all };
    delete next[id];
    await AsyncStorage.setItem(CHARACTER_SCHEDULES_KEY, JSON.stringify(next));
    return true;
  });
}

async function deleteCharacterSchedulesInternal(characterIds) {
  const ids = (Array.isArray(characterIds) ? characterIds : []).map(id => String(id || '')).filter(Boolean);
  if (ids.length === 0) return;
  const all = await getAllCharacterSchedules();
  const next = { ...all };
  let changed = false;
  ids.forEach(id => {
    if (next[id]) {
      delete next[id];
      changed = true;
    }
  });
  if (!changed) return;
  await AsyncStorage.setItem(CHARACTER_SCHEDULES_KEY, JSON.stringify(next));
}

// 角色删除时清理其作息（谁的数据谁负责）。
onCharacterDeleted('characterSchedule', deleteCharacterSchedulesInternal);
