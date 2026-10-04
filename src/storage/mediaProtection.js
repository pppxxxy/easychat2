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

// ---- mtime 双保险 ----
//
// recentUris 是纯内存态：进程被杀（冷启动）后保护窗口失效。理论上存在
// 「启动即 GC」把崩溃前刚写入、尚未被引用方落库的文件删掉的竞态。
// 删除候选在真删之前再看一眼文件系统的修改时间：宽限窗内的一律跳过。
// 读取失败时按「最近写入」处理（宁可放过，不可误删）——删除永远是可推迟的。

// FileSystem 只在需要时惰性加载：本模块现有用例全是纯内存判定（无需 RN 依赖），
// 加了这个助手后才引入文件系统访问。
let fsModule;
function getFs() {
  if (fsModule === undefined) {
    try {
      fsModule = require('expo-file-system/legacy');
    } catch (error) {
      fsModule = null;
    }
  }
  return fsModule;
}

export async function isRecentlyModifiedFile(uri, graceMs = RECENT_URI_TTL_MS, fsOverride = null) {
  // fsOverride 仅供测试注入；生产路径走惰性 require（RN 环境）或 fail-safe（Node）。
  const FileSystem = fsOverride || getFs();
  if (!FileSystem || !FileSystem.getInfoAsync) return true;
  try {
    const info = await FileSystem.getInfoAsync(String(uri || ''));
    if (!info || info.exists === false) return false;
    // legacy API 返回的是秒级 modificationTime；防御性兼容毫秒。
    let mtimeMs = Number(info.modificationTime);
    if (!Number.isFinite(mtimeMs)) return true;
    if (mtimeMs < 1e12) mtimeMs *= 1000;
    return Date.now() - mtimeMs < graceMs;
  } catch (error) {
    return true;
  }
}
