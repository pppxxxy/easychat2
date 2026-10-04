// 真实位置存储领域：全局开关（真实地图分享）+ 位置感知开关 + 最近一次成功位置 + 可选瓦片模板。
// 与网格地图（@easychat2_world_map）完全分离，互不影响。数据量小，整体存一个键；
// 损坏时先备份再回落默认，避免下次保存覆盖损坏内容。
//
// 双开关语义（隐私门控）：enabled = 真实地图分享（本地标注），awareness = 位置感知
// （把模糊位置随对话发给角色）。**只有两者同时开启才注入对话**；awareness 是纯
// opt-in，缺省 false——不给「开启地图即默认对外分享」留后门。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

export const LOCATION_KEY = '@easychat2_location';

const locationMutation = createMutationQueue();

function normalizeCoordinates(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const latitude = Number(source.latitude);
  const longitude = Number(source.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude === 0 && longitude === 0) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

export function normalizeLocationSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const coordinates = normalizeCoordinates(source.last);
  return {
    enabled: source.enabled === true,
    // 位置感知：纯 opt-in（缺省/false 一律关闭）。旧数据没有该字段时同样关闭——
    // 升级后「角色不再自动知道位置」，需要用户到设置里显式打开（隐私默认从严）。
    awareness: source.awareness === true,
    last: coordinates
      ? {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        description: String((source.last && source.last.description) || '').trim().slice(0, 120),
        coarse: String((source.last && source.last.coarse) || '').trim().slice(0, 120),
        updatedAt: Math.max(0, Math.floor(Number(source.last && source.last.updatedAt)) || 0),
      }
      : null,
    tileUrl: String(source.tileUrl || '').trim(),
  };
}

export async function getLocationSettings() {
  const stored = await readJsonStatus(LOCATION_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(LOCATION_KEY);
    return normalizeLocationSettings(null);
  }
  return normalizeLocationSettings(stored.value);
}

export async function saveLocationSettings(settings) {
  const normalized = normalizeLocationSettings(settings);
  await AsyncStorage.setItem(LOCATION_KEY, JSON.stringify(normalized));
  return normalized;
}

export function updateLocationSettings(updater) {
  return locationMutation.enqueue(async () => {
    const stored = await readJsonStatus(LOCATION_KEY);
    if (stored.status === 'corrupt') {
      await backupCorruptValue(LOCATION_KEY);
      throw new Error('位置设置读取失败，请稍后重试');
    }
    const current = normalizeLocationSettings(stored.value);
    const next = typeof updater === 'function' ? await updater(current) : current;
    const normalized = normalizeLocationSettings(next === undefined ? current : next);
    await AsyncStorage.setItem(LOCATION_KEY, JSON.stringify(normalized));
    return normalized;
  });
}

export function setLastLocation(location) {
  return updateLocationSettings(current => ({ ...current, last: location }));
}
