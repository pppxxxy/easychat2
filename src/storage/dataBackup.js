// 备份包纯函数：版本校验、敏感字段脱敏、pending 过滤与导入计划。

export const BACKUP_SCHEMA_VERSION = 1;
// 角色卡与聊天媒体单条可达十几 MB，整包上限放宽到 2GB，避免正常备份被误判超限。
export const BACKUP_MAX_BYTES = 2048 * 1024 * 1024;
export const BACKUP_MEDIA_DIRECTORIES = ['avatars', 'stickers', 'chat-images', 'voice', 'characters', 'card-forge'];

// 精确匹配密钥字段名，不做子串匹配：否则 `maxTokens`（含 token）、`apiKeyUrl`（含 apiKey）
// 这类正常字段会被整段清空，导出/恢复后用户配置静默丢失。与 secretStore.SECRET_FIELDS 对齐。
const SECRET_FIELD_NAMES = new Set(['apiKey', 'appSecretKey', 'secretKey', 'secret', 'password', 'token', 'accessToken', 'refreshToken']);

function isSecretFieldName(key) {
  return SECRET_FIELD_NAMES.has(String(key));
}

export function sanitizeBackupValue(value, key = '') {
  if (isSecretFieldName(key)) return '';
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
  if (isSecretFieldName(key)) return '';
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

// storage 条目要么带结构化 value（正常键），要么带 opaqueRaw（结构损坏但已抢救的
// 原始字符串）。老备份（schemaVersion 1、只有 value）照常通过；新备份新增的
// opaqueRaw 字段对代码结构透明——老版本 App 读到它会当作未知字段忽略该键的
// value 缺失路径（见 planBackupImport 的兼容分支），不会崩溃。
function isOpaqueRawEntry(item) {
  return typeof item.opaqueRaw === 'string';
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
      .map(item => {
        // 结构损坏但读到原始串的键：原样存 opaqueRaw，不做脱敏/过滤——
        // 它本就不是可解析的结构，任何遍历都无从下手，且脱敏会破坏原始字节。
        if (isOpaqueRawEntry(item)) {
          return { key: item.key, opaqueRaw: item.opaqueRaw };
        }
        return {
          key: item.key,
          // 顶层不按存储键判定密钥（与原实现一致）；嵌套键才参与脱敏。
          value: sanitizeAndFilterBackupValue(item.value),
        };
      }),
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
    // 导入是独立于导出的防线：即便备份来自旧版本或被手工构造，也在此剥离密钥字段
    // 并丢弃 pending 占位消息，避免绕过「pending 不落盘」与密钥保险箱约束。
    // opaqueRaw 条目无结构化值可清理，原样透传（恢复侧原样写回）。
    storage: payload.storage.map(item => (
      isOpaqueRawEntry(item)
        ? { key: item.key, opaqueRaw: item.opaqueRaw }
        : { key: item.key, value: sanitizeAndFilterBackupValue(item.value) }
    )),
    media: payload.media,
  };
}
