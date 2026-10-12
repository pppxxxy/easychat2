// 本会话统计存储域：按会话 id 分区（键独立于会话本体，统计坏了也不影响聊天）。
//
// 写入点唯一：useChatSend 每次回复请求结束时记一笔（成功与失败都记，失败只计请求数）。
// 全部写入走同一队列——连续发送 / 重新生成可能并发触发读-改-写，交错会互相覆盖。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { createEmptyStats, normalizeStats, recordRequest } from '../chat/sessionStats.js';
import { tActive } from '../i18n/index.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

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

// 读统计表并**保留读取状态**（读路径对外行为不变：损坏时仍给空统计，界面不崩）。
// 参考 src/storage/worldMap.js:19-27（getWorldMapStatus）。
async function readSessionStatsStatus() {
  const stored = await readJsonStatus(SESSION_STATS_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(SESSION_STATS_KEY);
    return { status: 'corrupt', store: {} };
  }
  return {
    status: stored.status === 'ok' ? 'ok' : 'missing',
    store: normalizeStore(stored.status === 'ok' ? stored.value : null),
  };
}

// 写路径守卫（变体①：拒绝写回 / 抛错）。
// 参考 src/storage/worldMap.js:34-40（updateWorldMap）与 src/storage/cardForge.js:182-186。
//
// 为什么必须守卫：本键是**单键多会话**的分区表（`{ [sessionId]: stats }`），
// 一次 setItem 覆盖的是**所有会话**的统计。读失败时表是空的，
// 「记一次请求」或「清一个会话」都会把其余会话的统计一起清掉。
// 调用点 useChatSend.js:640 在 try 里、:1019 带 .catch，记不上账不影响回复本身；
// clearSessionStats 的调用点 sessionList/mutations.js:68 也带 .catch。
function requireStatsForMutation(current) {
  if (current.status === 'corrupt') {
    throw new Error(tActive('error.storage.sessionStatsReadFailed'));
  }
  return current.store;
}

export async function getSessionStats(sessionId) {
  const key = String(sessionId || '').trim();
  if (!key) return createEmptyStats();
  const { store } = await readSessionStatsStatus();
  return store[key] || createEmptyStats();
}

// 记一次请求：读 → 合并 → 写。返回写入后的 stats（调用方可直接用来刷新界面）。
export function recordSessionRequest(sessionId, entry = {}) {
  const key = String(sessionId || '').trim();
  if (!key) return Promise.resolve(createEmptyStats());
  return sessionStatsMutation.enqueue(async () => {
    const store = requireStatsForMutation(await readSessionStatsStatus());
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
    // 删除看似可推迟（变体⑤的方向，参考 src/storage/mediaProtection.js:47），
    // 但这里删的不是「一条记录」而是「一张整表里的一行」：读失败时表是空的，
    // 写回即清空所有会话的统计。所以仍然拒绝，由调用方下次再删。
    const store = requireStatsForMutation(await readSessionStatsStatus());
    if (!store[key]) return false;
    delete store[key];
    await AsyncStorage.setItem(SESSION_STATS_KEY, JSON.stringify(store));
    return true;
  });
}
