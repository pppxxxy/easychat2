// 本会话统计存储域：按会话 id 分区（键独立于会话本体，统计坏了也不影响聊天）。
//
// 写入点唯一：useChatSend 每次回复请求结束时记一笔（成功与失败都记，失败只计请求数）。
// 全部写入走同一队列——连续发送 / 重新生成可能并发触发读-改-写，交错会互相覆盖。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { createEmptyStats, normalizeStats, recordRequest } from '../chat/sessionStats.js';
import { createMutationQueue, readJson } from './io.js';

export const SESSION_STATS_KEY = '@easychat2_session_stats';
// 最多保留多少个会话的统计（按最后活动时间淘汰最旧的），避免无限增长。
export const SESSION_STATS_SESSION_LIMIT = 200;

const sessionStatsMutation = createMutationQueue();

function normalizeStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  Object.entries(source).forEach(([sessionId, stats]) => {
    const key = String(sessionId || '').trim();
    if (!key) return;
    out[key] = normalizeStats(stats);
  });
  return out;
}

export async function getSessionStats(sessionId) {
  const key = String(sessionId || '').trim();
  if (!key) return createEmptyStats();
  const store = normalizeStore(await readJson(SESSION_STATS_KEY, null));
  return store[key] || createEmptyStats();
}

// 记一次请求：读 → 合并 → 写。返回写入后的 stats（调用方可直接用来刷新界面）。
export function recordSessionRequest(sessionId, entry = {}) {
  const key = String(sessionId || '').trim();
  if (!key) return Promise.resolve(createEmptyStats());
  return sessionStatsMutation.enqueue(async () => {
    const store = normalizeStore(await readJson(SESSION_STATS_KEY, null));
    const next = recordRequest(store[key] || createEmptyStats(), entry);
    store[key] = next;
    const keys = Object.keys(store);
    if (keys.length > SESSION_STATS_SESSION_LIMIT) {
      keys
        .sort((a, b) => (store[b].lastAt || 0) - (store[a].lastAt || 0))
        .slice(SESSION_STATS_SESSION_LIMIT)
        .forEach(extra => { delete store[extra]; });
    }
    await AsyncStorage.setItem(SESSION_STATS_KEY, JSON.stringify(store));
    return next;
  });
}

export function clearSessionStats(sessionId) {
  const key = String(sessionId || '').trim();
  if (!key) return Promise.resolve(false);
  return sessionStatsMutation.enqueue(async () => {
    const store = normalizeStore(await readJson(SESSION_STATS_KEY, null));
    if (!store[key]) return false;
    delete store[key];
    await AsyncStorage.setItem(SESSION_STATS_KEY, JSON.stringify(store));
    return true;
  });
}
