// 全量备份恢复编排：使用现有 AsyncStorage/FileSystem 与大值读取边界。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import {
  BACKUP_MAX_BYTES,
  buildBackupPayload,
  planBackupImport,
} from '../dataBackup.js';
import { readJsonStatus, readLargeAsyncStorageValue, utf8ByteLength } from './io.js';

const MANAGED_PREFIX = '@easychat2_';
const CORRUPT_SUFFIX = '__corrupt_backup';

function createAbortError() {
  const error = new Error('导出已取消');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw createAbortError();
}

async function readRawValue(key) {
  const status = await readJsonStatus(key);
  if (status.status === 'ok') return status.value;
  if (status.status === 'corrupt') {
    const raw = await readLargeAsyncStorageValue(key);
    if (raw !== null) {
      try {
        return JSON.parse(raw);
      } catch (error) {}
    }
  }
  return undefined;
}

async function readRawStorageString(key) {
  try {
    return await AsyncStorage.getItem(key);
  } catch (error) {
    const recovered = await readLargeAsyncStorageValue(key);
    if (recovered !== null) return recovered;
    throw new Error(`无法读取待恢复数据：${key}`);
  }
}

async function snapshotStorageKeys(keys) {
  const snapshot = [];
  for (const key of keys) {
    const raw = await readRawStorageString(key);
    snapshot.push({ key, raw, exists: raw !== null && raw !== undefined });
  }
  return snapshot;
}

async function snapshotMediaFiles(items) {
  const snapshot = [];
  for (const item of items) {
    const uri = `${FileSystem.documentDirectory}${item.path}`;
    const info = await FileSystem.getInfoAsync(uri);
    let base64 = null;
    if (info && info.exists && !info.isDirectory) {
      base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    snapshot.push({ path: item.path, uri, exists: Boolean(base64 !== null), base64 });
  }
  return snapshot;
}

async function rollbackStorage(snapshot) {
  for (const item of snapshot) {
    if (item.exists) await AsyncStorage.setItem(item.key, item.raw);
    else await AsyncStorage.removeItem(item.key);
  }
}

async function rollbackMedia(snapshot) {
  for (const item of snapshot) {
    if (item.exists) {
      const parent = item.uri.slice(0, item.uri.lastIndexOf('/'));
      await FileSystem.makeDirectoryAsync(`${parent}/`, { intermediates: true });
      await FileSystem.writeAsStringAsync(item.uri, item.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } else {
      await FileSystem.deleteAsync(item.uri, { idempotent: true });
    }
  }
}

async function collectMedia(directory, prefix = '', hooks = {}) {
  const root = `${FileSystem.documentDirectory || ''}${directory}/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(`${root}${prefix}`);
  } catch (error) {
    return { items: [], failed: [] };
  }
  const items = [];
  const failed = [];
  for (const name of entries) {
    if (hooks.signal && hooks.signal.aborted) throw createAbortError();
    const relative = `${prefix}${name}`;
    const uri = `${root}${relative}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.isDirectory) {
      const nested = await collectMedia(directory, `${relative}/`, hooks);
      items.push(...nested.items);
      failed.push(...nested.failed);
    } else {
      try {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        items.push({ path: `${directory}/${relative}`, base64 });
      } catch (error) {
        failed.push(`${directory}/${relative}`);
      }
      if (typeof hooks.onFile === 'function') hooks.onFile();
    }
  }
  return { items, failed };
}

export async function exportBackup({ appVersion = '', onProgress, signal } = {}) {
  const report = (phase, done, total) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress({ phase, done, total });
      } catch (error) {}
    }
  };
  throwIfAborted(signal);
  const keys = await AsyncStorage.getAllKeys();
  const managedKeys = keys.filter(item => item.startsWith(MANAGED_PREFIX) && !item.endsWith(CORRUPT_SUFFIX));
  const storage = [];
  // 记录读不出的键：数据恰好损坏时最需要备份，静默跳过会让用户拿到一份
  // “看起来成功、实则残缺”的备份。这里统计并回传给 UI 明确提示。
  const unreadableKeys = [];
  report('storage', 0, managedKeys.length);
  for (let index = 0; index < managedKeys.length; index += 1) {
    throwIfAborted(signal);
    const key = managedKeys[index];
    const value = await readRawValue(key);
    if (value !== undefined) storage.push({ key, value });
    else unreadableKeys.push(key);
    report('storage', index + 1, managedKeys.length);
  }
  const media = [];
  const unreadableMedia = [];
  report('media', 0, 0);
  let mediaSeen = 0;
  for (const directory of ['avatars', 'stickers', 'chat-images', 'voice', 'characters', 'card-forge']) {
    throwIfAborted(signal);
    const collected = await collectMedia(directory, '', {
      signal,
      onFile: () => {
        mediaSeen += 1;
        report('media', mediaSeen, 0);
      },
    });
    media.push(...collected.items);
    unreadableMedia.push(...collected.failed);
  }
  throwIfAborted(signal);
  report('packing', 0, 0);
  const payload = buildBackupPayload({ storage, media, appVersion });
  const json = JSON.stringify(payload);
  // 只做一次字节统计，上限判断与回传复用同一结果（原实现对整包字符串扫了两遍，
  // 大备份时是纯 CPU 的双倍开销）。
  const bytes = utf8ByteLength(json);
  if (bytes > BACKUP_MAX_BYTES) {
    throw new Error(`备份文件过大，当前上限为 ${Math.round(BACKUP_MAX_BYTES / 1024 / 1024)}MB`);
  }
  throwIfAborted(signal);
  report('writing', 0, 0);
  const uri = `${FileSystem.documentDirectory}easychat2-backup-${Date.now()}.json`;
  await FileSystem.writeAsStringAsync(uri, json);
  report('done', 1, 1);
  return {
    uri,
    payload,
    storageCount: storage.length,
    mediaCount: media.length,
    bytes,
    unreadableKeys,
    unreadableMedia,
    incomplete: unreadableKeys.length > 0 || unreadableMedia.length > 0,
  };
}

export async function importBackup(payload, mode = 'merge') {
  const plan = planBackupImport(payload, mode);
  if (!plan.valid) throw new Error(plan.error);
  const storageKeys = plan.storage
    .map(item => item.key)
    .filter(key => key.startsWith(MANAGED_PREFIX) && !key.endsWith(CORRUPT_SUFFIX));
  const storageSnapshot = await snapshotStorageKeys(storageKeys);
  const mediaSnapshot = await snapshotMediaFiles(plan.media);
  try {
    if (plan.mode === 'replace' && storageKeys.length > 0) {
      // 只清理备份包明确管理的键：读取失败或新版本新增的本机键应保留。
      await AsyncStorage.multiRemove(storageKeys);
    }
    for (const item of plan.storage) {
      await AsyncStorage.setItem(item.key, JSON.stringify(item.value));
    }
    for (const item of plan.media) {
      const uri = `${FileSystem.documentDirectory}${item.path}`;
      const parent = uri.slice(0, uri.lastIndexOf('/'));
      await FileSystem.makeDirectoryAsync(`${parent}/`, { intermediates: true });
      await FileSystem.writeAsStringAsync(uri, item.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
  } catch (error) {
    try {
      await rollbackStorage(storageSnapshot);
      await rollbackMedia(mediaSnapshot);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
  return { storageCount: plan.storage.length, mediaCount: plan.media.length, mode: plan.mode };
}
