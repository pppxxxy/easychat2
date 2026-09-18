import AsyncStorage from '@react-native-async-storage/async-storage';

import GLOBAL_PRESETS from './presets';
import {
  buildClonedSession,
  buildPreview,
  createEmptySession,
  normalizeSession,
  regenerateMessageIds,
  sortSessions,
} from './context/sessionLibrary';

const API_CONFIG_KEY = '@easychat2_api_config';
const API_CONFIGS_KEY = '@easychat2_api_configs';
const USER_PROFILE_KEY = '@easychat2_user_profile';
const GLOBAL_PRESETS_KEY = '@easychat2_global_presets';
const PRESET_LIST_KEY = '@easychat2_preset_list';
const CHARACTER_KEY = '@easychat2_character';
const CHARACTERS_KEY = '@easychat2_characters';
const ACTIVE_CHARACTER_KEY = '@easychat2_active_character';
const DISCLAIMER_ACK_KEY = '@easychat2_disclaimer_ack';
const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';
const SESSIONS_KEY = '@easychat2_sessions';
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

const DEFAULT_MEMORY_SUMMARY = { enabled: false, threshold: 40 };

function normalizeMemorySummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const threshold = Math.trunc(Number(source.threshold));
  return {
    enabled: source.enabled === true,
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
    await AsyncStorage.removeItem(sessionMessagesKey(sessionId));
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
