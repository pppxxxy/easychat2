// 备份包纯函数：版本校验、敏感字段脱敏、pending 过滤与导入计划。

import { AVATAR_DIRECTORY, FORGE_MEDIA_DIRECTORY } from '../cardForge/mediaPaths.js';
import { SECRET_FIELDS, SECRET_OBJECT_FIELDS } from './secretStore.js';

export const BACKUP_SCHEMA_VERSION = 1;
// 角色卡与聊天媒体单条可达十几 MB，整包上限放宽到 2GB，避免正常备份被误判超限。
export const BACKUP_MAX_BYTES = 2048 * 1024 * 1024;

// ── 备份媒体目录清单：**全仓唯一一份**（本批把历史上漂移的两份合并成这一份）──────────
// 为什么必须只有一份：打包（buildBackupPayload）与导入校验（validateBackupPayload）都在
// 本文件，而导出侧（storage/backup.js）历史上另有一份手写清单，两份已经漂移——`music`、
// `books` 只登记在导出侧，于是：
//   1) 导出时这两个目录的文件被 isAllowedMediaPath 静默过滤掉：用户的音乐库与书籍
//      **根本不进备份包**（UI 只说「备份成功」）；
//   2) 恢复时同一份窄白名单还会**拒收**含这些路径的包。
// 用户只有想恢复时才发现数据没了，且不可逆。所以清单只在这里维护，导出侧直接
// re-export 本常量（tests/storageBackup.test.mjs 断言两边是**同一个对象**，不再靠人肉同步）。
//
// 每一项都注明产出方（模块 + 常量）。能直接 import 的产出方就 import：`avatars` /
// `card-forge` 来自零依赖纯模块 cardForge/mediaPaths.js。其余产出方会拖进 expo /
// AsyncStorage / i18n 依赖，而本文件要保持「可 Node 直测」，故在这里登记同名常量，
// 由 tests/storageBackup.test.mjs 读产出方源码逐条比对（常量被改名/搬走即变红）。
//   avatars     ← cardForge/mediaPaths.js AVATAR_DIRECTORY（角色头像/背景、用户头像）
//   stickers    ← chat/stickerImages.js（贴纸图；该文件写死字面量、未导出常量）
//   chat-images ← chat/attachments.js persistImageAttachment（聊天图片；同上）
//   voice       ← chat/useChatRecorder.js、chat/useChatTts.js（语音消息与 TTS 产物）
//   characters  ← storage/characters/payload.js CHARACTER_PAYLOAD_DIRECTORY
//                 （大角色正文：正文超过 512KB 的角色卡**只**把正文存在这个目录）
//   card-forge  ← cardForge/mediaPaths.js FORGE_MEDIA_DIRECTORY（制卡工坊草稿图）
//   music       ← music/library.js MUSIC_DIR_NAME（音乐库音频）
//   books       ← books/library.js BOOKS_DIR_NAME（书正文大文本）
//   chat-videos ← chat/attachments.js persistVideoAttachment（聊天视频；同上）
const STICKER_DIRECTORY = 'stickers';
const CHAT_IMAGE_DIRECTORY = 'chat-images';
const VOICE_DIRECTORY = 'voice';
const CHARACTER_PAYLOAD_DIRECTORY = 'characters';
const MUSIC_DIRECTORY = 'music';
const BOOKS_DIRECTORY = 'books';
const CHAT_VIDEO_DIRECTORY = 'chat-videos';

// 刻意**不登记**的目录（各有理由，别再"顺手补上"；tests 会断言它们仍在清单外）：
//   screen-watch/  截图是临时运行文件（滚动保留 20 张自动清扫），不是用户创作内容；
//                  评论文本在 AsyncStorage 键里随备份走，恢复后 imageUri 悬空不影响阅读。
//   local-models/  本地模型权重可重新下载，体积以 GB 计，进备份只会撑爆上限。
//   .transcripts/  会话压缩归档（L3）是内部中间产物，可由会话本身重建。
//   workspace/     工作区文件（含克隆的仓库快照）可达 GB 级；是否入备份属产品决策，本批不动。
export const BACKUP_MEDIA_DIRECTORIES = Object.freeze([
  AVATAR_DIRECTORY,
  STICKER_DIRECTORY,
  CHAT_IMAGE_DIRECTORY,
  VOICE_DIRECTORY,
  CHARACTER_PAYLOAD_DIRECTORY,
  FORGE_MEDIA_DIRECTORY,
  MUSIC_DIRECTORY,
  BOOKS_DIRECTORY,
  CHAT_VIDEO_DIRECTORY,
]);

// 导出侧口径 = 本表 ∪ **保险箱保护的全部字段**，必须取并集：
// 保险箱保护哪些字段，备份就必须清掉哪些字段，否则「盘上只有引用」这条保护会被备份绕过
// ——旧明文数据尤其如此（`secure:v1:` 前缀判定救不了从没被保护过的老值：实测
//  mcpToken / githubToken / headers 里的 Bearer token 都会被原样写进备份包）。
// 本表额外收 `secret`/`password`/`token`/`accessToken`/`refreshToken` 这类通用名：
// 备份里清掉它们是安全的（备份本就不该带密钥），而保险箱收通用名会把非密钥字段也搬进
// 安全存储，所以两边**故意不同**，但必须是包含关系——包含关系由这里的展开保证，不再靠注释同步。
// 精确匹配密钥字段名，不做子串匹配：否则 `maxTokens`（含 token）、`apiKeyUrl`（含 apiKey）
// 这类正常字段会被整段清空，导出/恢复后用户配置静默丢失。
const SECRET_FIELD_NAMES = new Set([
  ...SECRET_FIELDS,
  'secret', 'password', 'token', 'accessToken', 'refreshToken',
]);

function isSecretFieldName(key) {
  return SECRET_FIELD_NAMES.has(String(key));
}

// 对象形态的密钥字段（MCP 自定义请求头）：键名用户自定，只能整体处理——
// **值全部清空、键名保留**，让用户恢复后知道「这里原本配了头，要重填」。
function isSecretObjectFieldName(key) {
  return SECRET_OBJECT_FIELDS.has(String(key));
}

function blankSecretObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.fromEntries(Object.keys(value).map(name => [name, '']));
}

export function sanitizeBackupValue(value, key = '') {
  if (isSecretFieldName(key)) return '';
  if (isSecretObjectFieldName(key)) return blankSecretObject(value);
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
  if (isSecretObjectFieldName(key)) return blankSecretObject(value);
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
