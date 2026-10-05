// 真实位置存储领域：全局开关（真实地图分享）+ 位置感知开关 + 最近一次成功位置
// + 我标注的位置点 + 可选瓦片模板。
// 与网格地图（@easychat2_world_map）完全分离，互不影响。数据量小，整体存一个键；
// 损坏时先备份再回落默认，避免下次保存覆盖损坏内容。
//
// 双开关语义（隐私门控）：enabled = 真实地图分享（本地标注），awareness = 位置感知
// （把模糊位置随对话发给角色）。**只有两者同时开启才注入对话**；awareness 是纯
// opt-in，缺省 false——不给「开启地图即默认对外分享」留后门。
//
// 位置点（locations）与 last 的关系：last 是 GPS 取到的「当前定位」；locations 是
// 用户在地图上手工标出的「我的位置」，可多个、可命名、不随定位刷新而丢失。
// activeLocationId 指向当前选中查看的那个标注点，null/空表示看 GPS 当前位置。
// 标注点同样只用于本地地图显示，不进对话注入（注入仍走 last 的时效判定）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';
import { tActive } from '../i18n/index.js';

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

export function makeLocationId(now = Date.now()) {
  return `loc-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 单个标注点的规范化：坐标非法/零坐标/越界一律丢弃（返回 null），名称截断到 40 字。
function normalizeNamedLocation(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const coordinates = normalizeCoordinates(source);
  if (!coordinates) return null;
  const createdAt = Number(source.createdAt);
  return {
    id: String(source.id || '').trim().slice(0, 120) || makeLocationId(createdAt > 0 ? createdAt : Date.now()),
    name: String(source.name || '').trim().slice(0, 40),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    createdAt: Math.max(0, Math.floor(createdAt) || 0),
  };
}

export function normalizeLocationSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const coordinates = normalizeCoordinates(source.last);
  // 标注点列表：逐条规范化、丢掉坏数据、按 id 去重（保序保留第一条）。
  const seenIds = new Set();
  const locations = (Array.isArray(source.locations) ? source.locations : [])
    .map(normalizeNamedLocation)
    .filter(Boolean)
    .filter(item => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });
  const activeLocationId = String(source.activeLocationId || '').trim().slice(0, 120);
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
    locations,
    // 选中的标注点必须真实存在，否则回落 null（看 GPS 当前位置）——
    // 避免删掉点之后 activeLocationId 指向幽灵 id。
    activeLocationId: locations.some(item => item.id === activeLocationId) ? activeLocationId : '',
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
      throw new Error(tActive('error.storage.locationSettingsReadFailed'));
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

export function getNamedLocations() {
  return getLocationSettings().then(settings => settings.locations);
}

// 新增一个标注点并设为当前选中。id 缺省时生成；同名不去重（同名不同点合法）。
// 坐标非法时返回 rejected promise（而不是同步抛）：本模块其余 API 全是异步的，
// 调用方统一用 try/catch 接错误即可，不用再多包一层。
export async function addNamedLocation(location, now = Date.now()) {
  const entry = normalizeNamedLocation({ ...location, id: location && location.id, createdAt: now });
  if (!entry) throw new Error(tActive('error.storage.locationPinInvalid'));
  return updateLocationSettings(current => ({
    ...current,
    locations: [...current.locations, entry],
    activeLocationId: entry.id,
  }));
}

export function removeNamedLocation(id) {
  const target = String(id || '').trim();
  if (!target) return getLocationSettings();
  return updateLocationSettings(current => ({
    ...current,
    locations: current.locations.filter(item => item.id !== target),
    // 只删掉的正好是当前选中项时才清空选中；否则保留别人的选中状态。
    activeLocationId: current.activeLocationId === target ? '' : current.activeLocationId,
  }));
}

export function setActiveLocationId(id) {
  const target = String(id || '').trim();
  return updateLocationSettings(current => ({
    ...current,
    activeLocationId: current.locations.some(item => item.id === target) ? target : '',
  }));
}
