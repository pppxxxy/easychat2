// 自动备份策略（纯函数，零 RN 依赖，Node 可直测）。
//
// 职责：设置归一化、到期判定、备份文件名、淘汰旧备份的选择。
// 真实的导出/写文件/调度分别在 autoBackupRun.js 与 autoBackupScheduler.js。

export const AUTO_BACKUP_LOCATION_KINDS = Object.freeze({ APP: 'app', SAF: 'saf' });
export const AUTO_BACKUP_SCHEMA_VERSION = 1;

// 备份文件名统一前缀/后缀：淘汰旧备份时只认这个前缀，绝不碰用户放在同目录里的其它文件。
export const AUTO_BACKUP_FILE_PREFIX = 'easychat2-auto-backup-';
export const AUTO_BACKUP_FILE_SUFFIX = '.json';

// 预设档位（小时）——UI 据此渲染 chips；自定义档位存毫秒。
export const AUTO_BACKUP_INTERVAL_PRESET_HOURS = [1, 6, 12, 24, 72, 168];
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_AUTO_BACKUP_INTERVAL_MS = DAY_MS;
// 自定义间隔范围：1 小时 ~ 365 天。
export const AUTO_BACKUP_MIN_INTERVAL_MS = HOUR_MS;
export const AUTO_BACKUP_MAX_INTERVAL_MS = 365 * DAY_MS;

const MAX_DISPLAY_NAME = 80;

function cleanString(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

// 用户选的文件夹必须是 SAF 的 content:// 树 URI。file:// 之类的路径在分区存储下拿不到，
// 存下来只会让每次备份都失败——与工作区 location 同一口径。
export function isSafTreeUri(uri) {
  return cleanString(uri, 2000).startsWith('content://');
}

export function normalizeAutoBackupLocation(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (source.kind !== AUTO_BACKUP_LOCATION_KINDS.SAF) {
    return { kind: AUTO_BACKUP_LOCATION_KINDS.APP, uri: '', name: '' };
  }
  const uri = cleanString(source.uri, 2000);
  if (!uri || !isSafTreeUri(uri)) {
    return { kind: AUTO_BACKUP_LOCATION_KINDS.APP, uri: '', name: '' };
  }
  return {
    kind: AUTO_BACKUP_LOCATION_KINDS.SAF,
    uri,
    name: cleanString(source.name, MAX_DISPLAY_NAME),
  };
}

// 间隔夹取：非法/缺省回默认（每天），并夹在 [1 小时, 365 天]。
export function clampAutoBackupInterval(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUTO_BACKUP_INTERVAL_MS;
  return Math.min(AUTO_BACKUP_MAX_INTERVAL_MS, Math.max(AUTO_BACKUP_MIN_INTERVAL_MS, n));
}

export function normalizeAutoBackupSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const lastBackupAt = Math.max(0, Math.floor(Number(source.lastBackupAt)) || 0);
  return {
    schema: AUTO_BACKUP_SCHEMA_VERSION,
    enabled: source.enabled === true,
    // 退出/切后台时备份。它从属于总开关（UI 联动禁用），但归一化只忠实保存其值。
    onExit: source.onExit === true,
    intervalMs: clampAutoBackupInterval(source.intervalMs),
    location: normalizeAutoBackupLocation(source.location),
    lastBackupAt,
    updatedAt: Math.max(0, Math.floor(Number(source.updatedAt)) || 0),
  };
}

// 到期判定：未开启永远不到期；从未备份过 → 立即到期；否则看是否已过 intervalMs。
export function isAutoBackupDue(settings, now = Date.now()) {
  const normalized = normalizeAutoBackupSettings(settings);
  if (!normalized.enabled) return false;
  const at = Math.floor(Number(now)) || 0;
  if (normalized.lastBackupAt <= 0) return true;
  return at - normalized.lastBackupAt >= normalized.intervalMs;
}

export function buildAutoBackupFileName(now = Date.now()) {
  return `${AUTO_BACKUP_FILE_PREFIX}${Math.floor(Number(now)) || 0}${AUTO_BACKUP_FILE_SUFFIX}`;
}

export function isAutoBackupFileName(name) {
  const text = String(name || '');
  return text.startsWith(AUTO_BACKUP_FILE_PREFIX) && text.endsWith(AUTO_BACKUP_FILE_SUFFIX);
}

// 给定目录里的文件清单（[{name, uri}]），选出应删除的旧自动备份：所有匹配前缀的文件，
// 除了要保留的那一个。非自动备份文件一律不动。
export function selectStaleAutoBackups(entries, keepName) {
  const list = Array.isArray(entries) ? entries : [];
  const keep = String(keepName || '');
  return list.filter(entry => (
    entry
    && isAutoBackupFileName(entry.name)
    && String(entry.name) !== keep
  ));
}

// 判断某间隔是否恰好命中预设档位（UI 用来决定高亮预设还是「自定义」）。
export function matchIntervalPresetHours(intervalMs, presets = AUTO_BACKUP_INTERVAL_PRESET_HOURS) {
  const ms = Math.floor(Number(intervalMs));
  if (!Number.isFinite(ms)) return null;
  return presets.find(hours => hours * HOUR_MS === ms) || null;
}
