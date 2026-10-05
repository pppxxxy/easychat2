// 位置存储域：用户自己写的「位置」清单（可增删改、一次用一个）+ 分享开关 + 位置感知开关
// + 可选瓦片模板。与网格地图（@easychat2_world_map）完全分离，互不影响；数据量小，
// 整体存一个键，损坏时先备份再回落默认，避免下次保存覆盖损坏内容。
//
// 设计变更（用户裁决）：**不再读取系统定位**（无权限、无取点）——位置完全由用户手写，
// 可以是真实地名，也可以是虚构地点（例：霍格沃茨魔法学院）。老版本存过的真实定位
// （last）在归一化时迁移成清单里的第一条，不丢用户数据。
//
// 双开关语义（隐私门控）：enabled = 把选中的位置分享给角色（本地地图始终标注，不受它影响），
// awareness = 位置感知（随对话发给角色）。**只有两者同时开启才注入对话**。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

export const LOCATION_KEY = '@easychat2_location';
// 清单上限：手写的小数据，但入口在手机上，过多会让列表难用。
export const PLACE_LIMIT = 20;
const PLACE_NAME_MAX = 60;

const locationMutation = createMutationQueue();

function clampCoordinate(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < min || number > max) return null;
  return number;
}

// 位置坐标（可选）：两个都合法才认，只填一个按「没填」处理——不落半个坐标。
function normalizePlaceCoordinates(source) {
  const latitude = clampCoordinate(source && source.latitude, -90, 90);
  const longitude = clampCoordinate(source && source.longitude, -180, 180);
  if (latitude === null || longitude === null) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

// 单条位置：名称必填（无名的条目直接丢弃）；坐标可选，留空 = 只把文字分享给角色。
export function normalizePlace(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = String(source.name || '').trim().slice(0, PLACE_NAME_MAX);
  if (!name) return null;
  const id = String(source.id || '').trim().slice(0, 64) || `place-${index + 1}`;
  const coordinates = normalizePlaceCoordinates(source);
  return {
    id,
    name,
    latitude: coordinates ? coordinates.latitude : null,
    longitude: coordinates ? coordinates.longitude : null,
    updatedAt: Math.max(0, Math.floor(Number(source.updatedAt)) || 0),
  };
}

// 首次使用时的示例条目由界面写入（名称要跟当前语言，见 RealMapView 的 seedExamplePlaces），
// 存储层只负责保存与归一化——这里不硬编码地名。

// 老版本的「最近一次真实定位」→ 普通位置条目（名称优先用描述，退坐标文本）。
function legacyPlaceFrom(raw) {
  const source = raw && typeof raw === 'object' ? raw : null;
  if (!source) return null;
  const coordinates = normalizePlaceCoordinates(source);
  const description = String(source.description || '').trim().slice(0, PLACE_NAME_MAX);
  const name = description || (coordinates
    ? `${coordinates.latitude.toFixed(4)}, ${coordinates.longitude.toFixed(4)}`
    : '');
  if (!name) return null;
  return {
    id: 'place-legacy',
    name,
    latitude: coordinates ? coordinates.latitude : null,
    longitude: coordinates ? coordinates.longitude : null,
    updatedAt: Math.max(0, Math.floor(Number(source.updatedAt)) || 0),
  };
}

export function normalizeLocationSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hasPlaces = Array.isArray(source.places);
  let places;
  if (hasPlaces) {
    places = source.places.map((item, index) => normalizePlace(item, index)).filter(Boolean);
  } else {
    // 老数据：有过真实定位就迁成一条普通位置（那是用户自己的数据）；
    // 没有就给空清单，由界面在首次进入时按当前语言写入示例。
    const legacy = legacyPlaceFrom(source.last);
    places = legacy ? [legacy] : [];
  }
  // 同 id 只留第一条：脏数据带重复 id 会让单选与编辑指向两条不同条目。
  places = places
    .filter((item, index, list) => list.findIndex(other => other.id === item.id) === index)
    .slice(0, PLACE_LIMIT);
  const requested = String(source.activePlaceId || '').trim();
  return {
    enabled: source.enabled === true,
    // 位置感知：纯 opt-in（缺省/false 一律关闭）。
    awareness: source.awareness === true,
    places,
    // 选中项失效（被删/不存在）时回落到第一条，避免指向已经不存在的条目。
    activePlaceId: places.some(item => item.id === requested)
      ? requested
      : (places[0] ? places[0].id : ''),
    // 示例条目是否已经写过：写一次就永久为 true，用户删光后不再自动冒出来。
    seeded: source.seeded === true,
    tileUrl: String(source.tileUrl || '').trim(),
  };
}

// 新增或替换一条位置（纯函数，便于直测）：id 已存在 = 编辑，否则追加。
// 保存后自动选中它——用户刚写的那个位置就是他此刻要用的。
export function upsertPlace(settings, place, { now = Date.now() } = {}) {
  const current = normalizeLocationSettings(settings);
  const next = normalizePlace({
    ...(place && typeof place === 'object' ? place : {}),
    id: String((place && place.id) || '').trim() || `place-${now.toString(36)}`,
    updatedAt: now,
  }, current.places.length);
  if (!next) return current;
  const exists = current.places.some(item => item.id === next.id);
  const places = exists
    ? current.places.map(item => (item.id === next.id ? next : item))
    : [...current.places, next].slice(0, PLACE_LIMIT);
  return { ...current, places, activePlaceId: next.id };
}

// 删除一条位置（纯函数）：删掉的正是选中项时回落到第一条。
export function removePlace(settings, placeId) {
  const current = normalizeLocationSettings(settings);
  const id = String(placeId || '').trim();
  const places = current.places.filter(item => item.id !== id);
  return {
    ...current,
    places,
    activePlaceId: places.some(item => item.id === current.activePlaceId)
      ? current.activePlaceId
      : (places[0] ? places[0].id : ''),
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
