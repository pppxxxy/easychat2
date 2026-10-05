// 歌单存储领域：单键存全部歌单（歌单数量与歌曲引用都很小，不值得分键）。
// 歌单只保存歌曲 id 引用、不复制音频文件；歌曲被删除时由调用方调
// purgeSongsFromPlaylists 清理引用（界面渲染也会按曲库过滤，双保险不留幽灵条目）。
//
// 结构：[{ id, name, songIds: [string], createdAt, updatedAt }]

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';

export const MUSIC_PLAYLISTS_KEY = '@easychat2_music_playlists';
export const PLAYLIST_NAME_MAX = 40;

// 错误码而非文案：存储层不持有用户可见文本（i18n 防复发规则），界面按 code 决策并给本地化提示。
export const PLAYLIST_ERROR = {
  NAME_REQUIRED: 'playlist-name-required',
  NOT_FOUND: 'playlist-not-found',
  READ_FAILED: 'playlist-read-failed',
  TARGET_INVALID: 'playlist-target-invalid',
};

function playlistError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const playlistMutation = createMutationQueue();

function makePlaylistId(now = Date.now()) {
  return `playlist-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizePlaylist(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const songIds = [];
  const seen = new Set();
  (Array.isArray(source.songIds) ? source.songIds : []).forEach(id => {
    const value = String(id || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    songIds.push(value);
  });
  return {
    id: String(source.id || '').trim(),
    name: String(source.name || '').trim().slice(0, PLAYLIST_NAME_MAX),
    songIds,
    createdAt: Math.floor(Number(source.createdAt)) || 0,
    updatedAt: Math.floor(Number(source.updatedAt)) || 0,
  };
}

// 保序规范化：校验必填字段并按 id 去重，不重排（新建追加在尾部，顺序即用户看到的分组顺序）。
function normalizePlaylistList(list) {
  const seen = new Set();
  const result = [];
  (Array.isArray(list) ? list : []).forEach(item => {
    const normalized = normalizePlaylist(item);
    if (!normalized.id || !normalized.name) return;
    if (seen.has(normalized.id)) return;
    seen.add(normalized.id);
    result.push(normalized);
  });
  return result;
}

async function readPlaylistStatus() {
  const stored = await readJsonStatus(MUSIC_PLAYLISTS_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(MUSIC_PLAYLISTS_KEY);
    return { status: 'corrupt', list: [] };
  }
  // 首次使用没有键：空歌单列表，不是损坏。
  if (stored.status === 'missing') return { status: 'ok', list: [] };
  return { status: 'ok', list: normalizePlaylistList(stored.value) };
}

async function writePlaylists(list) {
  const normalized = normalizePlaylistList(list);
  await AsyncStorage.setItem(MUSIC_PLAYLISTS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function getMusicPlaylists() {
  return playlistMutation.enqueue(async () => {
    const result = await readPlaylistStatus();
    if (result.status === 'corrupt') throw playlistError(PLAYLIST_ERROR.READ_FAILED);
    return result.list;
  });
}

export function createMusicPlaylist(name) {
  return playlistMutation.enqueue(async () => {
    const trimmed = String(name || '').trim().slice(0, PLAYLIST_NAME_MAX);
    if (!trimmed) throw playlistError(PLAYLIST_ERROR.NAME_REQUIRED);
    const result = await readPlaylistStatus();
    if (result.status === 'corrupt') throw playlistError(PLAYLIST_ERROR.READ_FAILED);
    const now = Date.now();
    const created = normalizePlaylist({
      id: makePlaylistId(now),
      name: trimmed,
      songIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await writePlaylists([...result.list, created]);
    return created;
  });
}

export function renameMusicPlaylist(id, name) {
  return playlistMutation.enqueue(async () => {
    const targetId = String(id || '');
    const trimmed = String(name || '').trim().slice(0, PLAYLIST_NAME_MAX);
    if (!targetId) throw playlistError(PLAYLIST_ERROR.NOT_FOUND);
    if (!trimmed) throw playlistError(PLAYLIST_ERROR.NAME_REQUIRED);
    const result = await readPlaylistStatus();
    if (result.status === 'corrupt') throw playlistError(PLAYLIST_ERROR.READ_FAILED);
    const target = result.list.find(item => item.id === targetId);
    if (!target) throw playlistError(PLAYLIST_ERROR.NOT_FOUND);
    const updated = normalizePlaylist({ ...target, name: trimmed, updatedAt: Date.now() });
    const list = await writePlaylists(
      result.list.map(item => (item.id === targetId ? updated : item))
    );
    return list.find(item => item.id === targetId) || updated;
  });
}

export function deleteMusicPlaylist(id) {
  return playlistMutation.enqueue(async () => {
    const targetId = String(id || '');
    const result = await readPlaylistStatus();
    if (result.status === 'corrupt') throw playlistError(PLAYLIST_ERROR.READ_FAILED);
    if (!targetId) return { removed: null, list: result.list };
    const removed = result.list.find(item => item.id === targetId) || null;
    if (!removed) return { removed: null, list: result.list };
    const list = await writePlaylists(result.list.filter(item => item.id !== targetId));
    return { removed, list };
  });
}

// 加入/移出歌单：included=true 加入（已存在则保持原样），false 移出。只动目标歌单。
export function setSongInPlaylist(playlistId, songId, included) {
  return playlistMutation.enqueue(async () => {
    const targetId = String(playlistId || '');
    const targetSongId = String(songId || '');
    if (!targetId || !targetSongId) throw playlistError(PLAYLIST_ERROR.TARGET_INVALID);
    const result = await readPlaylistStatus();
    if (result.status === 'corrupt') throw playlistError(PLAYLIST_ERROR.READ_FAILED);
    const target = result.list.find(item => item.id === targetId);
    if (!target) throw playlistError(PLAYLIST_ERROR.NOT_FOUND);
    const has = target.songIds.includes(targetSongId);
    const want = included === true;
    if (has === want) return target;
    const songIds = want
      ? [...target.songIds, targetSongId]
      : target.songIds.filter(id => id !== targetSongId);
    const updated = normalizePlaylist({ ...target, songIds, updatedAt: Date.now() });
    const list = await writePlaylists(
      result.list.map(item => (item.id === targetId ? updated : item))
    );
    return list.find(item => item.id === targetId) || updated;
  });
}

// 删除歌曲后的级联清理：从所有歌单移除这些歌曲 id，返回是否有改动。
// 读取失败一律吞掉返回 false——清理失败绝不能阻断歌曲删除本身。
export function purgeSongsFromPlaylists(songIds) {
  const targets = new Set(
    (Array.isArray(songIds) ? songIds : [songIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  if (targets.size === 0) return Promise.resolve(false);
  return playlistMutation.enqueue(async () => {
    const result = await readPlaylistStatus();
    if (result.status === 'corrupt') return false;
    let changed = false;
    const next = result.list.map(item => {
      const kept = item.songIds.filter(id => !targets.has(id));
      if (kept.length === item.songIds.length) return item;
      changed = true;
      return { ...item, songIds: kept, updatedAt: Date.now() };
    });
    if (changed) await writePlaylists(next);
    return changed;
  });
}
