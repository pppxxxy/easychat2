let revision = 0;
const recentUris = new Map();
const RECENT_URI_TTL_MS = 10 * 60 * 1000;

export function markMediaWrite(uri = '') {
  const value = String(uri || '');
  if (!value) return;
  revision += 1;
  recentUris.set(value, Date.now());
}

export function getMediaWriteRevision() {
  return revision;
}

export function isMediaWriteRevisionCurrent(value) {
  return value === revision;
}

export function isRecentMediaUri(uri) {
  const value = String(uri || '');
  const now = Date.now();
  recentUris.forEach((createdAt, key) => {
    if (now - createdAt >= RECENT_URI_TTL_MS) recentUris.delete(key);
  });
  return recentUris.has(value);
}

// 回收器遇到“刚写入、暂时不该删”的文件会跳过。这里返回最早一条最近写入的过期时间，
// 让回收器在保护窗口结束后自动重跑一次，避免跳过的文件永远留在磁盘上。
export function getNextRecentMediaExpiry() {
  const now = Date.now();
  let next = 0;
  recentUris.forEach(createdAt => {
    const at = createdAt + RECENT_URI_TTL_MS;
    if (at <= now) return;
    if (next === 0 || at < next) next = at;
  });
  return next;
}
