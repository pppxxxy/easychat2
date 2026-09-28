// 世界地图存储领域。从 src/storage.js 原样外提（无行为变化）。
// 地图是「40×40 网格上的房子」列表，数据量小，整体存一个键；损坏时先备份。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { detachCharacterFromMap, normalizeMapHouses } from '../worldMap/map.js';
import { backupCorruptValue, readJsonStatus } from './io.js';

const WORLD_MAP_KEY = '@easychat2_world_map';

let worldMapWriteQueue = Promise.resolve();

function enqueueWorldMapMutation(task) {
  const next = worldMapWriteQueue.then(task, task);
  worldMapWriteQueue = next.catch(() => {});
  return next;
}

export async function getWorldMapStatus() {
  const stored = await readJsonStatus(WORLD_MAP_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(WORLD_MAP_KEY);
    return { status: 'corrupt', houses: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', houses: [] };
  return { status: 'ok', houses: normalizeMapHouses(stored.value) };
}

export async function getWorldMap() {
  const { houses } = await getWorldMapStatus();
  return houses;
}

export function updateWorldMap(updater) {
  return enqueueWorldMapMutation(async () => {
    const { status, houses } = await getWorldMapStatus();
    // 读失败就抛错中止：绝不用空列表覆盖已有地图。
    if (status === 'corrupt') {
      throw new Error('地图读取失败，请稍后重试');
    }
    const next = typeof updater === 'function' ? await updater(houses) : houses;
    const normalized = normalizeMapHouses(next === undefined ? houses : next);
    await AsyncStorage.setItem(WORLD_MAP_KEY, JSON.stringify(normalized));
    return normalized;
  });
}

export async function detachCharacterFromWorldMap(characterIds) {
  return updateWorldMap(houses => detachCharacterFromMap(houses, characterIds));
}