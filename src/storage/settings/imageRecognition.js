// 「图片识别（OCR）」配置存储 + 识别结果缓存。
//
// 与 src/storage/settings/ 下其他域同一范式：单键、读损坏先备份再回落默认、
// 写盘走 io.js 的 *WithSecrets 入口。
//
// **密钥纪律**：本模块**不存任何密钥**——只存一条既有 API 配置的 id（apiConfigId），
// 真正的 key 仍在 @easychat2_api_configs 里由保险箱（secretStore）保护。之所以不另造
// 一套 key 存储：上一批刚修过「MCP headers 明文落盘」与「导出备份带明文 token」两条
// 泄漏，新增第三条的唯一可靠办法就是**不复用密钥字段名、不自己存密钥**。
// 因此这里的字段名里没有 apiKey，secretStore.SECRET_FIELDS 不会命中它，
// dataBackup 的脱敏表也不需要为它加例外（本来就没有可脱敏的东西）。
//
// **缓存为什么落在 AsyncStorage 而不是文件**：识别结果若落成新目录下的文件，就会成为
// 孤儿媒体回收器（storage/orphanMedia.js 只扫 stickers/avatars/chat-images）够不着的
// 孤儿文件。落键则完全没有文件生命周期问题，且天然跟着备份/恢复走。缓存条目按
// 内容 hash + 配置 + 模型 + 提示词 四元组做键：换配置/换模型/改提示词都会自然失效，
// 不会把上一个模型的结果当成新模型的结果用。

import {
  backupCorruptValue,
  readJsonStatus,
  setJsonRaw,
  setJsonWithSecrets,
} from '../io.js';
import { clampInt } from '../../utils/clampInt.js';

const IMAGE_RECOGNITION_KEY = '@easychat2_image_recognition';
const IMAGE_RECOGNITION_CACHE_KEY = '@easychat2_image_recognition_cache';

// 默认描述提示词：这是**发给模型的提示词**，按仓库铁律不进 i18n（翻译它会改变模型
// 行为，中文对话场景下英文关键词会直接失灵）。界面上「说明它的文案」才进 i18n。
// 必须 export：settings/index.js 的 barrel 会把它转发出去，而 ESM 的具名 re-export
// 在链接期校验——目标不导出会直接 SyntaxError（整条设置链加载失败）。
// 本文件已列入 eslint 的 no-hardcoded-chinese-text 永久豁免（提示词是中文的正确形态）。
export const DEFAULT_DESCRIPTION_PROMPT = [
  '客观描述这张图片的内容，供看不到图片的模型理解。',
  '请包含：画面主体与场景、可见的界面元素（按钮/列表/输入框等）、图中所有可见文字（原样抄写）、以及能看出的状态或异常。',
  '只描述你确实看到的内容，不要推测图片之外的信息。',
  '直接输出描述，不要加任何开场白或解释。',
].join('\n');

export const DEFAULT_MAX_OUTPUT_TOKENS = 512;
export const DEFAULT_TIMEOUT_SECONDS = 30;
// 并发上限默认 2：多图消息一次打爆接口（限流/超时）比串行慢更糟。
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;
export const MAX_TIMEOUT_SECONDS = 300;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_OUTPUT_TOKENS_LIMIT = 8192;
export const DEFAULT_CACHE_ENTRIES = 100;
export const MAX_CACHE_ENTRIES = 400;
// 单条描述的落库上限：缓存不是正文，超长描述既没必要也会把单个存储键顶到体积预算。
export const MAX_DESCRIPTION_CHARS = 2000;

// 看屏幕的画面识别来源：'main' = 现有路径（画面直接交给主模型），'ocr' = 先经图片
// 识别模型转成文字描述再交给主模型。**默认 'main'**：不改变既有行为。
export const SCREEN_WATCH_SOURCES = ['main', 'ocr'];
export const DEFAULT_SCREEN_WATCH_SOURCE = 'main';

// 整数夹取用唯一实现 utils/clampInt.js（此处曾有一份参数顺序不同的私有副本）。

function normalizeSource(value) {
  const raw = String(value || '');
  return SCREEN_WATCH_SOURCES.includes(raw) ? raw : DEFAULT_SCREEN_WATCH_SOURCE;
}

export function normalizeImageRecognitionSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const prompt = typeof source.descriptionPrompt === 'string'
    ? source.descriptionPrompt
    : DEFAULT_DESCRIPTION_PROMPT;
  return {
    enabled: source.enabled === true,
    // 复用既有 API 配置体系：这里只存 id，密钥仍在 apiConfigs 的保险箱里。
    apiConfigId: String(source.apiConfigId || ''),
    model: String(source.model || '').trim(),
    descriptionPrompt: prompt,
    maxOutputTokens: clampInt(source.maxOutputTokens, {
      min: 32, max: MAX_OUTPUT_TOKENS_LIMIT, fallback: DEFAULT_MAX_OUTPUT_TOKENS,
    }),
    timeoutSeconds: clampInt(source.timeoutSeconds, {
      min: MIN_TIMEOUT_SECONDS, max: MAX_TIMEOUT_SECONDS, fallback: DEFAULT_TIMEOUT_SECONDS,
    }),
    concurrency: clampInt(source.concurrency, {
      min: 1, max: MAX_CONCURRENCY, fallback: DEFAULT_CONCURRENCY,
    }),
    // 主模型本身支持识图时，是否把原图也一并交给它（描述仍然照发）。
    attachOriginal: source.attachOriginal === true,
    screenWatchSource: normalizeSource(source.screenWatchSource),
  };
}

export async function getImageRecognitionSettings() {
  // 与 TTS/图像生成一致：损坏时先另存原始值再回落默认，避免下次保存把损坏内容
  // 不可逆覆盖（用户填过的模型名/提示词会丢）。
  const stored = await readJsonStatus(IMAGE_RECOGNITION_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(IMAGE_RECOGNITION_KEY);
    return normalizeImageRecognitionSettings(null);
  }
  return normalizeImageRecognitionSettings(stored.value);
}

export async function saveImageRecognitionSettings(settings) {
  const normalized = normalizeImageRecognitionSettings(settings);
  // 配置走含密钥入口（与 settings/ 其它域一致）：当前没有密钥字段，但万一将来
  // 有人往这里加了同名字段，保险箱会兜住——**不能**为了省一次遍历而留下旁路。
  await setJsonWithSecrets(IMAGE_RECOGNITION_KEY, normalized);
  return normalized;
}

// ---- 识别结果缓存 ----

// 缓存键的四元组：内容 hash + 配置 id + 模型 + 提示词 hash。任何一项变了都算另一条
// 缓存——把旧模型/旧提示词的结果当成新的用，比没有缓存更糟（用户改了提示词却看不到
// 效果，会以为功能坏了）。
export function imageRecognitionCacheKey({ contentHash, configId, model, promptHash }) {
  const parts = [contentHash, configId, model, promptHash].map(value => String(value || ''));
  if (!parts[0]) return '';
  return parts.join('|');
}

function normalizeCacheEntry(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!source) return null;
  const description = String(source.description || '').trim();
  if (!description) return null;
  return {
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    at: Number(source.at) || 0,
  };
}

// 读整张缓存表。损坏时**不备份**：缓存是可再生的派生数据，为它留一份损坏副本
// 只会白占存储（与配置类存储的纪律相反，那里备份是因为内容不可再生）。
async function readCacheTable() {
  const stored = await readJsonStatus(IMAGE_RECOGNITION_CACHE_KEY);
  if (stored.status !== 'ok') return {};
  const source = stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value)
    ? stored.value
    : {};
  const entries = source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)
    ? source.entries
    : {};
  const out = {};
  Object.entries(entries).forEach(([key, value]) => {
    const entry = normalizeCacheEntry(value);
    if (key && entry) out[key] = entry;
  });
  return out;
}

// 按「最近使用」裁剪到上限：保留 at 最大的 N 条（写入时刷新 at）。
export function pruneImageRecognitionCache(entries, limit = DEFAULT_CACHE_ENTRIES) {
  const source = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  const max = clampInt(limit, { min: 1, max: MAX_CACHE_ENTRIES, fallback: DEFAULT_CACHE_ENTRIES });
  const list = Object.entries(source)
    .map(([key, value]) => ({ key, entry: normalizeCacheEntry(value) }))
    .filter(item => item.entry);
  if (list.length <= max) {
    return Object.fromEntries(list.map(item => [item.key, item.entry]));
  }
  list.sort((a, b) => b.entry.at - a.entry.at);
  return Object.fromEntries(list.slice(0, max).map(item => [item.key, item.entry]));
}

export async function readImageRecognitionCache(key) {
  const id = String(key || '');
  if (!id) return '';
  const table = await readCacheTable();
  const entry = table[id];
  return entry ? entry.description : '';
}

// 写缓存并顺手裁剪。写入失败**不抛**：缓存只是加速手段，写不进去不该让整次识别失败。
export async function writeImageRecognitionCache(key, description, { limit = DEFAULT_CACHE_ENTRIES } = {}) {
  const id = String(key || '');
  const text = String(description || '').trim().slice(0, MAX_DESCRIPTION_CHARS);
  if (!id || !text) return false;
  try {
    const table = await readCacheTable();
    table[id] = { description: text, at: Date.now() };
    await setJsonRaw(IMAGE_RECOGNITION_CACHE_KEY, { entries: pruneImageRecognitionCache(table, limit) });
    return true;
  } catch (error) {
    return false;
  }
}

// 仅测试用：清空缓存键（缓存是派生数据，清掉不影响任何用户配置）。
export async function clearImageRecognitionCache() {
  try {
    await setJsonRaw(IMAGE_RECOGNITION_CACHE_KEY, { entries: {} });
    return true;
  } catch (error) {
    return false;
  }
}

// DEFAULT_DESCRIPTION_PROMPT 已用 export 前缀直接导出（见上）；这里只补两个存储键。
export { IMAGE_RECOGNITION_KEY, IMAGE_RECOGNITION_CACHE_KEY };