// 一起听歌的角色评论存储：按歌曲分键（@easychat2_music_comments::<songId>）。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；落库上限 50 条，
// 超出丢最旧，防止单曲长听把键撑爆。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';

const COMMENTS_PREFIX = '@easychat2_music_comments';
const COMMENTS_MAX = 50;
const COMMENT_TEXT_MAX = 2000;
const COMMENT_SOURCES = ['trigger', 'opening', 'manual'];

const commentsMutation = createMutationQueue();

export function musicCommentsKey(songId) {
  return `${COMMENTS_PREFIX}::${String(songId || '')}`;
}

export const MUSIC_COMMENT_SOURCE = COMMENT_SOURCES.reduce((map, source) => {
  map[source] = source;
  return map;
}, {});

export function normalizeMusicComment(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = String(source.text || '').trim().slice(0, COMMENT_TEXT_MAX);
  const atMs = Math.max(0, Math.floor(Number(source.atMs)) || 0);
  const fallbackSource = COMMENT_SOURCES.includes(source.source) ? source.source : 'manual';
  return {
    id: String(source.id || ''),
    // characterId/characterName 记录评论出自哪位角色；「接话」按 characterId 打开其会话。
    characterId: String(source.characterId || ''),
    characterName: String(source.characterName || '').trim(),
    text,
    atMs,
    createdAt: Math.floor(Number(source.createdAt)) || 0,
    source: fallbackSource,
  };
}

async function readCommentListStatus(songId) {
  const key = musicCommentsKey(songId);
  const stored = await readJsonStatus(key);
  if (stored.status === 'missing') return [];
  if (stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    await backupCorruptValue(key);
    return [];
  }
  return stored.value
    .map(normalizeMusicComment)
    .filter(comment => comment.id && comment.text);
}

export function getMusicComments(songId) {
  const targetId = String(songId || '');
  if (!targetId) return Promise.resolve([]);
  return commentsMutation.enqueue(() => readCommentListStatus(targetId));
}

// 追加一条评论；同 id 幂等（重试不会造成重复）。超出上限丢最旧。
export function appendMusicComment(songId, comment) {
  const targetId = String(songId || '');
  return commentsMutation.enqueue(async () => {
    if (!targetId) throw new Error('评论信息不完整');
    const normalized = normalizeMusicComment(comment);
    if (!normalized.id || !normalized.text) throw new Error('评论信息不完整');
    const existing = await readCommentListStatus(targetId);
    if (existing.some(entry => entry.id === normalized.id)) return existing;
    const next = [...existing, normalized].slice(-COMMENTS_MAX);
    await AsyncStorage.setItem(musicCommentsKey(targetId), JSON.stringify(next));
    return next;
  });
}

export function clearMusicComments(songId) {
  const targetId = String(songId || '');
  return commentsMutation.enqueue(async () => {
    if (!targetId) return;
    await AsyncStorage.removeItem(musicCommentsKey(targetId));
  });
}

// 删除歌曲时同步清理其评论键；返回清理的键数（供诊断）。
export async function deleteMusicCommentsForSongs(songIds) {
  const ids = (Array.isArray(songIds) ? songIds : [songIds]).map(id => String(id || '')).filter(Boolean);
  if (ids.length === 0) return 0;
  return commentsMutation.enqueue(async () => {
    const keys = ids.map(musicCommentsKey);
    await AsyncStorage.multiRemove(keys);
    return keys.length;
  });
}
