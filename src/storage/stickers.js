// 表情包存储领域。从 src/storage.js 原样外提（无行为变化）。
// 采用「索引 + 单条分键」存储；旧版整表键 @easychat2_stickers 为迁移专用。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { markMediaWrite } from '../mediaProtection.js';
import { CORRUPT_BACKUP_SUFFIX, backupCorruptValue, readJsonStatus } from './io.js';

const STICKERS_KEY = '@easychat2_stickers';
const STICKER_INDEX_KEY = '@easychat2_sticker_index';
const STICKER_ITEM_PREFIX = '@easychat2_sticker_item';

let stickerWriteQueue = Promise.resolve();

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
      return { status: 'ok', stickers: sortStickers(stickers) };
    }
    const normalizedLegacy = legacy.value.map(normalizeSticker);
    if (normalizedLegacy.some(item => !item.id || !item.name || !item.uri)) {
      await backupCorruptValue(STICKERS_KEY);
      return { status: 'ok', stickers: sortStickers(stickers) };
    }
    const byId = new Map(stickers.map(item => [item.id, item]));
    normalizedLegacy.forEach(item => {
      if (!byId.has(item.id)) byId.set(item.id, item);
    });
    const merged = sortStickers([...byId.values()]);
    await writeStickerCollection(merged);
    return { status: 'ok', stickers: merged };
  }
  return { status: 'ok', stickers: sortStickers(stickers) };
}

async function writeStickerCollection(stickers) {
  const list = sortStickers(stickers).filter(
    (item, index, all) => all.findIndex(other => other.id === item.id) === index
  );
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
  const task = stickerWriteQueue.then(async () => {
    const result = await readStickerStatus();
    return result.stickers;
  });
  stickerWriteQueue = task.catch(() => {});
  return task;
}

export function isStickerReferenceBackupKey(key) {
  return String(key) === `${STICKER_INDEX_KEY}${CORRUPT_BACKUP_SUFFIX}`;
}

export function saveSticker(sticker) {
  const task = stickerWriteQueue.then(async () => {
    const normalized = normalizeSticker(sticker);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      throw new Error('表情包信息不完整');
    }
    markMediaWrite(normalized.uri);
    const result = await readStickerStatus();
    if (result.status === 'corrupt') {
      throw new Error('表情包记录读取失败，请稍后重试');
    }
    await writeStickerCollection([
      normalized,
      ...result.stickers.filter(item => item.id !== normalized.id),
    ]);
    return normalized;
  });
  stickerWriteQueue = task.catch(() => {});
  return task;
}