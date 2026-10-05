// 表情包存储领域。从 src/storage.js 原样外提（无行为变化）。
// 采用「索引 + 单条分键」存储；旧版整表键 @easychat2_stickers 为迁移专用。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { markMediaWrite } from './mediaProtection.js';
import { CORRUPT_BACKUP_SUFFIX, backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';
import { tActive } from '../i18n/index.js';

const STICKERS_KEY = '@easychat2_stickers';
const STICKER_INDEX_KEY = '@easychat2_sticker_index';
const STICKER_ITEM_PREFIX = '@easychat2_sticker_item';

const stickerMutation = createMutationQueue();

function stickerItemKey(id) {
  return `${STICKER_ITEM_PREFIX}::${String(id || '')}`;
}

function normalizeSticker(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || '').trim(),
    uri: String(source.uri || ''),
    mime: String(source.mime || 'image/jpeg'),
    width: Number(source.width) || 0,
    height: Number(source.height) || 0,
    createdAt: Number(source.createdAt) || 0,
  };
}

async function readStickerIndexStatus() {
  const stored = await readJsonStatus(STICKER_INDEX_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(STICKER_INDEX_KEY);
    return { status: 'corrupt', ids: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', ids: [] };
  return {
    status: 'ok',
    ids: [...new Set((stored.value || []).map(id => String(id || '')).filter(Boolean))],
  };
}

function sortStickers(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeSticker)
    .filter(item => item.id && item.name && item.uri)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// 保序规范化：校验字段并按首次出现去重，不重排。用于读写已有索引的顺序（用户手动排序后靠它保持）。
function normalizeStickerList(list) {
  const seen = new Set();
  const result = [];
  (Array.isArray(list) ? list : []).forEach(item => {
    const normalized = normalizeSticker(item);
    if (!normalized.id || !normalized.name || !normalized.uri) return;
    if (seen.has(normalized.id)) return;
    seen.add(normalized.id);
    result.push(normalized);
  });
  return result;
}

async function migrateLegacyStickers() {
  const legacy = await readJsonStatus(STICKERS_KEY);
  if (legacy.status === 'missing') return { status: 'missing', stickers: [] };
  if (legacy.status === 'corrupt' || !Array.isArray(legacy.value)) {
    await backupCorruptValue(STICKERS_KEY);
    return { status: 'corrupt', stickers: [] };
  }
  const normalized = legacy.value.map(normalizeSticker);
  if (normalized.some(item => !item.id || !item.name || !item.uri)) {
    await backupCorruptValue(STICKERS_KEY);
    return { status: 'corrupt', stickers: [] };
  }
  const stickers = sortStickers(normalized);
  const ids = [...new Set(stickers.map(item => item.id))];
  if (ids.length > 0) {
    await AsyncStorage.multiSet(stickers.map(item => [stickerItemKey(item.id), JSON.stringify(item)]));
    await AsyncStorage.setItem(STICKER_INDEX_KEY, JSON.stringify(ids));
  } else {
    await AsyncStorage.setItem(STICKER_INDEX_KEY, JSON.stringify([]));
  }
  await AsyncStorage.removeItem(STICKERS_KEY);
  return { status: 'ok', stickers };
}

export async function readStickerStatus() {
  const index = await readStickerIndexStatus();
  if (index.status === 'missing') return migrateLegacyStickers();
  if (index.status !== 'ok') return { status: index.status, stickers: [] };
  const stickers = [];
  for (const id of index.ids) {
    const stored = await readJsonStatus(stickerItemKey(id));
    if (stored.status === 'missing') {
      await backupCorruptValue(stickerItemKey(id));
      return { status: 'corrupt', stickers: [] };
    }
    if (stored.status === 'corrupt' || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) {
      await backupCorruptValue(stickerItemKey(id));
      return { status: 'corrupt', stickers: [] };
    }
    const normalized = normalizeSticker(stored.value);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      await backupCorruptValue(stickerItemKey(id));
      return { status: 'corrupt', stickers: [] };
    }
    stickers.push(normalized);
  }
  const legacy = await readJsonStatus(STICKERS_KEY);
  if (legacy.status !== 'missing') {
    if (legacy.status === 'corrupt' || !Array.isArray(legacy.value)) {
      await backupCorruptValue(STICKERS_KEY);
      return { status: 'ok', stickers: normalizeStickerList(stickers) };
    }
    const normalizedLegacy = legacy.value.map(normalizeSticker);
    if (normalizedLegacy.some(item => !item.id || !item.name || !item.uri)) {
      await backupCorruptValue(STICKERS_KEY);
      return { status: 'ok', stickers: normalizeStickerList(stickers) };
    }
    const byId = new Map(stickers.map(item => [item.id, item]));
    normalizedLegacy.forEach(item => {
      if (!byId.has(item.id)) byId.set(item.id, item);
    });
    const merged = normalizeStickerList([...byId.values()]);
    await writeStickerCollection(merged);
    return { status: 'ok', stickers: merged };
  }
  return { status: 'ok', stickers: normalizeStickerList(stickers) };
}

async function writeStickerCollection(stickers) {
  const list = normalizeStickerList(stickers);
  const ids = list.map(item => item.id);
  if (list.length > 0) {
    await AsyncStorage.multiSet(list.map(item => [stickerItemKey(item.id), JSON.stringify(item)]));
  }
  await AsyncStorage.setItem(STICKER_INDEX_KEY, JSON.stringify(ids));
  await AsyncStorage.removeItem(STICKERS_KEY);
  try {
    const keys = await AsyncStorage.getAllKeys();
    const activeIds = new Set(ids);
    const staleKeys = keys.filter(key => (
      String(key).startsWith(`${STICKER_ITEM_PREFIX}::`)
      && !activeIds.has(String(key).slice(`${STICKER_ITEM_PREFIX}::`.length))
    ));
    if (staleKeys.length > 0) await AsyncStorage.multiRemove(staleKeys);
  } catch (error) {}
}

export function getStickers() {
  return stickerMutation.enqueue(async () => {
    const result = await readStickerStatus();
    return result.stickers;
  });
}

export function isStickerReferenceBackupKey(key) {
  return String(key) === `${STICKER_INDEX_KEY}${CORRUPT_BACKUP_SUFFIX}`;
}

export function saveSticker(sticker) {
  return stickerMutation.enqueue(async () => {
    const normalized = normalizeSticker(sticker);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      throw new Error(tActive('error.storage.stickerInfoIncomplete'));
    }
    markMediaWrite(normalized.uri);
    const result = await readStickerStatus();
    if (result.status === 'corrupt') {
      throw new Error(tActive('error.storage.stickerReadFailed'));
    }
    // 已存在则原位替换（保持用户排序），新增则置顶。
    const exists = result.stickers.some(item => item.id === normalized.id);
    await writeStickerCollection(
      exists
        ? result.stickers.map(item => (item.id === normalized.id ? normalized : item))
        : [normalized, ...result.stickers]
    );
    return normalized;
  });
}

// 批量删除表情包记录，返回 { remaining, removed }；图片文件由调用方用 deleteStickerImage 清理。
export function deleteStickers(ids) {
  const targetIds = new Set((Array.isArray(ids) ? ids : [ids]).map(id => String(id || '')).filter(Boolean));
  return stickerMutation.enqueue(async () => {
    const result = await readStickerStatus();
    if (result.status === 'corrupt') {
      throw new Error(tActive('error.storage.stickerReadFailed'));
    }
    if (targetIds.size === 0) return { remaining: result.stickers, removed: [] };
    const removed = result.stickers.filter(item => targetIds.has(item.id));
    const remaining = result.stickers.filter(item => !targetIds.has(item.id));
    await writeStickerCollection(remaining);
    return { remaining, removed };
  });
}

// 按给定 id 顺序重排（只含存在项，未列出者按原相对顺序补齐），返回新顺序。
export function reorderStickers(orderedIds) {
  const order = (Array.isArray(orderedIds) ? orderedIds : []).map(id => String(id || ''));
  return stickerMutation.enqueue(async () => {
    const result = await readStickerStatus();
    if (result.status === 'corrupt') {
      throw new Error(tActive('error.storage.stickerReadFailed'));
    }
    const byId = new Map(result.stickers.map(item => [item.id, item]));
    const ordered = [];
    order.forEach(id => {
      if (byId.has(id)) {
        ordered.push(byId.get(id));
        byId.delete(id);
      }
    });
    result.stickers.forEach(item => {
      if (byId.has(item.id)) ordered.push(item);
    });
    await writeStickerCollection(ordered);
    return ordered;
  });
}