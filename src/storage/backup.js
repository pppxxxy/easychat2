// 全量备份恢复编排：使用现有 AsyncStorage/FileSystem 与大值读取边界。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';

import {
  BACKUP_MAX_BYTES,
  BACKUP_MEDIA_DIRECTORIES,
  buildBackupPayload,
  planBackupImport,
} from './dataBackup.js';
import { recordDiagnostic } from './diagnostics.js';
import { tActive } from '../i18n/index.js';
import { readJsonStatus, readLargeAsyncStorageValue } from './io.js';
import { createBackupChunkGenerator } from './backupStream.js';

const MANAGED_PREFIX = '@easychat2_';
const CORRUPT_SUFFIX = '__corrupt_backup';

// 媒体目录清单：**唯一权威是 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES**，这里只
// re-export 同一个对象（不是副本、不是第二份字面量数组）。
// 为什么必须只有一份：打包（buildBackupPayload）与导入校验（validateBackupPayload）都
// 用 dataBackup.js 那份白名单，而本文件历史上另手写了一份；两份漂移后 `music`/`books`
// 被 isAllowedMediaPath 静默过滤——用户的音乐库与书籍不进备份，恢复时才发现，且不可逆。
// 新增/移除媒体目录请**只改 dataBackup.js**：那里逐项注明产出方模块与常量，并写明
// 刻意排除的目录（screen-watch/、local-models/、.transcripts/、workspace/）及各自理由。
// tests/storageBackup.test.mjs 断言两边是同一个对象，并逐条比对产出方常量。
export { BACKUP_MEDIA_DIRECTORIES };

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
  // readJsonStatus 在 getItem 抛错或 JSON.parse 失败时已经调用过
  // readLargeAsyncStorageValue 兜底读取；这里再读一次是重复的昂贵 SQLite 全值读取。
  const status = await readJsonStatus(key);
  if (status.status === 'ok') return { value: status.value };
  // 结构损坏但拿到了原始串：交给导出侧以 opaqueRaw 抢救，避免静默丢弃。
  if (status.status === 'corrupt' && typeof status.raw === 'string') {
    return { opaqueRaw: status.raw };
  }
  return {};
}

async function readRawStorageString(key) {
  try {
    return await AsyncStorage.getItem(key);
  } catch (error) {
    const recovered = await readLargeAsyncStorageValue(key);
    if (recovered !== null) return recovered;
    throw new Error(tActive('error.backup.restoreReadFailed', { key }));
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
  //
  // 三态口径（P1）：
  // - storage：JSON 结构完好，正常入包；
  // - partialKeys：结构损坏但原始串拿得到，以 opaqueRaw 原样入包（数据不丢，
  //   应用内可能读不出，但恢复时逐字节还原）；
  // - unreadableKeys：真读不出（getItem 抛错 + 大值兜底也 null），只能跳过。
  const unreadableKeys = [];
  const partialKeys = [];
  report('storage', 0, managedKeys.length);
  for (let index = 0; index < managedKeys.length; index += 1) {
    throwIfAborted(signal);
    const key = managedKeys[index];
    const read = await readRawValue(key);
    if (read.value !== undefined) storage.push({ key, value: read.value });
    else if (read.opaqueRaw !== undefined) {
      storage.push({ key, opaqueRaw: read.opaqueRaw });
      partialKeys.push(key);
    } else {
      unreadableKeys.push(key);
    }
    report('storage', index + 1, managedKeys.length);
  }
  // 失败键名必须留痕：弹窗只显示数量、诊断日志此前完全没记录，用户无从排查
  // 是哪个键失败。这里把键名（去前缀前）写进诊断日志，供「诊断日志」回看。
  if (unreadableKeys.length > 0) {
    recordDiagnostic('storage', new Error(tActive('error.backup.exportUnreadable', {
      keys: unreadableKeys.join(', '),
    })), 'backup-export');
  }
  const media = [];
  const unreadableMedia = [];
  report('media', 0, 0);
  let mediaSeen = 0;
  // 目录清单见 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES（全仓唯一一份，新增目录只改那里）。
  for (const directory of BACKUP_MEDIA_DIRECTORIES) {
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
  // 打包层用 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES（isAllowedMediaPath）过滤内容，恢复侧
  // 校验也用同一份：两边现在是**同一个对象**（上面的 re-export），口径已不可能再漂移。
  // 这道「收集数 vs 入包数」的核对仍然保留，作为兜底——将来若有人把清单又拆成两份，被丢掉的
  // 文件会并进 unreadableMedia，让「备份不完整」在导出那一刻就可见，而不是等恢复时才发现
  // 「备份里没有我的书/音乐」（文案说的是「读取失败」，原因措辞略粗，但"文件没进备份"是真的）。
  const packedPaths = new Set(payload.media.map(item => item.path));
  for (const item of media) {
    if (!packedPaths.has(item.path)) unreadableMedia.push(item.path);
  }
  const uri = `${FileSystem.documentDirectory}easychat2-backup-${Date.now()}.json`;
  // 流式写盘：按片序列化 + 逐片写入，避免一次性构造巨型 JSON 串。
  // 打包/写盘阶段保持可取消，并持续上报 writing 进度（已写字节/总字节）。
  const bytes = await writeBackupStream(uri, payload, { signal, report });
  report('done', 1, 1);
  return {
    uri,
    payload,
    storageCount: storage.length,
    mediaCount: media.length,
    bytes,
    unreadableKeys,
    partialKeys,
    unreadableMedia,
    incomplete: unreadableKeys.length > 0 || unreadableMedia.length > 0 || partialKeys.length > 0,
  };
}

// 把 payload 流式写入 uri：分片序列化 → 逐片 writeBytes → 片间检查取消。
// 返回写入的总字节数（与一次性 JSON.stringify 的 UTF-8 字节数一致）。
async function writeBackupStream(uri, payload, { signal, report }) {
  const file = new File(uri);
  if (file.exists) file.delete();
  file.create({ intermediates: true, overwrite: true });
  const handle = file.open();
  let bytes = 0;
  let pieceCount = 0;
  const encoder = new TextEncoder();
  try {
    for (const chunk of createBackupChunkGenerator(payload)) {
      throwIfAborted(signal);
      const encoded = encoder.encode(chunk);
      handle.writeBytes(encoded);
      bytes += encoded.length;
      pieceCount += 1;
      if (bytes > BACKUP_MAX_BYTES) {
        throw new Error(tActive('error.backup.tooLarge', { mb: Math.round(BACKUP_MAX_BYTES / 1024 / 1024) }));
      }
      // 每片之后让出一次事件循环：写盘阶段不再独占主线程，取消能及时生效。
      if (pieceCount % 4 === 0) {
        report('writing', bytes, 0);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    report('writing', bytes, bytes);
    throwIfAborted(signal);
  } catch (error) {
    try {
      handle.close();
    } catch (closeError) {}
    try {
      if (file.exists) file.delete();
    } catch (deleteError) {}
    throw error;
  }
  handle.close();
  return bytes;
}

export async function importBackup(payload, mode = 'merge') {
  const plan = planBackupImport(payload, mode);
  if (!plan.valid) throw new Error(plan.error);
  const storageKeys = plan.storage
    .map(item => item.key)
    .filter(key => key.startsWith(MANAGED_PREFIX) && !key.endsWith(CORRUPT_SUFFIX));
  const storageSnapshot = await snapshotStorageKeys(storageKeys);
  const mediaSnapshot = await snapshotMediaFiles(plan.media);
  let opaqueCount = 0;
  try {
    if (plan.mode === 'replace' && storageKeys.length > 0) {
      // 只清理备份包明确管理的键：读取失败或新版本新增的本机键应保留。
      await AsyncStorage.multiRemove(storageKeys);
    }
    for (const item of plan.storage) {
      // opaqueRaw 条目是结构损坏时抢救下来的原始串：原样写回，不做 parse——
      // 它的价值恰恰在于「应用读不出但字节不丢」，重新序列化会再次损坏。
      if (typeof item.opaqueRaw === 'string') {
        await AsyncStorage.setItem(item.key, item.opaqueRaw);
        opaqueCount += 1;
      } else {
        await AsyncStorage.setItem(item.key, JSON.stringify(item.value));
      }
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
    // 写入失败保留诊断记录，便于在「诊断日志」里回看失败现场（需求 3.5）。
    recordDiagnostic('storage', error, 'importBackup');
    throw error;
  }
  return { storageCount: plan.storage.length, mediaCount: plan.media.length, mode: plan.mode, opaqueCount };
}
