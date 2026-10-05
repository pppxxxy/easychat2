// 看屏幕的陪伴评论存储：单一全局键（@easychat2_screen_watch_comments）。
// 与听歌/看书同一裁决：评论只在面板内呈现、接话才进会话引用；
// 看屏幕没有「目标对象」（不像歌/书按对象分键），因此整条流一个键，上限 30 条。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';
import { tActive } from '../i18n/index.js';

export const SCREEN_WATCH_COMMENTS_KEY = '@easychat2_screen_watch_comments';
const COMMENTS_MAX = 30;
const COMMENT_TEXT_MAX = 2000;

const commentsMutation = createMutationQueue();

export function normalizeScreenWatchComment(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || ''),
    characterId: String(source.characterId || ''),
    characterName: String(source.characterName || '').trim(),
    text: String(source.text || '').trim().slice(0, COMMENT_TEXT_MAX),
    // imageUri 记录评论针对的截图（重试与回看用）；文件本身按滚动清扫维护。
    imageUri: String(source.imageUri || ''),
    createdAt: Math.floor(Number(source.createdAt)) || 0,
  };
}

async function readCommentListStatus() {
  const stored = await readJsonStatus(SCREEN_WATCH_COMMENTS_KEY);
  if (stored.status === 'missing') return [];
  if (stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    await backupCorruptValue(SCREEN_WATCH_COMMENTS_KEY);
    return [];
  }
  return stored.value
    .map(normalizeScreenWatchComment)
    .filter(comment => comment.id && comment.text);
}

export function getScreenWatchComments() {
  return commentsMutation.enqueue(() => readCommentListStatus());
}

export function appendScreenWatchComment(comment) {
  return commentsMutation.enqueue(async () => {
    const normalized = normalizeScreenWatchComment(comment);
    if (!normalized.id || !normalized.text) throw new Error(tActive('error.comments.incomplete'));
    const existing = await readCommentListStatus();
    if (existing.some(entry => entry.id === normalized.id)) return existing;
    const next = [...existing, normalized].slice(-COMMENTS_MAX);
    await AsyncStorage.setItem(SCREEN_WATCH_COMMENTS_KEY, JSON.stringify(next));
    return next;
  });
}

export function clearScreenWatchComments() {
  return commentsMutation.enqueue(async () => {
    await AsyncStorage.removeItem(SCREEN_WATCH_COMMENTS_KEY);
  });
}
