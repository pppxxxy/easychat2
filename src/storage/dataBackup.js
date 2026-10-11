// 备份包纯函数：版本校验、敏感字段脱敏、pending 过滤与导入计划。

export const BACKUP_SCHEMA_VERSION = 1;
// 角色卡与聊天媒体单条可达十几 MB，整包上限放宽到 2GB，避免正常备份被误判超限。
export const BACKUP_MAX_BYTES = 2048 * 1024 * 1024;
// 完整导出允许的媒体目录。与 backup.js 采集清单对齐：早期校验清单漏了 music/books，
// 导致这两个目录的文件被采集后又被静默丢弃——这里补齐，让「完整导出包含所有内容」成立。
export const BACKUP_MEDIA_DIRECTORIES = ['avatars', 'stickers', 'chat-images', 'voice', 'characters', 'card-forge', 'music', 'books'];

// 导出模式：完整（全部数据 + 全部媒体）与快速（仅角色卡 + 会话/消息/记忆）。
export const BACKUP_MODE_FULL = 'full';
export const BACKUP_MODE_QUICK = 'quick';
// 快速导出携带的媒体目录：角色与聊天相关，排除音乐/书籍/卡工坊等。
export const QUICK_MEDIA_DIRECTORIES = ['avatars', 'characters', 'chat-images', 'voice', 'stickers'];

// 快速导出精确命中的数据键（角色卡与会话状态）。
const QUICK_EXPORT_KEYS = new Set([
  '@easychat2_character_index',
  '@easychat2_active_character',
  '@easychat2_character_edit_draft',
  '@easychat2_character_schedules',
  '@easychat2_affinity',
  '@easychat2_sessions',
  '@easychat2_active_session',
  '@easychat2_session_stats',
  // legacy 单键（迁移用），保留以免老数据在快速导出时丢失
  '@easychat2_characters',
  '@easychat2_character',
  '@easychat2_messages',
]);
// 快速导出前缀命中的数据键（角色条目、会话消息、分支、记忆摘要等）。
const QUICK_EXPORT_PREFIXES = [
  '@easychat2_character_item::',
  '@easychat2_messages::',
  '@easychat2_branch_index::',
  '@easychat2_branch_item::',
  '@easychat2_session_summaries::',
  '@easychat2_session_draft::',
  '@easychat2_session_plan::',
];

export function isQuickExportKey(key) {
  const value = String(key || '');
  if (QUICK_EXPORT_KEYS.has(value)) return true;
  return QUICK_EXPORT_PREFIXES.some(prefix => value.startsWith(prefix));
}

export function isQuickExportMediaPath(relativePath) {
  const normalized = String(relativePath || '').replace(/^\/+/, '');
  return QUICK_MEDIA_DIRECTORIES.some(directory => (
    normalized.startsWith(`${directory}/`) && !normalized.includes('..')
  ));
}

// 安全存储引用前缀：与 secretStore.REF_PREFIX 对齐（此处不引入运行时依赖，保持纯模块）。
const SECRET_REF_PREFIX = 'secure:v1:';

// 扫描待导出数据，收集安全存储引用：`keys` 为含引用的存储键（导出它们才能让密钥
// 在恢复后仍有归属），`ids` 为去前缀后的安全存储 id。纯函数。
export function scanSecretRefs(storage = []) {
  const keys = [];
  const ids = new Set();
  const visit = (value, found) => {
    if (typeof value === 'string') {
      if (value.startsWith(SECRET_REF_PREFIX)) found.add(value.slice(SECRET_REF_PREFIX.length));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, found));
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(item => visit(item, found));
    }
  };
  (Array.isArray(storage) ? storage : []).forEach(item => {
    if (!item || item.value === undefined) return;
    const found = new Set();
    visit(item.value, found);
    if (found.size > 0) {
      if (typeof item.key === 'string') keys.push(item.key);
      found.forEach(id => ids.add(id));
    }
  });
  return { keys, ids: [...ids] };
}

// 角色锁密码/提示直接落安全存储（AsyncStorage 里只有上锁名单），从 security 键枚举 id。
export function collectLockSecretIds(securityValue) {
  const locks = securityValue && typeof securityValue === 'object' ? securityValue.characterLocks : null;
  if (!locks || typeof locks !== 'object') return [];
  return Object.keys(locks).flatMap(id => [`character_lock_${id}`, `character_lock_hint_${id}`]);
}

// 归一化密钥条目：只保留 id/value 均为非空字符串的项。
export function normalizeSecretEntries(secrets) {
  return (Array.isArray(secrets) ? secrets : [])
    .filter(item => item && typeof item.id === 'string' && item.id && typeof item.value === 'string' && item.value)
    .map(item => ({ id: String(item.id), value: String(item.value) }));
}

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
export function sanitizeAndFilterBackupValue(value, key = '', options = {}) {
  // keepSecrets=true：备份明确要携带密钥（含 secure 引用），保留原值交给安全存储侧处理；
  // 默认 false 时按历史行为剥离密钥字段与 secure 引用，作为导入侧的兜底防线。
  const keepSecrets = options.keepSecrets === true;
  if (!keepSecrets && isSecretFieldName(key)) return '';
  if (typeof value === 'string') {
    if (!keepSecrets && value.startsWith('secure:v1:')) return '';
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter(item => !item || item.pending !== true)
      .map(item => sanitizeAndFilterBackupValue(item, '', options));
  }
  if (value && typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([childKey, childValue]) => {
      result[childKey] = sanitizeAndFilterBackupValue(childValue, childKey, options);
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
  // 密钥清单是可选扩展：老备份没有该字段照常通过。
  if (payload.secrets !== undefined) {
    if (!Array.isArray(payload.secrets)) return { valid: false, error: '备份密钥清单格式无效' };
    if (payload.secrets.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.value !== 'string')) {
      return { valid: false, error: '备份密钥条目格式无效' };
    }
  }
  return { valid: true, error: '' };
}

export function buildBackupPayload({ storage = [], media = [], appVersion = '', mode = BACKUP_MODE_FULL, secrets = [] } = {}) {
  const secretEntries = normalizeSecretEntries(secrets);
  const includeSecrets = secretEntries.length > 0;
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: String(appVersion || ''),
    exportedAt: Date.now(),
    mode: mode === BACKUP_MODE_QUICK ? BACKUP_MODE_QUICK : BACKUP_MODE_FULL,
    secretsExcluded: !includeSecrets,
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
          value: sanitizeAndFilterBackupValue(item.value, '', { keepSecrets: includeSecrets }),
        };
      }),
    media: media
      .filter(item => item && isAllowedMediaPath(item.path) && typeof item.base64 === 'string')
      .map(item => ({ path: String(item.path), base64: item.base64 })),
    // 携带密钥时附带密钥清单（id 为安全存储键去前缀部分）。未携带时不写该字段，
    // 老 App 读到也不受影响。
    ...(includeSecrets ? { secrets: secretEntries } : {}),
  };
}

export function planBackupImport(payload, mode = 'merge') {
  const validation = validateBackupPayload(payload);
  if (!validation.valid) return { ...validation, storage: [], media: [], secrets: [] };
  const secrets = normalizeSecretEntries(payload.secrets);
  // 备份自带密钥清单时保留 secure 引用（恢复侧写回安全存储后引用即可解析）；
  // 否则维持历史兜底，剥离密钥字段与引用。
  const keepSecrets = secrets.length > 0;
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
        : { key: item.key, value: sanitizeAndFilterBackupValue(item.value, '', { keepSecrets }) }
    )),
    media: payload.media,
    secrets,
  };
}
