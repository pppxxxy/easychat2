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

async function collectMedia(directory, prefix = '') {
  const root = `${FileSystem.documentDirectory || ''}${directory}/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(`${root}${prefix}`);
  } catch (error) {
    return [];
  }
  const result = [];
  for (const name of entries) {
    const relative = `${prefix}${name}`;
    const uri = `${root}${relative}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.isDirectory) {
      result.push(...await collectMedia(directory, `${relative}/`));
    } else {
      try {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        result.push({ path: `${directory}/${relative}`, base64 });
      } catch (error) {}
    }
  }
  return result;
}

export async function exportBackup({ appVersion = '' } = {}) {
  const keys = await AsyncStorage.getAllKeys();
  const storage = [];
  for (const key of keys.filter(item => item.startsWith(MANAGED_PREFIX) && !item.endsWith(CORRUPT_SUFFIX))) {
    const value = await readRawValue(key);
    if (value !== undefined) storage.push({ key, value });
  }
  const media = [];
  for (const directory of ['avatars', 'stickers', 'chat-images', 'voice', 'characters', 'card-forge']) {
    media.push(...await collectMedia(directory));
  }
  const payload = buildBackupPayload({ storage, media, appVersion });
  const json = JSON.stringify(payload);
  if (utf8ByteLength(json) > BACKUP_MAX_BYTES) {
    throw new Error(`备份文件过大，当前上限为 ${Math.round(BACKUP_MAX_BYTES / 1024 / 1024)}MB`);
  }
  const uri = `${FileSystem.documentDirectory}easychat2-backup-${Date.now()}.json`;
  await FileSystem.writeAsStringAsync(uri, json);
  return { uri, payload, storageCount: storage.length, mediaCount: media.length, bytes: utf8ByteLength(json) };
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
