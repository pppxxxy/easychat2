// 聊天图片文件回收：扫描全部会话消息的图片引用，删除 documentDirectory/chat-images/
// 下不再被引用的文件。从 src/storage/sessions.js 拆出（纯搬运，无行为变化）。
// 本层只依赖 sessionCore（键/共享状态），不依赖 messages/list，作为叶子避免循环。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

import {
  getMediaWriteRevision,
  getNextRecentMediaExpiry,
  isMediaWriteRevisionCurrent,
  isRecentMediaUri,
} from '../mediaProtection.js';
import { CORRUPT_BACKUP_SUFFIX, readLargeAsyncStorageValue } from './io.js';
import {
  MESSAGES_KEY_PREFIX,
  protectedChatImageUris,
} from './sessionCore.js';

export function imageUrisFromMessages(messages) {
  const result = new Set();
  (Array.isArray(messages) ? messages : []).forEach(item => {
    const uri = String(item && item.image && item.image.uri || '');
    if (uri.includes('/chat-images/')) result.add(uri);
  });
  return result;
}

async function collectChatImageFilesInternal(protectedUris = []) {
  const revision = getMediaWriteRevision();
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    return false;
  }
  const messageKeys = keys.filter(key => (
    key === MESSAGES_KEY_PREFIX || String(key).startsWith(`${MESSAGES_KEY_PREFIX}::`)
  ));
  const referenced = new Set([
    ...protectedChatImageUris,
    ...(Array.isArray(protectedUris) ? protectedUris : [])
      .map(uri => String(uri || ''))
      .filter(uri => uri.includes('/chat-images/')),
  ]);
  for (const key of messageKeys) {
    if (String(key).endsWith(CORRUPT_BACKUP_SUFFIX)) return false;
    let raw = null;
    try {
      raw = await AsyncStorage.getItem(key);
    } catch (error) {
      raw = await readLargeAsyncStorageValue(key);
    }
    if (raw === null || raw === undefined) return false;
    if (!raw) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return false;
    }
    if (!Array.isArray(parsed)) return false;
    imageUrisFromMessages(parsed).forEach(uri => referenced.add(uri));
  }
  const directory = `${FileSystem.documentDirectory || ''}chat-images/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  let skippedRecent = false;
  for (const entry of entries) {
    if (!isMediaWriteRevisionCurrent(revision)) return false;
    const uri = `${directory}${entry}`;
    if (isRecentMediaUri(uri)) {
      skippedRecent = true;
      continue;
    }
    if (referenced.has(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  if (skippedRecent) scheduleMediaCollectRetry();
  return true;
}

let mediaCollectRetryTimer = null;

function scheduleMediaCollectRetry() {
  const expiry = getNextRecentMediaExpiry();
  if (!expiry) return;
  const delay = Math.max(1000, expiry - Date.now() + 50);
  if (mediaCollectRetryTimer) clearTimeout(mediaCollectRetryTimer);
  mediaCollectRetryTimer = setTimeout(() => {
    mediaCollectRetryTimer = null;
    collectChatImageFiles().catch(() => {});
  }, delay);
}

// 回收会读取全部会话消息并删文件；与新媒体写入或另一轮回收并发时容易交错。
// 统一排进同一 promise 队列，保证任意时刻只有一次回收在跑。
let mediaCollectQueue = Promise.resolve();

export function collectChatImageFiles(protectedUris = []) {
  const run = mediaCollectQueue
    .catch(() => {})
    .then(() => collectChatImageFilesInternal(protectedUris));
  mediaCollectQueue = run.catch(() => {});
  return run;
}
