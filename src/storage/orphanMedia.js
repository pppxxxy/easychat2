// 孤儿媒体回收（2026-10-07 快赢1 自 storage.js 门面迁出）。
//
// collectStickerImageFiles / collectAvatarImageFiles / collectOrphanImageFiles：
// 清理不再被引用的贴纸与头像文件。误删不可逆，所以三道保险：
// 1. 存在损坏备份键（CORRUPT_BACKUP_SUFFIX）→ 直接放弃本次回收；
// 2. 媒体写修订号不新鲜（期间有过写入）→ 放弃；
// 3. 文件落在宽限窗内（recentUris / mtime 双保险）→ 跳过。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { CORRUPT_BACKUP_SUFFIX } from './io.js';
import {
  getMediaWriteRevision,
  isMediaWriteRevisionCurrent,
  isRecentMediaUri,
  isRecentlyModifiedFile,
} from './mediaProtection.js';
import { isStickerReferenceBackupKey, readStickerStatus } from './stickers.js';
import { USER_PROFILE_KEY, getUserProfileStatus } from './personas.js';
import {
  CHARACTER_ITEM_PREFIX,
  getCharacterLibrary,
  isCharacterLibraryWriteBlocked,
} from './characters.js';
import { SESSIONS_KEY, collectChatImageFiles, readSessionsStatus } from './sessions.js';
import { MOMENTS_KEY, getMomentsStatus } from './moments.js';

function isAvatarReferenceBackupKey(key) {
  const value = String(key);
  if (value === `${USER_PROFILE_KEY}${CORRUPT_BACKUP_SUFFIX}`) return true;
  if (value === `${SESSIONS_KEY}${CORRUPT_BACKUP_SUFFIX}`) return true;
  if (value === `${MOMENTS_KEY}${CORRUPT_BACKUP_SUFFIX}`) return true;
  return value.startsWith(`${CHARACTER_ITEM_PREFIX}::`) && value.endsWith(CORRUPT_BACKUP_SUFFIX);
}

async function hasReferenceBackupKey(check) {
  try {
    const keys = await AsyncStorage.getAllKeys();
    return (Array.isArray(keys) ? keys : []).some(key => check(key));
  } catch (error) {
    return true;
  }
}

export async function collectStickerImageFiles() {
  const revision = getMediaWriteRevision();
  if (await hasReferenceBackupKey(isStickerReferenceBackupKey)) return false;
  const status = await readStickerStatus();
  if (status.status !== 'ok' || !isMediaWriteRevisionCurrent(revision)) return false;
  const referenced = new Set(status.stickers.map(item => String(item.uri || '')).filter(Boolean));
  const directory = `${FileSystem.documentDirectory || ''}stickers/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  for (const entry of entries) {
    if (!isMediaWriteRevisionCurrent(revision)) return false;
    const uri = `${directory}${entry}`;
    if (isRecentMediaUri(uri)) continue;
    if (referenced.has(uri)) continue;
    // mtime 双保险：recentUris 是内存态，冷启动后失效——宽限窗内写入的文件一律跳过
    //（删除可推迟，误删不可逆）。
    if (await isRecentlyModifiedFile(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  return true;
}

export async function collectAvatarImageFiles() {
  const revision = getMediaWriteRevision();
  if (await hasReferenceBackupKey(isAvatarReferenceBackupKey)) return false;
  const characters = await getCharacterLibrary().catch(() => null);
  if (!characters || isCharacterLibraryWriteBlocked()) return false;
  const [sessionsStatus, profileStatus, momentsStatus] = await Promise.all([
    readSessionsStatus(),
    getUserProfileStatus().catch(() => ({ status: 'corrupt', profile: null })),
    getMomentsStatus().catch(() => ({ status: 'corrupt', moments: [] })),
  ]);
  if (
    !profileStatus
    || profileStatus.status === 'corrupt'
    || !profileStatus.profile
    || sessionsStatus.status === 'corrupt'
    || momentsStatus.status === 'corrupt'
    || !isMediaWriteRevisionCurrent(revision)
  ) return false;
  const referenced = new Set([
    profileStatus.profile.avatarUri,
    ...characters.flatMap(item => [item.avatarUri, item.bgUri]),
    ...sessionsStatus.sessions.flatMap(item => [item.avatarUri, item.bgUri]),
    ...momentsStatus.moments.map(item => item.avatarUri),
  ].map(value => String(value || '')).filter(Boolean));
  const directory = `${FileSystem.documentDirectory || ''}avatars/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  for (const entry of entries) {
    if (!isMediaWriteRevisionCurrent(revision)) return false;
    const uri = `${directory}${entry}`;
    if (isRecentMediaUri(uri)) continue;
    if (referenced.has(uri)) continue;
    // mtime 双保险：recentUris 是内存态，冷启动后失效——宽限窗内写入的文件一律跳过
    //（删除可推迟，误删不可逆）。
    if (await isRecentlyModifiedFile(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  return true;
}

export async function collectOrphanImageFiles() {
  const [chatResult, stickerResult, avatarResult] = await Promise.all([
    collectChatImageFiles(),
    collectStickerImageFiles(),
    collectAvatarImageFiles(),
  ]);
  return chatResult !== false && stickerResult !== false && avatarResult !== false;
}
