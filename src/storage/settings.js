// 应用设置存储领域：思考 / 采样 / 图像生成 / 聊天选项 / 外观 / 配图 / 语音播报 /
// 记忆总结 / 插件 / 免责声明与引导。从 src/storage.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { isKnownImageProvider } from '../imageGen/providers.js';
import { normalizeImagePosition } from '../inlineImagePrompt.js';
import {
  backupCorruptValue,
  readJson,
  readJsonStatusWithSecrets,
  readJsonWithSecrets,
  setJsonWithSecrets,
} from './io.js';

const DISCLAIMER_ACK_KEY = '@easychat2_disclaimer_ack';
const ONBOARDING_DONE_KEY = '@easychat2_onboarding_done';
const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';
const PLUGINS_KEY = '@easychat2_plugins';
const THINKING_KEY = '@easychat2_thinking';
const IMAGE_GEN_KEY = '@easychat2_image_gen';
const CHAT_OPTIONS_KEY = '@easychat2_chat_options';
const APPEARANCE_KEY = '@easychat2_appearance';
const INLINE_IMAGE_KEY = '@easychat2_inline_image';
const TTS_KEY = '@easychat2_tts';
const SAMPLING_KEY = '@easychat2_sampling';
const TRANSCRIPTION_KEY = '@easychat2_transcription';

const DEFAULT_THINKING = { enabled: false, level: 'medium', display: 'fold' };
export const THINKING_LEVELS = ['low', 'medium', 'high'];
export const THINKING_DISPLAYS = ['open', 'fold', 'off'];

function normalizeThinking(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled === true,
    level: THINKING_LEVELS.includes(source.level) ? source.level : DEFAULT_THINKING.level,
    display: THINKING_DISPLAYS.includes(source.display) ? source.display : DEFAULT_THINKING.display,
  };
}

export async function getThinkingSettings() {
  const raw = await readJson(THINKING_KEY, null);
  return normalizeThinking(raw);
}

export async function saveThinkingSettings(settings) {
  const normalized = normalizeThinking(settings);
  await AsyncStorage.setItem(THINKING_KEY, JSON.stringify(normalized));
  return normalized;
}

export const SAMPLING_FIELDS = {
  maxTokens: { min: 1, max: 128000, integer: true, default: 8024 },
  temperature: { min: 0, max: 2, integer: false, default: 1 },
  topP: { min: 0, max: 1, integer: false, default: 1 },
  topK: { min: 0, max: 50, integer: true, default: 0 },
};

function clampSamplingField(name, raw) {
  const rule = SAMPLING_FIELDS[name];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = source.enabled === true;
  const rawValue = source.value;
  const isEmpty = rawValue === null || rawValue === undefined || rawValue === '';
  const parsed = isEmpty ? NaN : Number(rawValue);
  let value = Number.isFinite(parsed) ? parsed : rule.default;
  if (rule.integer) value = Math.round(value);
  value = Math.min(rule.max, Math.max(rule.min, value));
  return { enabled, value };
}

function normalizeSampling(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.keys(SAMPLING_FIELDS).forEach(name => {
    result[name] = clampSamplingField(name, source[name]);
  });
  return result;
}

export async function getSamplingSettings() {
  const raw = await readJson(SAMPLING_KEY, null);
  return normalizeSampling(raw);
}

export async function saveSamplingSettings(settings) {
  const normalized = normalizeSampling(settings);
  await AsyncStorage.setItem(SAMPLING_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizeImageProviderId(value) {
  const id = String(value || '');
  return isKnownImageProvider(id) ? id : '';
}

function normalizeImageGenProvider(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let extra = {};
  if (typeof source.extra === 'string') {
    try {
      const parsed = JSON.parse(source.extra);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed;
    } catch (error) {
      extra = {};
    }
  } else if (source.extra && typeof source.extra === 'object' && !Array.isArray(source.extra)) {
    extra = source.extra;
  }
  return {
    apiKey: String(source.apiKey || ''),
    baseUrl: String(source.baseUrl || ''),
    model: String(source.model || ''),
    extra,
  };
}

function normalizeImageGenSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const providers = {};
  const list = source.providers && typeof source.providers === 'object' && !Array.isArray(source.providers)
    ? source.providers
    : {};
  Object.entries(list).forEach(([id, value]) => {
    if (isKnownImageProvider(String(id))) providers[String(id)] = normalizeImageGenProvider(value);
  });
  return {
    activeProvider: normalizeImageProviderId(source.activeProvider),
    providers,
  };
}

export async function getImageGenSettings() {
  const raw = await readJsonWithSecrets(IMAGE_GEN_KEY, null);
  return normalizeImageGenSettings(raw);
}

export async function saveImageGenSettings(settings) {
  const normalized = normalizeImageGenSettings(settings);
  await setJsonWithSecrets(IMAGE_GEN_KEY, normalized);
  return normalized;
}

function normalizeChatOptions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    streaming: source.streaming !== false,
    fullWidth: source.fullWidth === true,
    // 含 <style>/<script> 的助手消息是否用 WebView 渲染；缺省开启。
    richHtml: source.richHtml !== false,
    // 是否按会话保留输入框草稿；缺省关闭，避免改变既有用户预期。
    keepDraft: source.keepDraft === true,
    // 时间感知：开启后在每次请求系统提示里附上当前日期时间；缺省关闭。
    timeAware: source.timeAware === true,
  };
}

export async function getChatOptions() {
  const raw = await readJson(CHAT_OPTIONS_KEY, null);
  return normalizeChatOptions(raw);
}

export async function saveChatOptions(options) {
  const normalized = normalizeChatOptions(options);
  await AsyncStorage.setItem(CHAT_OPTIONS_KEY, JSON.stringify(normalized));
  return normalized;
}

const THEME_IDS = ['dark', 'light', 'blue', 'pink', 'crimson'];
const FONT_SCALE_IDS = ['default', 'system', 'small', 'medium', 'large', 'xlarge'];
const DEFAULT_APPEARANCE = { themeId: 'dark', fontScaleId: 'default' };

function normalizeAppearance(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    themeId: THEME_IDS.includes(source.themeId) ? source.themeId : DEFAULT_APPEARANCE.themeId,
    fontScaleId: FONT_SCALE_IDS.includes(source.fontScaleId)
      ? source.fontScaleId
      : DEFAULT_APPEARANCE.fontScaleId,
  };
}

export async function getAppearanceSettings() {
  const raw = await readJson(APPEARANCE_KEY, null);
  return normalizeAppearance(raw);
}

export async function saveAppearanceSettings(settings) {
  const normalized = normalizeAppearance(settings);
  await AsyncStorage.setItem(APPEARANCE_KEY, JSON.stringify(normalized));
  return normalized;
}

const DEFAULT_INLINE_IMAGE = {
  enabled: false,
  providerId: '',
  stylePrefix: '',
  size: '832*1216',
  maxPromptChars: 400,
  imagePosition: 'end',
};

function normalizeInlineImage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxPromptChars = Number(source.maxPromptChars);
  return {
    enabled: source.enabled === true,
    providerId: normalizeImageProviderId(source.providerId),
    stylePrefix: String(source.stylePrefix || ''),
    size: String(source.size || DEFAULT_INLINE_IMAGE.size),
    maxPromptChars: Number.isFinite(maxPromptChars) && maxPromptChars > 0
      ? Math.min(Math.round(maxPromptChars), 2000)
      : DEFAULT_INLINE_IMAGE.maxPromptChars,
    // 配图取「回复的哪一段」：开头 / 高潮正中间 / 结尾（默认结尾）。
    imagePosition: normalizeImagePosition(source.imagePosition),
  };
}

export async function getInlineImageSettings() {
  const raw = await readJson(INLINE_IMAGE_KEY, null);
  return normalizeInlineImage(raw);
}

export async function saveInlineImageSettings(settings) {
  const normalized = normalizeInlineImage(settings);
  await AsyncStorage.setItem(INLINE_IMAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

const DEFAULT_TTS = { autoBroadcast: false, activeProvider: 'system', providers: {} };

function normalizeTtsProvider(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.entries(source).forEach(([key, value]) => {
    result[String(key)] = value === undefined || value === null ? '' : String(value);
  });
  return result;
}

function normalizeTts(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const providers = {};
  const list = source.providers && typeof source.providers === 'object' && !Array.isArray(source.providers)
    ? source.providers
    : {};
  Object.entries(list).forEach(([id, value]) => {
    providers[String(id)] = normalizeTtsProvider(value);
  });
  // 历史字段 enabled 语义是「自动播报开关」，迁移到 autoBroadcast；
  // 手动播报不再受该开关限制，因此这里只保留自动播报这一个开关。
  const autoBroadcast = source.autoBroadcast !== undefined
    ? source.autoBroadcast === true
    : source.enabled === true;
  return {
    autoBroadcast,
    activeProvider: String(source.activeProvider || DEFAULT_TTS.activeProvider),
    providers,
  };
}

export async function getTtsSettings() {
  // 损坏保护与同仓其他模块一致：先备份原始值再抛错。
  // 直接回落默认值会让面板保存时用默认覆盖损坏数据，属不可逆丢失。
  const stored = await readJsonStatusWithSecrets(TTS_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)))
  ) {
    await backupCorruptValue(TTS_KEY);
    throw new Error('语音播报设置读取失败');
  }
  if (stored.status === 'missing') return normalizeTts(null);
  return normalizeTts(stored.value);
}

export async function saveTtsSettings(settings) {
  const normalized = normalizeTts(settings);
  await setJsonWithSecrets(TTS_KEY, normalized);
  return normalized;
}

// 语音转文字（STT）配置：与 vector / imageGen 同构的多配置 + 密钥保险箱。
// activeId 为 '' 表示「不使用独立配置，仅复用当前聊天来源」（默认，需求 4.5）。
export function normalizeTranscriptionSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(source.configs) ? source.configs : [];
  const configs = list
    .map(item => ({
      id: String((item && item.id) || ''),
      name: String((item && item.name) || '').trim(),
      baseUrl: String((item && item.baseUrl) || '').trim(),
      apiKey: String((item && item.apiKey) || ''),
      model: String((item && item.model) || '').trim() || 'whisper-1',
    }))
    .filter(item => item.id);
  const activeId = configs.some(item => item.id === source.activeId)
    ? String(source.activeId)
    : '';
  return { activeId, configs };
}

export async function getTranscriptionSettings() {
  const stored = await readJsonStatusWithSecrets(TRANSCRIPTION_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)))
  ) {
    await backupCorruptValue(TRANSCRIPTION_KEY);
    throw new Error('语音转文字设置读取失败');
  }
  if (stored.status === 'missing') return normalizeTranscriptionSettings(null);
  return normalizeTranscriptionSettings(stored.value);
}

export async function saveTranscriptionSettings(settings) {
  const normalized = normalizeTranscriptionSettings(settings);
  await setJsonWithSecrets(TRANSCRIPTION_KEY, normalized);
  return normalized;
}

const DEFAULT_MEMORY_SUMMARY = { enabled: true, threshold: 40 };

function normalizeMemorySummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const threshold = Math.trunc(Number(source && source.threshold));
  return {
    enabled: source ? source.enabled === true : DEFAULT_MEMORY_SUMMARY.enabled,
    threshold: Number.isFinite(threshold) && threshold > 0
      ? threshold
      : DEFAULT_MEMORY_SUMMARY.threshold,
  };
}

export async function getMemorySummarySettings() {
  const raw = await readJson(MEMORY_SUMMARY_KEY, null);
  return normalizeMemorySummary(raw);
}

export async function saveMemorySummarySettings(settings) {
  const normalized = normalizeMemorySummary(settings);
  await AsyncStorage.setItem(MEMORY_SUMMARY_KEY, JSON.stringify(normalized));
  return normalized;
}

const DEFAULT_PLUGINS = [
  {
    id: 'web-search',
    name: '联网搜索',
    description: '角色可搜索网络信息，结合时事回答。',
    type: 'web-search',
    enabled: false,
    config: {
      provider: 'serpapi',
      apiKey: '',
      cx: '',
      customBaseUrl: '',
      maxResults: 5,
    },
  },
];

// Bing Search API 已于 2025-08-11 停服（微软 2025-05 公告），不再列入供应商：
// 存量 bing 配置会被规范化回该插件的默认 provider。
const PLUGIN_PROVIDERS = ['serpapi', 'google-cse', 'brave', 'tavily', 'custom'];

function normalizePlugin(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const preset = DEFAULT_PLUGINS.find(item => item.id === source.id);
  const defaultConfig = (preset && preset.config) || {};
  const config = source.config && typeof source.config === 'object' && !Array.isArray(source.config)
    ? source.config
    : {};
  const rawProvider = String(config.provider || '').trim();
  const provider = PLUGIN_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : (defaultConfig.provider || 'serpapi');
  // 存量供应商已停服/移除（如 Bing，2025-08 停服）被换源时留下迁移标记，
  // 由设置面板读取后给出一次性可见提示——不做无痕静默换源。
  const providerMigrated = rawProvider && !PLUGIN_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : '';
  const maxResults = Math.trunc(Number(config.maxResults));
  return {
    id: String(source.id || `plugin-${index}`),
    name: String(source.name || (preset && preset.name) || `联网搜索 ${index + 1}`),
    description: String(source.description || (preset && preset.description) || ''),
    type: String(source.type || (preset && preset.type) || ''),
    enabled: source.enabled === true,
    config: {
      provider,
      apiKey: String(config.apiKey || ''),
      cx: String(config.cx || ''),
      customBaseUrl: String(config.customBaseUrl || ''),
      maxResults: Number.isFinite(maxResults) && maxResults > 0
        ? Math.min(maxResults, 10)
        : 5,
      ...(providerMigrated ? { providerMigrated } : {}),
    },
  };
}

function buildDefaultPlugins() {
  return DEFAULT_PLUGINS.map(preset => normalizePlugin(preset));
}

export async function getPlugins() {
  const stored = await readJsonStatusWithSecrets(PLUGINS_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    // 插件配置此前读失败会直接用默认值整表覆盖。先备份原值再返回默认，且本次不落盘，
    // 避免把用户填过的密钥 / 开关不可逆地冲掉。
    await backupCorruptValue(PLUGINS_KEY);
    return buildDefaultPlugins();
  }
  const list = stored.status === 'ok' ? stored.value.map(normalizePlugin) : [];
  let changed = stored.status === 'missing';
  DEFAULT_PLUGINS.forEach(preset => {
    if (!list.some(item => item.id === preset.id)) {
      list.push(normalizePlugin(preset));
      changed = true;
    }
  });
  if (changed) {
    try {
      await setJsonWithSecrets(PLUGINS_KEY, list);
    } catch (error) {}
  }
  return list;
}

export async function savePlugins(plugins) {
  const list = (Array.isArray(plugins) ? plugins : []).map(normalizePlugin);
  DEFAULT_PLUGINS.forEach(preset => {
    if (!list.some(item => item.id === preset.id)) {
      list.push(normalizePlugin(preset));
    }
  });
  await setJsonWithSecrets(PLUGINS_KEY, list);
  return list;
}

export async function getEnabledPlugins() {
  const list = await getPlugins();
  return list.filter(plugin => plugin.enabled === true);
}

// 免责声明版本：条款变更时 bump——存量用户已确认的是旧版本号，
// 首启会重新弹出确认，保证新条款对全部用户生效（法律效力前提）。
export const DISCLAIMER_VERSION = 2;

export async function isDisclaimerAcknowledged() {
  const raw = await AsyncStorage.getItem(DISCLAIMER_ACK_KEY);
  return raw === String(DISCLAIMER_VERSION);
}

export async function acknowledgeDisclaimer() {
  await AsyncStorage.setItem(DISCLAIMER_ACK_KEY, String(DISCLAIMER_VERSION));
  return true;
}

export async function isOnboardingDone() {
  const raw = await AsyncStorage.getItem(ONBOARDING_DONE_KEY);
  return raw === 'true';
}

export async function completeOnboarding() {
  await AsyncStorage.setItem(ONBOARDING_DONE_KEY, 'true');
  return true;
}
