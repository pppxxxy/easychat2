// 好感度存储领域。从 src/storage.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';
import { onCharacterDeleted } from './characterLifecycle.js';

const AFFINITY_KEY = '@easychat2_affinity';

// 好感度是**单键整表**：saveAffinity 整表覆盖，删角色的钩子是读-改-写。
// 两条链不串行就会交错——钩子读到旧表、整表写入插在中间、钩子再把旧表写回去，
// 把刚存的好感度整个覆盖掉。所有写入都走这条队列。
const affinityMutation = createMutationQueue();

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

export function saveAffinity(map) {
  return affinityMutation.enqueue(async () => {
    const normalized = normalizeAffinityState(map);
    await AsyncStorage.setItem(AFFINITY_KEY, JSON.stringify(normalized));
    return normalized;
  });
}

// 删除角色时清掉它的好感度条目。注册到角色生命周期（见 characterLifecycle.js）——
// 此前这条清理不存在：删角色后 @easychat2_affinity 里的数据永久残留（孤儿数据）。
// 读-改-写必须在队列里：与 saveAffinity 的整表覆盖串行，否则会把并发保存的改动写回旧值。
function removeAffinityForCharacters(characterIds) {
  const ids = new Set((Array.isArray(characterIds) ? characterIds : []).map(id => String(id || '')));
  if (ids.size === 0) return Promise.resolve();
  return affinityMutation.enqueue(async () => {
    const stored = await readJsonStatus(AFFINITY_KEY);
    if (stored.status !== 'ok' || !stored.value || typeof stored.value !== 'object') return;
    const map = normalizeAffinityState(stored.value);
    let changed = false;
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(map, id)) {
        delete map[id];
        changed = true;
      }
    }
    if (changed) await AsyncStorage.setItem(AFFINITY_KEY, JSON.stringify(map));
  });
}

onCharacterDeleted('affinity', removeAffinityForCharacters);