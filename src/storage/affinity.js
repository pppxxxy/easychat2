// 好感度存储领域。从 src/storage.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, readJsonStatus } from './io.js';

const AFFINITY_KEY = '@easychat2_affinity';

function normalizeAffinityState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.entries(source).forEach(([id, value]) => {
    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    result[String(id)] = {
      score: Number(entry.score) || 0,
      turnCount: Number(entry.turnCount) || 0,
      triggers: Array.isArray(entry.triggers)
        ? entry.triggers.filter(item => typeof item === 'string')
        : [],
    };
  });
  return result;
}

export async function getAffinityStatus() {
  const stored = await readJsonStatus(AFFINITY_KEY);
  const isBadObject = stored.status === 'ok'
    && (!stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value));
  if (stored.status === 'corrupt' || isBadObject) {
    await backupCorruptValue(AFFINITY_KEY);
    return { status: 'corrupt', map: {} };
  }
  if (stored.status === 'missing') return { status: 'missing', map: {} };
  return { status: 'ok', map: normalizeAffinityState(stored.value) };
}

export async function saveAffinity(map) {
  const normalized = normalizeAffinityState(map);
  await AsyncStorage.setItem(AFFINITY_KEY, JSON.stringify(normalized));
  return normalized;
}