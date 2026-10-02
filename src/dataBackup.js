// 备份包纯函数：版本校验、敏感字段脱敏、pending 过滤与导入计划。

export const BACKUP_SCHEMA_VERSION = 1;
// 角色卡与聊天媒体单条可达十几 MB，整包上限放宽到 2GB，避免正常备份被误判超限。
export const BACKUP_MAX_BYTES = 2048 * 1024 * 1024;
export const BACKUP_MEDIA_DIRECTORIES = ['avatars', 'stickers', 'chat-images', 'voice', 'characters', 'card-forge'];

const SECRET_KEY_PATTERN = /(apiKey|appSecretKey|secret|password|token)/i;

export function sanitizeBackupValue(value, key = '') {
  if (SECRET_KEY_PATTERN.test(String(key))) return '';
  if (typeof value === 'string') {
    return value.startsWith('secure:v1:') ? '' : value;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeBackupValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeBackupValue(childValue, childKey),
      ])
    );
  }
  return value;
}

export function filterPendingMessages(value) {
  if (Array.isArray(value)) {
    return value.filter(item => !item || item.pending !== true).map(filterPendingMessages);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, filterPendingMessages(child)])
    );
  }
  return value;
}

// 单次遍历同时完成「密钥脱敏 + pending 过滤」：导出大对象时避免对整棵数据图
// 递归两遍（sanitize 一遍、filter 一遍），显著降低 CPU 与临时对象分配。
// 语义与分别调用 sanitizeBackupValue / filterPendingMessages 等价。
export function sanitizeAndFilterBackupValue(value, key = '') {
  if (SECRET_KEY_PATTERN.test(String(key))) return '';
  if (typeof value === 'string') {
    return value.startsWith('secure:v1:') ? '' : value;
  }
  if (Array.isArray(value)) {
    return value
      .filter(item => !item || item.pending !== true)
      .map(item => sanitizeAndFilterBackupValue(item));
  }
  if (value && typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([childKey, childValue]) => {
      result[childKey] = sanitizeAndFilterBackupValue(childValue, childKey);
    });
    return result;
  }
  return value;
}

export function isAllowedMediaPath(relativePath) {
  const normalized = String(relativePath || '').replace(/^\/+/, '');
  return BACKUP_MEDIA_DIRECTORIES.some(directory => (
    normalized.startsWith(`${directory}/`) && !normalized.includes('..')
  ));
}

export function validateBackupPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: '备份文件格式无效' };
  }
  if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return { valid: false, error: `不支持的备份版本：${String(payload.schemaVersion || '未知')}` };
  }
  if (!Array.isArray(payload.storage) || !Array.isArray(payload.media)) {
    return { valid: false, error: '备份文件缺少数据或媒体清单' };
  }
  if (payload.storage.some(item => (
    !item
    || typeof item.key !== 'string'
    || !item.key.startsWith('@easychat2_')
    || item.key.endsWith('__corrupt_backup')
  ))) {
    return { valid: false, error: '备份数据键格式无效' };
  }
  const keys = payload.storage.map(item => item.key);
  if (new Set(keys).size !== keys.length) return { valid: false, error: '备份数据键重复' };
  if (payload.media.some(item => !item || !isAllowedMediaPath(item.path) || typeof item.base64 !== 'string')) {
    return { valid: false, error: '备份媒体路径或内容无效' };
  }
  return { valid: true, error: '' };
}

export function buildBackupPayload({ storage = [], media = [], appVersion = '' } = {}) {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: String(appVersion || ''),
    exportedAt: Date.now(),
    secretsExcluded: true,
    storage: storage
      .filter(item => item && typeof item.key === 'string')
      .map(item => ({
        key: item.key,
        // 顶层不按存储键判定密钥（与原实现一致）；嵌套键才参与脱敏。
        value: sanitizeAndFilterBackupValue(item.value),
      })),
    media: media
      .filter(item => item && isAllowedMediaPath(item.path) && typeof item.base64 === 'string')
      .map(item => ({ path: String(item.path), base64: item.base64 })),
  };
}

export function planBackupImport(payload, mode = 'merge') {
  const validation = validateBackupPayload(payload);
  if (!validation.valid) return { ...validation, storage: [], media: [] };
  return {
    valid: true,
    error: '',
    mode: mode === 'replace' ? 'replace' : 'merge',
    storage: payload.storage,
    media: payload.media,
  };
}
