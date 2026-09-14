import AsyncStorage from '@react-native-async-storage/async-storage';

const API_CONFIG_KEY = '@easychat2_api_config';
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

export async function getApiConfig() {
  const config = await readJson(API_CONFIG_KEY, DEFAULT_API_CONFIG);
  return {
    ...DEFAULT_API_CONFIG,
    ...config
  };
}

export async function saveApiConfig(config) {
  await AsyncStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
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