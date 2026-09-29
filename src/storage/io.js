// AsyncStorage I/O 原语与含密钥配置的读写包装。从 src/storage.js 原样外提（无行为变化）。
// 拆出的目的是让各领域存储模块（characters/sessions/...）复用同一套读写与损坏备份逻辑。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { hydrateSecrets, protectSecrets } from '../secretStore.js';
import { recordDiagnostic } from '../diagnostics.js';

export const CORRUPT_BACKUP_SUFFIX = '__corrupt_backup';

// 序列化后的 UTF-8 字节数。角色卡与制卡草稿都按「超过阈值则落文件」处理，共用此纯函数。
export function utf8ByteLength(text) {
  const value = String(text || '');
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export async function readJson(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

// 含密钥的配置统一走这两个入口：写盘前把密钥搬进安全存储并落引用，
// 读盘后把引用回填为明文。命名空间用存储键，保证同一字段位置稳定。
export async function setJsonWithSecrets(key, payload) {
  const protectedPayload = await protectSecrets(key, payload);
  await AsyncStorage.setItem(key, JSON.stringify(protectedPayload));
}

export async function readJsonWithSecrets(key, fallback) {
  const value = await readJson(key, fallback);
  return hydrateSecrets(key, value);
}

export async function readJsonStatusWithSecrets(key) {
  const stored = await readJsonStatus(key);
  if (stored.status !== 'ok') return stored;
  return { status: 'ok', value: await hydrateSecrets(key, stored.value) };
}

let sqliteModule;
export function getSqliteModule() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = require('expo-sqlite');
  } catch (error) {
    sqliteModule = null;
  }
  return sqliteModule;
}

export async function readLargeAsyncStorageValue(key) {
  const SQLite = getSqliteModule();
  if (!SQLite || typeof SQLite.openDatabase !== 'function') return null;
  const source = `${FileSystem.documentDirectory || ''}../databases/RKStorage`;
  try {
    const info = await FileSystem.getInfoAsync(source);
    if (!info || !info.exists) return null;
  } catch (error) {
    return null;
  }
  let database = null;
  try {
    database = SQLite.openDatabase('../../databases/RKStorage');
    const lengthResult = await database.execAsync([{
      sql: 'SELECT length(value) AS total FROM catalystLocalStorage WHERE key = ?',
      args: [key],
    }], true);
    const total = Number(lengthResult?.[0]?.rows?.[0]?.total);
    if (!Number.isFinite(total) || total <= 0) return null;
    const chunkSize = 256 * 1024;
    let value = '';
    for (let offset = 0; offset < total; offset += chunkSize) {
      const result = await database.execAsync([{
        sql: 'SELECT substr(value, ?, ?) AS chunk FROM catalystLocalStorage WHERE key = ?',
        args: [offset + 1, chunkSize, key],
      }], true);
      const chunk = result?.[0]?.rows?.[0]?.chunk;
      if (chunk == null) return null;
      value += String(chunk);
    }
    return value;
  } catch (error) {
    return null;
  } finally {
    if (database && typeof database.closeAsync === 'function') {
      try {
        await database.closeAsync();
      } catch (error) {}
    }
  }
}

export async function readJsonStatus(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    return { status: 'ok', value: JSON.parse(raw) };
  } catch (error) {
    const recovered = await readLargeAsyncStorageValue(key);
    if (recovered !== null) {
      try {
        return { status: 'ok', value: JSON.parse(recovered) };
      } catch (parseError) {}
    }
    return { status: 'corrupt' };
  }
}

// 存储损坏时先把原始内容另存一份再重建：直接用默认值覆盖是不可逆的，
// 留一份副本至少给用户（或后续版本）留下人工恢复的机会。
export async function backupCorruptValue(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return false;
    await AsyncStorage.setItem(`${key}${CORRUPT_BACKUP_SUFFIX}`, raw);
    recordDiagnostic('storage', new Error('读取失败或结构异常，已备份原始值'), key);
    if (__DEV__) {
      console.warn(`[storage] ${key} 读取失败或结构异常，已备份到 ${key}${CORRUPT_BACKUP_SUFFIX}`);
    }
    return true;
  } catch (error) {
    recordDiagnostic('storage', error, `损坏数据备份失败：${key}`);
    if (__DEV__) console.warn(`[storage] ${key} 损坏数据备份失败`, error);
    return false;
  }
}