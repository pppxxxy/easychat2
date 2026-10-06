// 一起看书的段落陪伴评论存储：按书分键（@easychat2_book_comments::<bookId>）。
// 与听歌评论同一裁决：评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁定，
// 接话按钮才带入会话引用）。上限 50 条丢最旧。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';
import { tActive } from '../i18n/index.js';

const COMMENTS_PREFIX = '@easychat2_book_comments';
const COMMENTS_MAX = 50;
const COMMENT_TEXT_MAX = 2000;
const EXCERPT_MAX = 400;
const COMMENT_SOURCES = ['manual', 'chapter'];

const commentsMutation = createMutationQueue();

export function bookCommentsKey(bookId) {
  return `${COMMENTS_PREFIX}::${String(bookId || '')}`;
}

export function normalizeBookComment(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = String(source.text || '').trim().slice(0, COMMENT_TEXT_MAX);
  const anchorSource = source.anchor && typeof source.anchor === 'object' ? source.anchor : {};
  return {
    id: String(source.id || ''),
    characterId: String(source.characterId || ''),
    characterName: String(source.characterName || '').trim(),
    text,
    // anchor 记录评论针对的位置：所在块号 + 页首行文本截断（重排后可粗定位）+ 摘录。
    anchor: {
      blockIndex: Math.max(0, Math.floor(Number(anchorSource.blockIndex)) || 0),
      anchorText: String(anchorSource.anchorText || '').slice(0, EXCERPT_MAX),
      excerpt: String(anchorSource.excerpt || '').slice(0, EXCERPT_MAX),
    },
    chapterTitle: String(source.chapterTitle || '').trim().slice(0, 60),
    createdAt: Math.floor(Number(source.createdAt)) || 0,
    source: COMMENT_SOURCES.includes(source.source) ? source.source : 'manual',
  };
}

async function readCommentListStatus(bookId) {
  const key = bookCommentsKey(bookId);
  const stored = await readJsonStatus(key);
  if (stored.status === 'missing') return [];
  if (stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    await backupCorruptValue(key);
    return [];
  }
  return stored.value
    .map(normalizeBookComment)
    .filter(comment => comment.id && comment.text);
}

export function getBookComments(bookId) {
  const targetId = String(bookId || '');
  if (!targetId) return Promise.resolve([]);
  return commentsMutation.enqueue(() => readCommentListStatus(targetId));
}

export function appendBookComment(bookId, comment) {
  const targetId = String(bookId || '');
  return commentsMutation.enqueue(async () => {
    if (!targetId) throw new Error(tActive('error.comments.incomplete'));
    const normalized = normalizeBookComment(comment);
    if (!normalized.id || !normalized.text) throw new Error(tActive('error.comments.incomplete'));
    const existing = await readCommentListStatus(targetId);
    if (existing.some(entry => entry.id === normalized.id)) return existing;
    const next = [...existing, normalized].slice(-COMMENTS_MAX);
    await AsyncStorage.setItem(bookCommentsKey(targetId), JSON.stringify(next));
    return next;
  });
}

export function clearBookComments(bookId) {
  const targetId = String(bookId || '');
  return commentsMutation.enqueue(async () => {
    if (!targetId) return;
    await AsyncStorage.removeItem(bookCommentsKey(targetId));
  });
}

export async function deleteBookCommentsForBooks(bookIds) {
  const ids = (Array.isArray(bookIds) ? bookIds : [bookIds]).map(id => String(id || '')).filter(Boolean);
  if (ids.length === 0) return 0;
  return commentsMutation.enqueue(async () => {
    const keys = ids.map(bookCommentsKey);
    await AsyncStorage.multiRemove(keys);
    return keys.length;
  });
}
