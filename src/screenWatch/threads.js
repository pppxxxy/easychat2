// 看屏幕对话线程：把连续截屏与「说话」归入同一条对话，让角色有记忆。
// 规则：同一角色 + 距上次活动未超 THREAD_IDLE_MS = 续用同一线程
// （用户要求「连着五次截图等于发生在一个对话里」）；超时则开新对话。
//
// 记忆界面（MemoryScreen）读取本模块做展示与删除——即用户要求的「管理与记忆界面互通」。
// 条目里的 imageUri 指向截图文件（与 comments.js 同源），仅用于回看定位。
//
// 结构：[{ id, characterId, characterName, createdAt, updatedAt,
//          entries: [{ id, role: 'user' | 'character', text, imageUri, at }] }]

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';

export const SCREEN_WATCH_THREADS_KEY = '@easychat2_screen_watch_threads';
export const THREAD_IDLE_MS = 30 * 60 * 1000;
export const THREAD_ENTRY_MAX = 60;
export const THREAD_MAX = 50;
const ENTRY_TEXT_MAX = 2000;

// 直接沿用聊天的 role 命名：这些条目要原样作为 historyMessages 交给 buildRequestMessages。
export const THREAD_ROLE_USER = 'user';
export const THREAD_ROLE_CHARACTER = 'assistant';

const threadsMutation = createMutationQueue();

function makeId(prefix, now = Date.now()) {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeThreadEntry(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const role = source.role === THREAD_ROLE_USER ? THREAD_ROLE_USER : THREAD_ROLE_CHARACTER;
  return {
    id: String(source.id || ''),
    role,
    text: String(source.text || '').trim().slice(0, ENTRY_TEXT_MAX),
    imageUri: String(source.imageUri || ''),
    at: Math.floor(Number(source.at)) || 0,
  };
}

export function normalizeThread(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = [];
  const seen = new Set();
  (Array.isArray(source.entries) ? source.entries : []).forEach(entry => {
    const normalized = normalizeThreadEntry(entry);
    if (!normalized.id || !normalized.text) return;
    if (seen.has(normalized.id)) return;
    seen.add(normalized.id);
    entries.push(normalized);
  });
  const createdAt = Math.floor(Number(source.createdAt)) || 0;
  const updatedAt = Math.floor(Number(source.updatedAt)) || createdAt;
  return {
    id: String(source.id || ''),
    characterId: String(source.characterId || ''),
    characterName: String(source.characterName || '').trim(),
    createdAt,
    updatedAt,
    entries: entries.slice(-THREAD_ENTRY_MAX),
  };
}

function normalizeThreadList(list) {
  const seen = new Set();
  const result = [];
  (Array.isArray(list) ? list : []).forEach(item => {
    const normalized = normalizeThread(item);
    if (!normalized.id || !normalized.characterId) return;
    if (seen.has(normalized.id)) return;
    seen.add(normalized.id);
    result.push(normalized);
  });
  // 最近的在前：记忆界面按时间倒序展示，也便于淘汰最旧。
  return result.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, THREAD_MAX);
}

async function readThreadsStatus() {
  const stored = await readJsonStatus(SCREEN_WATCH_THREADS_KEY);
  if (stored.status === 'missing') return { status: 'ok', list: [] };
  if (stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    await backupCorruptValue(SCREEN_WATCH_THREADS_KEY);
    return { status: 'corrupt', list: [] };
  }
  return { status: 'ok', list: normalizeThreadList(stored.value) };
}

async function writeThreads(list) {
  const normalized = normalizeThreadList(list);
  await AsyncStorage.setItem(SCREEN_WATCH_THREADS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function getScreenWatchThreads() {
  return threadsMutation.enqueue(async () => {
    const result = await readThreadsStatus();
    if (result.status === 'corrupt') throw new Error('screen-watch-threads-read-failed');
    return result.list;
  });
}

// 取当前活跃对话（同角色且未超空闲阈值）；没有则新建。返回 { thread, created }。
export function getOrCreateActiveThread(characterId, characterName = '', now = Date.now()) {
  return threadsMutation.enqueue(async () => {
    const targetId = String(characterId || '');
    if (!targetId) throw new Error('screen-watch-thread-invalid-character');
    const result = await readThreadsStatus();
    if (result.status === 'corrupt') throw new Error('screen-watch-threads-read-failed');
    const active = result.list.find(item => (
      item.characterId === targetId && now - item.updatedAt <= THREAD_IDLE_MS
    ));
    if (active) {
      // 角色改名后同步展示名（历史条目不动）。
      const displayName = String(characterName || '').trim();
      if (displayName && active.characterName !== displayName) {
        const renamed = { ...active, characterName: displayName };
        const list = await writeThreads(result.list.map(item => (
          item.id === active.id ? renamed : item
        )));
        return { thread: list.find(item => item.id === active.id) || renamed, created: false };
      }
      return { thread: active, created: false };
    }
    const thread = normalizeThread({
      id: makeId('swthread', now),
      characterId: targetId,
      characterName: String(characterName || '').trim(),
      createdAt: now,
      updatedAt: now,
      entries: [],
    });
    await writeThreads([thread, ...result.list]);
    return { thread, created: true };
  });
}

export function appendThreadEntry(threadId, entry) {
  return threadsMutation.enqueue(async () => {
    const targetId = String(threadId || '');
    const normalized = normalizeThreadEntry({
      id: (entry && entry.id) || makeId('swentry'),
      ...entry,
    });
    if (!targetId || !normalized.text) throw new Error('screen-watch-thread-entry-invalid');
    const result = await readThreadsStatus();
    if (result.status === 'corrupt') throw new Error('screen-watch-threads-read-failed');
    const target = result.list.find(item => item.id === targetId);
    if (!target) throw new Error('screen-watch-thread-not-found');
    const updated = normalizeThread({
      ...target,
      updatedAt: normalized.at || Date.now(),
      entries: [...target.entries, normalized],
    });
    const list = await writeThreads(result.list.map(item => (
      item.id === targetId ? updated : item
    )));
    return list.find(item => item.id === targetId) || updated;
  });
}

export function deleteScreenWatchThread(id) {
  return threadsMutation.enqueue(async () => {
    const targetId = String(id || '');
    const result = await readThreadsStatus();
    if (result.status === 'corrupt') throw new Error('screen-watch-threads-read-failed');
    if (!targetId) return { removed: null, list: result.list };
    const removed = result.list.find(item => item.id === targetId) || null;
    if (!removed) return { removed: null, list: result.list };
    const list = await writeThreads(result.list.filter(item => item.id !== targetId));
    return { removed, list };
  });
}

export function clearScreenWatchThreads() {
  return threadsMutation.enqueue(async () => {
    await AsyncStorage.removeItem(SCREEN_WATCH_THREADS_KEY);
  });
}
