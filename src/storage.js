import AsyncStorage from '@react-native-async-storage/async-storage';

import GLOBAL_PRESETS from './presets';

const API_CONFIG_KEY = '@easychat2_api_config';
const API_CONFIGS_KEY = '@easychat2_api_configs';
const USER_PROFILE_KEY = '@easychat2_user_profile';
const GLOBAL_PRESETS_KEY = '@easychat2_global_presets';
const PRESET_LIST_KEY = '@easychat2_preset_list';
const CHARACTER_KEY = '@easychat2_character';
const CHARACTERS_KEY = '@easychat2_characters';
const ACTIVE_CHARACTER_KEY = '@easychat2_active_character';
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
  mesExample: '',
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
  const [list, activeId] = await Promise.all([
    getCharacterLibrary(),
    getActiveCharacterId()
  ]);
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
  return {
    id: String(source.id || `cfg-${index}`),
    name: String(source.name || `配置 ${index + 1}`),
    baseUrl: String(source.baseUrl || DEFAULT_API_CONFIG.baseUrl),
    model: String(source.model || DEFAULT_API_CONFIG.model),
    apiKey: String(source.apiKey || ''),
  };
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
  const stored = await readJsonStatus(API_CONFIGS_KEY);
  let configs = [];
  let activeId = '';
  let needsPersist = false;

  if (stored.status === 'ok' && stored.value && typeof stored.value === 'object') {
    const rawList = Array.isArray(stored.value.configs) ? stored.value.configs : [];
    configs = ensureUniqueApiConfigIds(rawList.map(normalizeApiConfig));
    activeId = String(stored.value.activeId || '');
  } else {
    const legacy = await readJson(API_CONFIG_KEY, null);
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

const DEFAULT_USER_PROFILE = { userName: '', persona: '', avatarUri: '' };

export async function getUserProfile() {
  const profile = await readJson(USER_PROFILE_KEY, DEFAULT_USER_PROFILE);
  return {
    userName: String(profile?.userName || ''),
    persona: String(profile?.persona || ''),
    avatarUri: String(profile?.avatarUri || ''),
  };
}

export async function saveUserProfile(profile) {
  await AsyncStorage.setItem(
    USER_PROFILE_KEY,
    JSON.stringify({
      userName: String(profile?.userName || ''),
      persona: String(profile?.persona || ''),
      avatarUri: String(profile?.avatarUri || ''),
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

export async function getGlobalPresetSettings() {
  const [raw, presets] = await Promise.all([
    readJson(GLOBAL_PRESETS_KEY, {}),
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
  const raw = await readJson(GLOBAL_PRESETS_KEY, {});
  const enabled = normalizeEnabledMap(raw, presets);
  return presets.filter(preset => enabled[preset.id]).map(preset => preset.prompt);
}
