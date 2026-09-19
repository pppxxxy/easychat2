import AsyncStorage from '@react-native-async-storage/async-storage';

import GLOBAL_PRESETS from './presets';
import {
  buildClonedSession,
  buildPreview,
  createEmptySession,
  createGroupSession as buildGroupSession,
  normalizeSession,
  regenerateMessageIds,
  sortSessions,
} from './context/sessionLibrary';

const API_CONFIG_KEY = '@easychat2_api_config';
const API_CONFIGS_KEY = '@easychat2_api_configs';
const USER_PROFILE_KEY = '@easychat2_user_profile';
const PERSONAS_KEY = '@easychat2_personas';
const ACTIVE_PERSONA_KEY = '@easychat2_active_persona';
const GLOBAL_PRESETS_KEY = '@easychat2_global_presets';
const PRESET_LIST_KEY = '@easychat2_preset_list';
const CHARACTER_KEY = '@easychat2_character';
const CHARACTERS_KEY = '@easychat2_characters';
const ACTIVE_CHARACTER_KEY = '@easychat2_active_character';
const DISCLAIMER_ACK_KEY = '@easychat2_disclaimer_ack';
const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';
const PLUGINS_KEY = '@easychat2_plugins';
const THINKING_KEY = '@easychat2_thinking';
const IMAGE_GEN_KEY = '@easychat2_image_gen';
const CHAT_OPTIONS_KEY = '@easychat2_chat_options';
const APPEARANCE_KEY = '@easychat2_appearance';
const INLINE_IMAGE_KEY = '@easychat2_inline_image';
const TTS_KEY = '@easychat2_tts';
const SAMPLING_KEY = '@easychat2_sampling';
const VECTOR_MEMORY_KEY = '@easychat2_vector_memory';
const VECTOR_INDEX_PREFIX = '@easychat2_vector_index';
const MOMENTS_SETTINGS_KEY = '@easychat2_moments_settings';
const MOMENTS_KEY = '@easychat2_moments';
const AFFINITY_KEY = '@easychat2_affinity';
const SESSIONS_KEY = '@easychat2_sessions';
const SESSION_SUMMARIES_PREFIX = '@easychat2_session_summaries';
const ACTIVE_SESSION_KEY = '@easychat2_active_session';
const MESSAGES_KEY_PREFIX = '@easychat2_messages';
const LEGACY_MESSAGES_KEY = '@easychat2_messages';

const DEFAULT_API_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: ''
};

export const DEFAULT_CHARACTER = {
  id: 'default',
  name: 'EasyChat2 助手',
  systemPrompt: '你是 EasyChat2 的智能助手，回答简洁清晰。',
  systemPromptComposed: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '',
  nudgeText: '',
  creatorNotes: '',
  postHistoryInstructions: '',
  tags: [],
  worldInfo: [],
  regexScripts: [],
  avatarUri: '',
  bgUri: '',
  lastUsedAt: 0
};

function messagesKey(characterId) {
  return `${MESSAGES_KEY_PREFIX}::${characterId || DEFAULT_CHARACTER.id}`;
}

function sessionMessagesKey(sessionId) {
  return `${MESSAGES_KEY_PREFIX}::${sessionId}`;
}

function legacySessionId(characterId) {
  return `legacy-${characterId}`;
}

async function readJson(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

async function readJsonStatus(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    return { status: 'ok', value: JSON.parse(raw) };
  } catch (error) {
    return { status: 'corrupt' };
  }
}

function normalizeCharacter(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const merged = { ...DEFAULT_CHARACTER, ...source };
  merged.id = String(merged.id || DEFAULT_CHARACTER.id);
  const lastUsedAt = Number(merged.lastUsedAt);
  merged.lastUsedAt = Number.isFinite(lastUsedAt) ? lastUsedAt : 0;
  merged.pinned = merged.pinned === true;
  merged.tags = Array.isArray(merged.tags)
    ? merged.tags.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  merged.alternateGreetings = Array.isArray(merged.alternateGreetings)
    ? merged.alternateGreetings.map(item => String(item == null ? '' : item))
    : [];
  merged.mesExample = String(merged.mesExample || '');
  merged.nudgeText = String(merged.nudgeText || '');
  return merged;
}

function ensureUniqueCharacterIds(list) {
  const seen = new Set();
  return list.map((item, index) => {
    let id = String(item.id);
    if (seen.has(id)) {
      let candidate = `${id}-${index}`;
      let bump = index;
      while (seen.has(candidate)) {
        bump += 1;
        candidate = `${id}-${index}-${bump}`;
      }
      id = candidate;
    }
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

function ensureDefaultCharacter(list) {
  const items = ensureUniqueCharacterIds(Array.isArray(list) ? list.map(normalizeCharacter) : []);
  if (!items.some(item => item.id === DEFAULT_CHARACTER.id)) {
    items.unshift(normalizeCharacter(DEFAULT_CHARACTER));
  }
  return items;
}

export function sortCharacters(list) {
  return [...list].sort((a, b) => {
    const pinnedDiff = (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0);
    if (pinnedDiff !== 0) return pinnedDiff;
    const diff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

async function persistLibrary(list) {
  await AsyncStorage.setItem(CHARACTERS_KEY, JSON.stringify(list));
}

export async function getCharacterLibrary() {
  const stored = await readJsonStatus(CHARACTERS_KEY);
  let items;
  let needsPersist = false;

  if (stored.status === 'ok' && Array.isArray(stored.value)) {
    items = stored.value.map(normalizeCharacter);
  } else if (stored.status === 'missing') {
    const legacy = await readJsonStatus(CHARACTER_KEY);
    if (legacy.status === 'ok' && legacy.value && typeof legacy.value === 'object') {
      const migrated = normalizeCharacter(legacy.value);
      items = [migrated];
      const active = await getActiveCharacterId();
      if (!active) {
        try {
          await setActiveCharacterId(migrated.id);
        } catch (error) {}
      }
    } else {
      items = [];
    }
    needsPersist = true;
  } else {
    items = [];
    needsPersist = true;
  }

  const hadDefault = items.some(item => item.id === DEFAULT_CHARACTER.id);
  const list = sortCharacters(ensureDefaultCharacter(items));
  if (needsPersist || !hadDefault) {
    try {
      await persistLibrary(list);
    } catch (error) {}
  }
  return list;
}

export async function saveCharacterLibrary(list) {
  const next = sortCharacters(ensureDefaultCharacter(list));
  await persistLibrary(next);
  return next;
}

export async function saveCharacterState(list, activeId, deletedId) {
  const previousList = await AsyncStorage.getItem(CHARACTERS_KEY);
  let librarySaved = false;
  try {
    await saveCharacterLibrary(list);
    librarySaved = true;
    await setActiveCharacterId(activeId);
  } catch (error) {
    if (librarySaved) {
      try {
        if (previousList === null) await AsyncStorage.removeItem(CHARACTERS_KEY);
        else await AsyncStorage.setItem(CHARACTERS_KEY, previousList);
      } catch (rollbackError) {
        throw new Error('角色保存失败，存储回滚失败，请重新打开应用检查。');
      }
    }
    throw error;
  }
  if (deletedId && deletedId !== DEFAULT_CHARACTER.id) {
    try {
      await AsyncStorage.removeItem(messagesKey(deletedId));
    } catch (error) {}
  }
}

export async function getActiveCharacterId() {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_CHARACTER_KEY);
    return raw ? String(JSON.parse(raw)) : '';
  } catch (error) {
    return '';
  }
}

export async function setActiveCharacterId(id) {
  await AsyncStorage.setItem(
    ACTIVE_CHARACTER_KEY,
    JSON.stringify(String(id || DEFAULT_CHARACTER.id))
  );
}

export async function getActiveCharacter() {
  const list = await getCharacterLibrary();
  const activeId = await getActiveCharacterId();
  const found = activeId ? list.find(character => character.id === activeId) : null;
  if (found) return found;
  const fallback = list.find(character => character.id === DEFAULT_CHARACTER.id)
    || normalizeCharacter(DEFAULT_CHARACTER);
  try {
    await setActiveCharacterId(fallback.id);
  } catch (error) {}
  return fallback;
}

export async function upsertCharacter(character) {
  const list = await getCharacterLibrary();
  const normalized = normalizeCharacter(character);
  const exists = list.some(item => item.id === normalized.id);
  const next = exists
    ? list.map(item => (item.id === normalized.id ? normalized : item))
    : [...list, normalized];
  return saveCharacterLibrary(next);
}

export async function deleteCharacter(characterId) {
  const list = await getCharacterLibrary();
  const next = list.filter(item => item.id !== characterId);
  const saved = await saveCharacterLibrary(next);
  if (characterId && characterId !== DEFAULT_CHARACTER.id) {
    try {
      await AsyncStorage.removeItem(messagesKey(characterId));
    } catch (error) {}
  }
  return saved;
}

function makeApiConfigId() {
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeApiConfig(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const legacyModel = String(source.model || source.activeModel || DEFAULT_API_CONFIG.model);
  const rawModels = Array.isArray(source.models)
    ? source.models.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const models = rawModels.length ? rawModels : [legacyModel];
  const requestedActive = String(source.activeModel || '');
  const activeModel = models.includes(requestedActive)
    ? requestedActive
    : (models.includes(legacyModel) ? legacyModel : models[0]);
  return {
    id: String(source.id || `cfg-${index}`),
    name: String(source.name || `配置 ${index + 1}`),
    baseUrl: String(source.baseUrl || DEFAULT_API_CONFIG.baseUrl),
    apiKey: String(source.apiKey || ''),
    models,
    activeModel,
    supportsThinking: source.supportsThinking === true,
    supportsVision: source.supportsVision === true,
    thinking: {
      field: String((source.thinking && source.thinking.field) || 'reasoning_effort')
        || 'reasoning_effort',
      format: ['effort', 'boolean', 'object'].includes(source.thinking && source.thinking.format)
        ? source.thinking.format
        : 'effort',
    },
  };
}

export function getActiveModel(config) {
  if (!config) return DEFAULT_API_CONFIG.model;
  return String(config.activeModel || '')
    || (Array.isArray(config.models) && config.models[0])
    || String(config.model || '')
    || DEFAULT_API_CONFIG.model;
}

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

export function normalizeVectorMemoryConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const topK = Math.trunc(Number(source.topK));
  const maxChars = Math.trunc(Number(source.maxChars));
  const batchSize = Math.trunc(Number(source.batchSize));
  return {
    enabled: source.enabled === true,
    providerId: String(source.providerId || 'openai-embeddings'),
    baseUrl: String(source.baseUrl || 'https://api.openai.com/v1'),
    apiKey: String(source.apiKey || ''),
    model: String(source.model || 'text-embedding-3-small'),
    topK: Number.isFinite(topK) && topK > 0 ? Math.min(20, topK) : 5,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.min(2000, maxChars) : 400,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? Math.min(64, batchSize) : 16,
  };
}

export async function getVectorMemoryConfig() {
  const raw = await readJson(VECTOR_MEMORY_KEY, null);
  return normalizeVectorMemoryConfig(raw);
}

export async function saveVectorMemoryConfig(config) {
  const normalized = normalizeVectorMemoryConfig(config);
  await AsyncStorage.setItem(VECTOR_MEMORY_KEY, JSON.stringify(normalized));
  return normalized;
}

function vectorIndexKey(characterId) {
  return `${VECTOR_INDEX_PREFIX}::${String(characterId || 'default')}`;
}

export async function getVectorIndex(characterId) {
  const stored = await readJson(vectorIndexKey(characterId), []);
  if (!Array.isArray(stored)) return [];
  return stored.filter(item => item && item.id && typeof item.text === 'string');
}

export async function saveVectorIndex(characterId, index) {
  const list = (Array.isArray(index) ? index : [])
    .filter(item => item && item.id && typeof item.text === 'string')
    .map(item => ({
      id: String(item.id),
      messageId: String(item.messageId || ''),
      role: String(item.role || ''),
      at: Number(item.at) || 0,
      text: String(item.text),
      vector: Array.isArray(item.vector) ? item.vector.map(Number) : [],
    }));
  await AsyncStorage.setItem(vectorIndexKey(characterId), JSON.stringify(list));
  return list;
}

export async function clearVectorIndex(characterId) {
  try {
    await AsyncStorage.removeItem(vectorIndexKey(characterId));
  } catch (error) {}
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
    providers[String(id)] = normalizeImageGenProvider(value);
  });
  return {
    activeProvider: String(source.activeProvider || ''),
    providers,
  };
}

export async function getImageGenSettings() {
  const raw = await readJson(IMAGE_GEN_KEY, null);
  return normalizeImageGenSettings(raw);
}

export async function saveImageGenSettings(settings) {
  const normalized = normalizeImageGenSettings(settings);
  await AsyncStorage.setItem(IMAGE_GEN_KEY, JSON.stringify(normalized));
  return normalized;
}

const DEFAULT_CHAT_OPTIONS = { streaming: true, fullWidth: false };

function normalizeChatOptions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    streaming: source.streaming !== false,
    fullWidth: source.fullWidth === true,
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
};

function normalizeInlineImage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxPromptChars = Number(source.maxPromptChars);
  return {
    enabled: source.enabled === true,
    providerId: String(source.providerId || ''),
    stylePrefix: String(source.stylePrefix || ''),
    size: String(source.size || DEFAULT_INLINE_IMAGE.size),
    maxPromptChars: Number.isFinite(maxPromptChars) && maxPromptChars > 0
      ? Math.min(Math.round(maxPromptChars), 2000)
      : DEFAULT_INLINE_IMAGE.maxPromptChars,
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

const DEFAULT_TTS = { enabled: false, activeProvider: 'system', providers: {} };

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
  return {
    enabled: source.enabled === true,
    activeProvider: String(source.activeProvider || DEFAULT_TTS.activeProvider),
    providers,
  };
}

export async function getTtsSettings() {
  const raw = await readJson(TTS_KEY, null);
  return normalizeTts(raw);
}

export async function saveTtsSettings(settings) {
  const normalized = normalizeTts(settings);
  await AsyncStorage.setItem(TTS_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizeMomentsSettings(raw) {
  if (raw === null || raw === undefined) return { enabled: true };
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { enabled: source.enabled !== false };
}

export async function getMomentsSettings() {
  const raw = await readJson(MOMENTS_SETTINGS_KEY, null);
  return normalizeMomentsSettings(raw);
}

export async function saveMomentsSettings(settings) {
  const normalized = normalizeMomentsSettings(settings);
  await AsyncStorage.setItem(MOMENTS_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizeMoment(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const likes = Array.isArray(source.likes) ? source.likes.filter(item => item && typeof item === 'object') : [];
  const comments = Array.isArray(source.comments)
    ? source.comments.filter(item => item && typeof item === 'object')
    : [];
  return {
    id: String(source.id || ''),
    characterId: String(source.characterId || ''),
    characterName: String(source.characterName || ''),
    avatarUri: String(source.avatarUri || ''),
    trigger: String(source.trigger || ''),
    text: String(source.text || ''),
    createdAt: Number(source.createdAt) || 0,
    likedByUser: source.likedByUser === true,
    likes,
    comments,
  };
}

export async function getMoments() {
  const raw = await readJson(MOMENTS_KEY, null);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeMoment)
    .filter(item => item.id)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveMoments(moments) {
  const list = Array.isArray(moments) ? moments.map(normalizeMoment).filter(item => item.id) : [];
  await AsyncStorage.setItem(MOMENTS_KEY, JSON.stringify(list));
  return list;
}

function normalizeAffinityState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.entries(source).forEach(([id, value]) => {
    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    result[String(id)] = {
      score: Number(entry.score) || 0,
      turnCount: Number(entry.turnCount) || 0,
      triggers: Array.isArray(entry.triggers)
        ? entry.triggers.filter(item => typeof item === 'string')
        : [],
    };
  });
  return result;
}

export async function getAffinity() {
  const raw = await readJson(AFFINITY_KEY, null);
  return normalizeAffinityState(raw);
}

export async function saveAffinity(map) {
  const normalized = normalizeAffinityState(map);
  await AsyncStorage.setItem(AFFINITY_KEY, JSON.stringify(normalized));
  return normalized;
}

function ensureUniqueApiConfigIds(list) {
  const seen = new Set();
  return list.map((item, index) => {
    let id = String(item.id);
    if (seen.has(id)) {
      let candidate = `${id}-${index}`;
      let bump = index;
      while (seen.has(candidate)) {
        bump += 1;
        candidate = `${id}-${index}-${bump}`;
      }
      id = candidate;
    }
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

async function persistApiConfigs(configs, activeId) {
  await AsyncStorage.setItem(
    API_CONFIGS_KEY,
    JSON.stringify({ configs, activeId })
  );
}

export async function getApiConfigs() {
  const raw = await AsyncStorage.getItem(API_CONFIGS_KEY);
  const stored = raw === null || raw === undefined ? null : JSON.parse(raw);
  if (raw !== null && raw !== undefined
    && (!stored || typeof stored !== 'object' || Array.isArray(stored) || !Array.isArray(stored.configs))) {
    throw new Error('API 配置格式错误');
  }
  let configs = [];
  let activeId = '';
  let needsPersist = false;

  if (stored) {
    configs = ensureUniqueApiConfigIds(stored.configs.map(normalizeApiConfig));
    activeId = String(stored.activeId || '');
  } else {
    const legacyRaw = await AsyncStorage.getItem(API_CONFIG_KEY);
    const legacy = legacyRaw === null || legacyRaw === undefined ? null : JSON.parse(legacyRaw);
    const seed = legacy && typeof legacy === 'object' && !Array.isArray(legacy)
      ? { ...legacy, id: 'default', name: '默认配置' }
      : { id: 'default', name: '默认配置' };
    configs = [normalizeApiConfig(seed, 0)];
    needsPersist = true;
  }

  if (configs.length === 0) {
    configs = [normalizeApiConfig({ id: 'default', name: '默认配置' }, 0)];
    needsPersist = true;
  }
  if (!configs.some(item => item.id === activeId)) {
    activeId = configs[0].id;
    needsPersist = true;
  }
  if (needsPersist) {
    try {
      await persistApiConfigs(configs, activeId);
    } catch (error) {}
  }
  return { configs, activeId };
}

export async function saveApiConfigs(configs, activeId) {
  const normalized = ensureUniqueApiConfigIds(
    (Array.isArray(configs) ? configs : []).map(normalizeApiConfig)
  );
  const list = normalized.length
    ? normalized
    : [normalizeApiConfig({ id: 'default', name: '默认配置' }, 0)];
  const resolvedActive = list.some(item => item.id === activeId)
    ? String(activeId)
    : list[0].id;
  await persistApiConfigs(list, resolvedActive);
  return { configs: list, activeId: resolvedActive };
}

export function createApiConfig(partial = {}) {
  return normalizeApiConfig({ id: makeApiConfigId(), ...partial });
}

export async function getActiveApiConfig() {
  const { configs, activeId } = await getApiConfigs();
  return configs.find(item => item.id === activeId) || configs[0];
}

export async function getCharacter() {
  return getActiveCharacter();
}

export async function saveCharacter(character) {
  await upsertCharacter(character);
  await setActiveCharacterId((character && character.id) || DEFAULT_CHARACTER.id);
  return character;
}

export async function getMessages(characterId = DEFAULT_CHARACTER.id) {
  let stored = await readJson(messagesKey(characterId), null);
  if (stored === null && characterId === DEFAULT_CHARACTER.id) {
    stored = await readJson(LEGACY_MESSAGES_KEY, null);
  }
  return Array.isArray(stored) ? stored.filter(item => item && !item.pending) : [];
}

export async function saveMessages(characterId, messages) {
  const persistable = (messages || []).filter(item => item && !item.pending);
  await AsyncStorage.setItem(messagesKey(characterId), JSON.stringify(persistable));
}

const DEFAULT_USER_PROFILE = { userName: '', persona: '', avatarUri: '', nudgeText: '' };
const DEFAULT_PERSONA_ID = 'default';

function makePersonaId(now = Date.now()) {
  return `persona-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePersona(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  return {
    id: String(source.id || '').trim() || makePersonaId(),
    userName: String(source.userName || ''),
    persona: String(source.persona || ''),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

function readGlobalProfileMeta(rawProfile) {
  const source = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
  return {
    avatarUri: String(source.avatarUri || ''),
    nudgeText: String(source.nudgeText || ''),
  };
}

function buildDefaultPersona(now = Date.now()) {
  return {
    id: DEFAULT_PERSONA_ID,
    userName: '',
    persona: '',
    createdAt: now,
    updatedAt: now,
  };
}

export async function getPersonas() {
  const stored = await readJson(PERSONAS_KEY, null);
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.map(normalizePersona);
  }
  const legacy = await readJson(USER_PROFILE_KEY, DEFAULT_USER_PROFILE);
  const now = Date.now();
  const migrated = {
    id: DEFAULT_PERSONA_ID,
    userName: String(legacy?.userName || ''),
    persona: String(legacy?.persona || ''),
    createdAt: now,
    updatedAt: now,
  };
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify([migrated]));
  const activeId = await getActivePersonaId([migrated]);
  if (!activeId) await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(DEFAULT_PERSONA_ID));
  else if (activeId !== DEFAULT_PERSONA_ID) {
    await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(migrated.id));
  }
  return [migrated];
}

export async function savePersonas(list) {
  const normalized = (Array.isArray(list) ? list : [])
    .map(normalizePersona)
    .filter(item => item.id);
  const safe = normalized.length > 0 ? normalized : [buildDefaultPersona()];
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(safe));
  return safe;
}

export async function getActivePersonaId(list) {
  const personas = Array.isArray(list) ? list : await getPersonas();
  if (personas.length === 0) return '';
  let stored = '';
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_PERSONA_KEY);
    stored = raw ? String(JSON.parse(raw)) : '';
  } catch (error) {
    stored = '';
  }
  if (stored && personas.some(item => item.id === stored)) return stored;
  return personas[0].id;
}

export async function setActivePersonaId(id) {
  const personas = await getPersonas();
  const target = personas.find(item => item.id === id);
  const resolved = target ? target.id : (personas[0] && personas[0].id) || '';
  await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(resolved));
  return resolved;
}

export async function getActivePersona() {
  const personas = await getPersonas();
  const activeId = await getActivePersonaId(personas);
  return personas.find(item => item.id === activeId) || personas[0];
}

export async function createPersona(partial = {}) {
  const personas = await getPersonas();
  const now = Date.now();
  const created = normalizePersona({
    id: makePersonaId(now),
    userName: String(partial.userName || ''),
    persona: String(partial.persona || ''),
    createdAt: now,
    updatedAt: now,
  });
  const next = [...personas, created];
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(next));
  await setActivePersonaId(created.id);
  return created;
}

export async function updatePersona(id, patch = {}) {
  const personas = await getPersonas();
  if (!personas.some(item => item.id === id)) throw new Error('人设不存在');
  const now = Date.now();
  const next = personas.map(item => (
    item.id === id
      ? {
        ...item,
        userName: patch.userName != null ? String(patch.userName) : item.userName,
        persona: patch.persona != null ? String(patch.persona) : item.persona,
        updatedAt: now,
      }
      : item
  ));
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(next));
  return next.find(item => item.id === id);
}

export async function deletePersona(id) {
  const personas = await getPersonas();
  if (personas.length <= 1) throw new Error('至少保留一个人设');
  const remaining = personas.filter(item => item.id !== id);
  if (remaining.length === personas.length) throw new Error('人设不存在');
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(remaining));
  const activeId = await getActivePersonaId(personas);
  const resolved = activeId === id ? remaining[0].id : activeId;
  await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(resolved));
  return { personas: remaining, activeId: resolved };
}

export async function getUserProfile() {
  const global = await readJson(USER_PROFILE_KEY, DEFAULT_USER_PROFILE);
  const meta = readGlobalProfileMeta(global);
  const personas = await getPersonas();
  const activeId = await getActivePersonaId(personas);
  const active = personas.find(item => item.id === activeId) || personas[0];
  return {
    userName: String(active?.userName || ''),
    persona: String(active?.persona || ''),
    avatarUri: meta.avatarUri,
    nudgeText: meta.nudgeText,
  };
}

export async function saveUserProfile(profile) {
  const personas = await getPersonas();
  const activeId = await getActivePersonaId(personas);
  const now = Date.now();
  const next = personas.map(item => (
    item.id === activeId
      ? {
        ...item,
        userName: String(profile?.userName || ''),
        persona: String(profile?.persona || ''),
        updatedAt: now,
      }
      : item
  ));
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(next));
  const global = await readJson(USER_PROFILE_KEY, DEFAULT_USER_PROFILE);
  const meta = readGlobalProfileMeta(global);
  await AsyncStorage.setItem(
    USER_PROFILE_KEY,
    JSON.stringify({
      userName: String(profile?.userName || ''),
      persona: String(profile?.persona || ''),
      avatarUri: String(profile?.avatarUri ?? meta.avatarUri ?? ''),
      nudgeText: String(profile?.nudgeText ?? meta.nudgeText ?? ''),
    })
  );
}

function normalizePreset(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.id !== 'string' || !source.id.trim()
    || typeof source.name !== 'string' || !source.name.trim()
    || typeof source.prompt !== 'string' || !source.prompt.trim()) {
    throw new Error('预设需要有效的 ID、名称和提示词');
  }
  return {
    id: source.id.trim(),
    name: source.name.trim(),
    description: String(source.description || '').trim(),
    prompt: source.prompt.trim(),
  };
}

function normalizePresetList(presets) {
  if (!Array.isArray(presets)) throw new Error('预设列表格式错误');
  const list = presets.map(normalizePreset);
  if (new Set(list.map(preset => preset.id)).size !== list.length) {
    throw new Error('预设 ID 重复');
  }
  return list;
}

export async function getGlobalPresets() {
  const raw = await AsyncStorage.getItem(PRESET_LIST_KEY);
  if (raw === null) return GLOBAL_PRESETS.map(normalizePreset);
  return normalizePresetList(JSON.parse(raw));
}

export async function saveGlobalPresets(presets) {
  const list = normalizePresetList(presets);
  await AsyncStorage.setItem(PRESET_LIST_KEY, JSON.stringify(list));
  return list;
}

function normalizeEnabledMap(source, presets) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const enabled = {};
  presets.forEach(preset => {
    enabled[preset.id] = raw[preset.id] === true;
  });
  return enabled;
}

async function readGlobalPresetSettings() {
  const raw = await AsyncStorage.getItem(GLOBAL_PRESETS_KEY);
  if (raw === null) return {};
  const enabled = JSON.parse(raw);
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) {
    throw new Error('预设开关格式错误');
  }
  return enabled;
}

export async function createGlobalPresetId(presets) {
  const enabled = await readGlobalPresetSettings();
  const used = new Set([...presets.map(preset => preset.id), ...Object.keys(enabled)]);
  const base = `preset-${Date.now()}`;
  let id = base;
  let suffix = 0;
  while (used.has(id)) {
    suffix += 1;
    id = `${base}-${suffix}`;
  }
  return id;
}

export async function getGlobalPresetSettings() {
  const [raw, presets] = await Promise.all([
    readGlobalPresetSettings(),
    getGlobalPresets(),
  ]);
  return normalizeEnabledMap(raw, presets);
}

export async function saveGlobalPresetSettings(enabled) {
  const presets = await getGlobalPresets();
  const normalized = normalizeEnabledMap(enabled, presets);
  await AsyncStorage.setItem(GLOBAL_PRESETS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function getEnabledGlobalPresetPrompts() {
  const presets = await getGlobalPresets();
  const raw = await readGlobalPresetSettings();
  const enabled = normalizeEnabledMap(raw, presets);
  return presets.filter(preset => enabled[preset.id]).map(preset => preset.prompt);
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

const PLUGIN_PROVIDERS = ['serpapi', 'google-cse', 'bing', 'brave', 'tavily', 'custom'];

function normalizePlugin(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const preset = DEFAULT_PLUGINS.find(item => item.id === source.id);
  const defaultConfig = (preset && preset.config) || {};
  const config = source.config && typeof source.config === 'object' && !Array.isArray(source.config)
    ? source.config
    : {};
  const provider = PLUGIN_PROVIDERS.includes(config.provider)
    ? config.provider
    : (defaultConfig.provider || 'serpapi');
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
    },
  };
}

export async function getPlugins() {
  const raw = await readJson(PLUGINS_KEY, null);
  const list = Array.isArray(raw) ? raw.map(normalizePlugin) : [];
  let changed = raw === null;
  DEFAULT_PLUGINS.forEach(preset => {
    if (!list.some(item => item.id === preset.id)) {
      list.push(normalizePlugin(preset));
      changed = true;
    }
  });
  if (changed) {
    try {
      await AsyncStorage.setItem(PLUGINS_KEY, JSON.stringify(list));
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
  await AsyncStorage.setItem(PLUGINS_KEY, JSON.stringify(list));
  return list;
}

export async function getEnabledPlugins() {
  const list = await getPlugins();
  return list.filter(plugin => plugin.enabled === true);
}

export async function isDisclaimerAcknowledged() {
  const raw = await AsyncStorage.getItem(DISCLAIMER_ACK_KEY);
  return raw === 'true';
}

export async function acknowledgeDisclaimer() {
  await AsyncStorage.setItem(DISCLAIMER_ACK_KEY, 'true');
  return true;
}

function ensureUniqueSessionIds(list) {
  const seen = new Set();
  return list.map((item, index) => {
    let id = String(item.id);
    if (seen.has(id)) {
      let candidate = `${id}-${index}`;
      let bump = index;
      while (seen.has(candidate)) {
        bump += 1;
        candidate = `${id}-${index}-${bump}`;
      }
      id = candidate;
    }
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

export async function getSessions() {
  const stored = await readJson(SESSIONS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return ensureUniqueSessionIds(stored.map(normalizeSession));
}

export async function saveSessions(sessions) {
  const list = ensureUniqueSessionIds(
    (Array.isArray(sessions) ? sessions : []).map(normalizeSession)
  );
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  return list;
}

export async function getActiveSessionId() {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
    return raw ? String(JSON.parse(raw)) : '';
  } catch (error) {
    return '';
  }
}

export async function setActiveSessionId(id) {
  await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(String(id || '')));
}

export async function getMessagesBySession(sessionId) {
  const stored = await readJson(sessionMessagesKey(sessionId), null);
  return Array.isArray(stored) ? stored.filter(item => item && !item.pending) : [];
}

export async function saveMessagesBySession(sessionId, messages) {
  const persistable = (messages || []).filter(item => item && !item.pending);
  await AsyncStorage.setItem(sessionMessagesKey(sessionId), JSON.stringify(persistable));
  const sessions = await getSessions();
  if (sessions.some(session => session.id === sessionId)) {
    const updated = sessions.map(session =>
      session.id === sessionId
        ? { ...session, preview: buildPreview(persistable), updatedAt: Date.now() }
        : session
    );
    await saveSessions(sortSessions(updated));
  }
  return persistable;
}

export async function setSessionSummarizedUpTo(sessionId, messageId) {
  const sessions = await getSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target) throw new Error('会话不存在');
  const nextBoundary = String(messageId || '');
  if (!nextBoundary) return target;
  const messages = await getMessagesBySession(sessionId);
  const newIndex = messages.findIndex(item => item.id === nextBoundary);
  if (newIndex < 0) throw new Error('总结边界无效');
  const oldIndex = messages.findIndex(item => item.id === target.summarizedUpTo);
  if (target.summarizedUpTo && oldIndex >= 0 && newIndex <= oldIndex) {
    return target;
  }
  const updated = { ...target, summarizedUpTo: nextBoundary };
  await saveSessions(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

function sessionSummariesKey(sessionId) {
  return `${SESSION_SUMMARIES_PREFIX}::${String(sessionId || '')}`;
}

function normalizeSessionSummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    summary: String(source.summary || ''),
    keywords: (Array.isArray(source.keywords) ? source.keywords : [])
      .map(item => String(item || '').trim())
      .filter(Boolean),
    boundary: String(source.boundary || ''),
    createdAt: Number(source.createdAt) || 0,
  };
}

export async function getSessionSummaries(sessionId) {
  const stored = await readJson(sessionSummariesKey(sessionId), []);
  if (!Array.isArray(stored)) return [];
  return stored
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
}

export async function saveSessionSummaries(sessionId, list) {
  const normalized = (Array.isArray(list) ? list : [])
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
  await AsyncStorage.setItem(sessionSummariesKey(sessionId), JSON.stringify(normalized));
  return normalized;
}

export async function appendSessionSummary(sessionId, entry) {
  const list = await getSessionSummaries(sessionId);
  const next = [...list, normalizeSessionSummary(entry)];
  await saveSessionSummaries(sessionId, next);
  return next;
}

export async function searchMessages(keyword) {
  const query = String(keyword || '').trim();
  if (!query) return [];
  const sessions = await getSessions();
  if (sessions.length === 0) return [];
  const needle = query.toLowerCase();
  const pairs = await AsyncStorage.multiGet(
    sessions.map(session => sessionMessagesKey(session.id))
  );
  const byKey = new Map(pairs);
  const results = [];
  for (const session of sessions) {
    const raw = byKey.get(sessionMessagesKey(session.id));
    let stored = [];
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      stored = Array.isArray(parsed) ? parsed.filter(item => item && !item.pending) : [];
    } catch (error) {
      stored = [];
    }
    for (const message of stored) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const text = String(message.text || '');
      if (!text || !text.toLowerCase().includes(needle)) continue;
      results.push({
        sessionId: session.id,
        characterId: session.characterId,
        messageId: message.id,
        role: message.role,
        text,
        updatedAt: session.updatedAt || 0,
      });
    }
  }
  results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return results;
}

async function readLegacyMessages(characterId) {
  let stored = await readJson(messagesKey(characterId), null);
  if ((!Array.isArray(stored) || stored.length === 0)
    && characterId === DEFAULT_CHARACTER.id) {
    stored = await readJson(LEGACY_MESSAGES_KEY, null);
  }
  return Array.isArray(stored) ? stored.filter(item => item && !item.pending) : [];
}

export async function startNewSession(characterId) {
  const sessions = await getSessions();
  const nonEmpty = [];
  if (sessions.length > 0) {
    const pairs = await AsyncStorage.multiGet(sessions.map(item => sessionMessagesKey(item.id)));
    const persisted = new Map(
      pairs.map(pair => {
        const raw = pair[1];
        let list = [];
        try {
          const parsed = raw ? JSON.parse(raw) : [];
          list = Array.isArray(parsed) ? parsed.filter(item => item && !item.pending) : [];
        } catch (error) {
          list = [];
        }
        return [pair[0], list];
      })
    );
    sessions.forEach(session => {
      const messages = persisted.get(sessionMessagesKey(session.id)) || [];
      if (messages.length > 0) nonEmpty.push(session);
    });
  }
  const created = createEmptySession(characterId, nonEmpty);
  const next = sortSessions([...nonEmpty, created]);
  await saveSessions(next);
  await setActiveSessionId(created.id);
  return created;
}

export async function createGroupSession(members, name, extras = {}) {
  const sessions = await getSessions();
  const created = buildGroupSession(members, name, sessions, Date.now(), extras);
  const next = sortSessions([...sessions, created]);
  await saveSessions(next);
  await setActiveSessionId(created.id);
  return created;
}

export async function updateSessionInfo(sessionId, patch = {}) {
  const sessions = await getSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target || target.type !== 'group') return target || null;
  const source = patch && typeof patch === 'object' ? patch : {};
  const updated = { ...target };
  if (source.name !== undefined) updated.name = String(source.name || '');
  if (source.avatarUri !== undefined) updated.avatarUri = String(source.avatarUri || '');
  if (source.bgUri !== undefined) updated.bgUri = String(source.bgUri || '');
  updated.updatedAt = Date.now();
  await saveSessions(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

export async function updateSessionMemberProfiles(sessionId, memberProfiles) {
  const sessions = await getSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target || target.type !== 'group') return target || null;
  const incoming = memberProfiles && typeof memberProfiles === 'object' ? memberProfiles : {};
  const merged = { ...(target.memberProfiles || {}) };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    const id = String(key || '').trim();
    const text = String(value || '').trim();
    if (!id || !text || merged[id]) continue;
    merged[id] = text;
    changed = true;
  }
  if (!changed) return target;
  const updated = { ...target, memberProfiles: merged };
  await saveSessions(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

export async function cloneSession(sessionId) {
  const sessions = await getSessions();
  const source = sessions.find(session => session.id === sessionId);
  if (!source) throw new Error('会话不存在');
  const messages = await getMessagesBySession(sessionId);
  const now = Date.now();
  const copy = buildClonedSession(sessions, source, messages, now);
  await AsyncStorage.setItem(
    sessionMessagesKey(copy.id),
    JSON.stringify(regenerateMessageIds(messages, now))
  );
  await saveSessions(sortSessions([...sessions, copy]));
  return copy;
}

export async function deleteSession(sessionId) {
  const sessions = await getSessions();
  const target = sessions.find(session => session.id === sessionId);
  const activeId = await getActiveSessionId();
  const remaining = sessions.filter(session => session.id !== sessionId);
  await saveSessions(remaining);
  try {
    await AsyncStorage.multiRemove([
      sessionMessagesKey(sessionId),
      sessionSummariesKey(sessionId),
    ]);
  } catch (error) {}
  if (activeId === sessionId) {
    const created = createEmptySession(target && target.characterId, remaining);
    const next = sortSessions([...remaining, created]);
    await saveSessions(next);
    await setActiveSessionId(created.id);
    return { sessions: next, activeSessionId: created.id, created };
  }
  return { sessions: remaining, activeSessionId: activeId, created: null };
}

export async function deleteSessions(sessionIds) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  const sessions = await getSessions();
  if (ids.length === 0) {
    return { sessions, activeSessionId: await getActiveSessionId() };
  }
  const idSet = new Set(ids);
  const remaining = sessions.filter(session => !idSet.has(session.id));
  await saveSessions(remaining);
  try {
    await AsyncStorage.multiRemove(ids.flatMap(id => [
      sessionMessagesKey(id),
      sessionSummariesKey(id),
    ]));
  } catch (error) {}
  return { sessions: remaining, activeSessionId: await getActiveSessionId() };
}

export async function migrateLegacyMessages(characters) {
  const list = Array.isArray(characters) ? characters : [];
  const sessions = await getSessions();
  const existingIds = new Set(sessions.map(session => session.id));
  const migrated = [];
  for (const character of list) {
    const characterId = character && character.id;
    if (!characterId) continue;
    const sessionId = legacySessionId(characterId);
    if (existingIds.has(sessionId)) continue;
    const messages = await readLegacyMessages(characterId);
    if (messages.length === 0) continue;
    const timestamps = messages
      .map(item => Number(item && item.timestamp))
      .filter(value => Number.isFinite(value));
    const fallback = Date.now();
    const createdAt = timestamps.length ? Math.min(...timestamps) : fallback;
    const updatedAt = timestamps.length ? Math.max(...timestamps) : fallback;
    const session = {
      id: sessionId,
      characterId: String(characterId),
      preview: buildPreview(messages),
      pinned: false,
      createdAt,
      updatedAt,
      clonedFrom: '',
    };
    await AsyncStorage.setItem(sessionMessagesKey(sessionId), JSON.stringify(messages));
    existingIds.add(sessionId);
    migrated.push(session);
  }
  if (migrated.length > 0) {
    await saveSessions(sortSessions([...sessions, ...migrated]));
  }
  return migrated;
}
