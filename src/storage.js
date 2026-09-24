import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

import GLOBAL_PRESETS from './presets';
import { isKnownImageProvider } from './imageGen/providers';
import { FORGE_FIELDS, FORGE_QUESTIONS } from './cardForge/forge';
import {
  removeMomentsForCharacterDeletion,
  removeMomentsBySessionIds,
} from './moments/moments';
import { assignStableCharacterIds } from './context/characterIdentity';
import { normalizeCharacterPresets } from './characterPresets';
import {
  buildClonedSession,
  buildPreview,
  buildRestoredSession,
  collectMessageSpeakers,
  createEmptySession,
  createGroupSession as buildGroupSession,
  isMessageGroup,
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
// 旧格式：整库数组存一个键（超过约 2MB 会触发 Android SQLite 行读取上限）。
const CHARACTERS_KEY = '@easychat2_characters';
// 新格式：只存角色 id 索引，角色本体按 id 拆到 CHARACTER_ITEM_PREFIX 键。
const CHARACTER_INDEX_KEY = '@easychat2_character_index';
const CHARACTER_ITEM_PREFIX = '@easychat2_character_item';
const CHARACTER_MIGRATION_KEY = '@easychat2_character_migration';
const CHARACTER_PAYLOAD_DIRECTORY = 'characters';
const CHARACTER_PAYLOAD_FILE_VERSION = 1;
const CHARACTER_INLINE_LIMIT_BYTES = 512 * 1024;
const ACTIVE_CHARACTER_KEY = '@easychat2_active_character';
const DISCLAIMER_ACK_KEY = '@easychat2_disclaimer_ack';
const ONBOARDING_DONE_KEY = '@easychat2_onboarding_done';
const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';
const PLUGINS_KEY = '@easychat2_plugins';
const THINKING_KEY = '@easychat2_thinking';
const IMAGE_GEN_KEY = '@easychat2_image_gen';
const CHAT_OPTIONS_KEY = '@easychat2_chat_options';
const APPEARANCE_KEY = '@easychat2_appearance';
const INLINE_IMAGE_KEY = '@easychat2_inline_image';
const STICKERS_KEY = '@easychat2_stickers';
const STICKER_INDEX_KEY = '@easychat2_sticker_index';
const STICKER_ITEM_PREFIX = '@easychat2_sticker_item';
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
const CARD_FORGE_KEY = '@easychat2_card_forge';

let characterLibraryWriteBlocked = false;
let stickerWriteQueue = Promise.resolve();
let momentsMutationQueue = Promise.resolve();
let sessionMutationQueue = Promise.resolve();
const deletedSessionIds = new Set();
const sessionSummaryRevisions = new Map();
const vectorIndexWriteQueues = new Map();
const protectedChatImageUris = new Set();

function enqueueSessionMutation(task) {
  const next = sessionMutationQueue.then(task, task);
  sessionMutationQueue = next.catch(() => {});
  return next;
}

function enqueueMomentsMutation(task) {
  const next = momentsMutationQueue.then(task, task);
  momentsMutationQueue = next.catch(() => {});
  return next;
}

const DEFAULT_API_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: ''
};

export const DEFAULT_CHARACTER = {
  id: 'default',
  // builtin 标记初始卡身份：改名 / 改系统提示后仍能识别，不能靠名字比对（会被用户改掉）。
  builtin: true,
  name: 'EasyChat2 助手',
  systemPrompt: '你是 EasyChat2 的智能助手，回答简洁清晰。',
  systemPromptComposed: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '',
  creatorNotes: '',
  postHistoryInstructions: '',
  tags: [],
  worldInfo: [],
  regexScripts: [],
  presets: [],
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

let sqliteModule;
function getSqliteModule() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = require('expo-sqlite');
  } catch (error) {
    sqliteModule = null;
  }
  return sqliteModule;
}

async function readLargeAsyncStorageValue(key) {
  const SQLite = getSqliteModule();
  if (!SQLite || typeof SQLite.openDatabase !== 'function') return null;
  const source = `${FileSystem.documentDirectory || ''}../databases/RKStorage`;
  try {
    const info = await FileSystem.getInfoAsync(source);
    if (!info || !info.exists) return null;
  } catch (error) {
    return null;
  }
  let database = null;
  try {
    database = SQLite.openDatabase('../../databases/RKStorage');
    const lengthResult = await database.execAsync([{
      sql: 'SELECT length(value) AS total FROM catalystLocalStorage WHERE key = ?',
      args: [key],
    }], true);
    const total = Number(lengthResult?.[0]?.rows?.[0]?.total);
    if (!Number.isFinite(total) || total <= 0) return null;
    const chunkSize = 256 * 1024;
    let value = '';
    for (let offset = 0; offset < total; offset += chunkSize) {
      const result = await database.execAsync([{
        sql: 'SELECT substr(value, ?, ?) AS chunk FROM catalystLocalStorage WHERE key = ?',
        args: [offset + 1, chunkSize, key],
      }], true);
      const chunk = result?.[0]?.rows?.[0]?.chunk;
      if (chunk == null) return null;
      value += String(chunk);
    }
    return value;
  } catch (error) {
    return null;
  } finally {
    if (database && typeof database.closeAsync === 'function') {
      try {
        await database.closeAsync();
      } catch (error) {}
    }
  }
}

async function readJsonStatus(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    return { status: 'ok', value: JSON.parse(raw) };
  } catch (error) {
    const recovered = await readLargeAsyncStorageValue(key);
    if (recovered !== null) {
      try {
        return { status: 'ok', value: JSON.parse(recovered) };
      } catch (parseError) {}
    }
    return { status: 'corrupt' };
  }
}

// 存储损坏时先把原始内容另存一份再重建：直接用默认值覆盖是不可逆的，
// 留一份副本至少给用户（或后续版本）留下人工恢复的机会。
const CORRUPT_BACKUP_SUFFIX = '__corrupt_backup';

async function backupCorruptValue(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return false;
    await AsyncStorage.setItem(`${key}${CORRUPT_BACKUP_SUFFIX}`, raw);
    if (__DEV__) {
      console.warn(`[storage] ${key} 读取失败或结构异常，已备份到 ${key}${CORRUPT_BACKUP_SUFFIX}`);
    }
    return true;
  } catch (error) {
    if (__DEV__) console.warn(`[storage] ${key} 损坏数据备份失败`, error);
    return false;
  }
}

function normalizeCharacter(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const merged = { ...DEFAULT_CHARACTER, ...source };
  // 这里绝不能用 DEFAULT_CHARACTER.id 兜底：空 id 一旦变成 'default'，就会和
  // 初始卡撞成同一个身份。真正的补全交给 assignStableCharacterIds 统一分配并落盘。
  merged.id = String(source.id == null ? '' : source.id).trim();
  // builtin 只认存储里显式写过的标记，不能从 DEFAULT_CHARACTER 继承，否则所有角色都会变成初始卡。
  merged.builtin = source.builtin === true;
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
  merged.presets = normalizeCharacterPresets(merged.presets);
  return merged;
}

function isInitialCard(character) {
  if (character && character.builtin === true) return true;
  // 旧数据没有 builtin：退化用「名字 + 系统提示」比对，尽量在首次读取时把真初始卡认出来并补标记。
  return String(character.name || '') === String(DEFAULT_CHARACTER.name || '')
    && String(character.systemPrompt || '') === String(DEFAULT_CHARACTER.systemPrompt || '');
}

function ensureDefaultCharacter(list, now = Date.now()) {
  const normalized = (Array.isArray(list) ? list : []).map(normalizeCharacter);
  const { list: items, changed } = assignStableCharacterIds(normalized, {
    defaultId: DEFAULT_CHARACTER.id,
    isInitial: isInitialCard,
    now,
  });
  // 补 builtin 标记：初始卡改名 / 改系统提示后仍能被识别，避免身份判定再次失效。
  const marked = items.map(item => (
    item.id === DEFAULT_CHARACTER.id && item.builtin !== true ? { ...item, builtin: true } : item
  ));
  const builtinChanged = marked.some((item, index) => item !== items[index]);
  let changedNow = changed || builtinChanged;
  if (!marked.some(item => item.id === DEFAULT_CHARACTER.id)) {
    marked.unshift(normalizeCharacter(DEFAULT_CHARACTER));
    changedNow = true;
  }
  return { list: marked, changed: changedNow };
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

function characterItemKey(id) {
  return `${CHARACTER_ITEM_PREFIX}::${String(id)}`;
}

function characterPayloadDirectory() {
  return `${FileSystem.documentDirectory || FileSystem.cacheDirectory || ''}${CHARACTER_PAYLOAD_DIRECTORY}/`;
}

function characterPayloadPath(fileName) {
  return `${characterPayloadDirectory()}${String(fileName || '')}`;
}

function characterIdHash(id) {
  const text = String(id || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function characterPayloadFileName(id) {
  return `${characterIdHash(id)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`;
}

function utf8ByteLength(text) {
  const value = String(text || '');
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isCharacterPayloadDescriptor(value) {
  return !!(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.storage === 'file'
    && value.version === CHARACTER_PAYLOAD_FILE_VERSION
    && value.id != null
    && value.fileName
  );
}

async function writeCharacterPayload(character) {
  const serialized = JSON.stringify(character);
  if (utf8ByteLength(serialized) <= CHARACTER_INLINE_LIMIT_BYTES) {
    return { value: serialized, fileName: '' };
  }
  const fileName = characterPayloadFileName(character.id);
  await FileSystem.makeDirectoryAsync(characterPayloadDirectory(), { intermediates: true });
  try {
    await FileSystem.writeAsStringAsync(characterPayloadPath(fileName), serialized, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch (error) {
    await FileSystem.deleteAsync(characterPayloadPath(fileName), { idempotent: true }).catch(() => {});
    throw error;
  }
  return {
    value: JSON.stringify({
      storage: 'file',
      version: CHARACTER_PAYLOAD_FILE_VERSION,
      id: String(character.id),
      fileName,
    }),
    fileName,
  };
}

async function cleanupCharacterPayloadFiles(activeNames) {
  try {
    const names = await FileSystem.readDirectoryAsync(characterPayloadDirectory());
    await Promise.all((names || [])
      .filter(name => String(name).endsWith('.json') && !activeNames.has(String(name)))
      .map(name => FileSystem.deleteAsync(characterPayloadPath(name), { idempotent: true })));
  } catch (error) {}
}

async function readCharacterPayload(value) {
  if (!isCharacterPayloadDescriptor(value)) {
    return { status: 'ok', value };
  }
  try {
    const serialized = await FileSystem.readAsStringAsync(characterPayloadPath(value.fileName), {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return { status: 'ok', value: JSON.parse(serialized) };
  } catch (error) {
    return { status: 'unreadable', value: null };
  }
}

export function isCharacterLibraryWriteBlocked() {
  return characterLibraryWriteBlocked;
}

async function readCharacterIndex() {
  const stored = await readJsonStatus(CHARACTER_INDEX_KEY);
  if (stored.status === 'ok' && Array.isArray(stored.value)) {
    return { ids: stored.value.map(String).filter(Boolean), corrupt: false };
  }
  const corrupt = stored.status === 'corrupt'
    || (stored.status === 'ok' && !Array.isArray(stored.value));
  return { ids: null, corrupt };
}

async function readCharacterMigrationMarker() {
  const stored = await readJsonStatus(CHARACTER_MIGRATION_KEY);
  if (stored.status !== 'ok' || !stored.value || typeof stored.value !== 'object') {
    return null;
  }
  return stored.value;
}

function mergeCharacterItems(primary, fallback) {
  const merged = new Map();
  (Array.isArray(fallback) ? fallback : []).forEach(item => {
    const normalized = normalizeCharacter(item);
    if (normalized.id) merged.set(normalized.id, normalized);
  });
  (Array.isArray(primary) ? primary : []).forEach(item => {
    const normalized = normalizeCharacter(item);
    if (normalized.id) merged.set(normalized.id, normalized);
  });
  return [...merged.values()];
}

async function readLegacyCharacterItems() {
  const stored = await readJsonStatus(CHARACTERS_KEY);
  if (stored.status === 'ok' && Array.isArray(stored.value)) {
    return { status: 'ok', items: stored.value.map(normalizeCharacter) };
  }
  if (stored.status === 'missing') return { status: 'missing', items: [] };
  return { status: 'unreadable', items: [] };
}

async function readLegacySingleCharacter() {
  const stored = await readJsonStatus(CHARACTER_KEY);
  if (stored.status === 'ok' && stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value)) {
    return { status: 'ok', item: normalizeCharacter(stored.value) };
  }
  if (stored.status === 'missing') return { status: 'missing', item: null };
  return { status: 'unreadable', item: null };
}

// 索引损坏时扫出散落的角色条目键，尽量把角色库拼回来，避免“条目还在、索引没了”。
async function rebuildCharacterItemsFromKeys() {
  const allKeys = await AsyncStorage.getAllKeys();
  const keys = (allKeys || []).filter(key => typeof key === 'string' && key.startsWith(`${CHARACTER_ITEM_PREFIX}::`));
  const items = [];
  let failed = 0;
  for (const key of keys) {
    const stored = await readJsonStatus(key);
    if (stored.status === 'missing') {
      failed += 1;
      continue;
    }
    const payload = await readCharacterPayload(stored.value);
    if (
      payload.status === 'ok'
      && payload.value
      && typeof payload.value === 'object'
      && !Array.isArray(payload.value)
    ) {
      items.push(normalizeCharacter(payload.value));
    } else {
      failed += 1;
    }
  }
  return { items, failed };
}

// 角色按 id 拆键存储：整库 JSON 会随卡片增多突破 Android SQLite 的单值读取上限
// （CursorWindow 约 2MB），消息体当初也是因此按会话拆分。大角色正文落到文件，
// AsyncStorage 只保留小型描述符，索引最后写作为提交点。
async function persistLibrary(list) {
  const previousIds = (await readCharacterIndex()).ids || [];
  const stale = new Set(previousIds);
  const ids = list.map(character => String(character.id));
  const previousValues = new Map();
  for (const id of new Set([...previousIds, ...ids])) {
    previousValues.set(id, await AsyncStorage.getItem(characterItemKey(id)));
  }
  const pairs = [];
  const activeFileNames = new Set();
  const writtenFileNames = [];
  try {
    for (const character of list) {
      const id = String(character.id);
      const payload = await writeCharacterPayload(character);
      if (payload.fileName) {
        activeFileNames.add(payload.fileName);
        writtenFileNames.push(payload.fileName);
      }
      pairs.push([characterItemKey(id), payload.value]);
      stale.delete(id);
    }
    if (pairs.length > 0) await AsyncStorage.multiSet(pairs);
    await AsyncStorage.setItem(CHARACTER_INDEX_KEY, JSON.stringify(ids));
    try {
      await AsyncStorage.setItem(CHARACTER_MIGRATION_KEY, JSON.stringify({
        version: CHARACTER_PAYLOAD_FILE_VERSION,
        ids,
      }));
    } catch (error) {}
  } catch (error) {
    const restorePairs = [];
    const removeKeys = [];
    for (const [id, value] of previousValues) {
      if (value === null || value === undefined) removeKeys.push(characterItemKey(id));
      else restorePairs.push([characterItemKey(id), value]);
    }
    if (restorePairs.length > 0) await AsyncStorage.multiSet(restorePairs).catch(() => {});
    if (removeKeys.length > 0) await AsyncStorage.multiRemove(removeKeys).catch(() => {});
    await Promise.all(writtenFileNames.map(fileName => (
      FileSystem.deleteAsync(characterPayloadPath(fileName), { idempotent: true }).catch(() => {})
    )));
    throw error;
  }
  await cleanupCharacterPayloadFiles(activeFileNames);
  const staleKeys = Array.from(stale).map(characterItemKey);
  if (staleKeys.length > 0) {
    try {
      await AsyncStorage.multiRemove(staleKeys);
    } catch (error) {}
  }
}

async function readCharacterItems(ids) {
  const items = [];
  let missing = 0;
  let failed = 0;
  for (const id of ids) {
    const stored = await readJsonStatus(characterItemKey(id));
    if (stored.status === 'missing') {
      missing += 1;
      continue;
    }
    const payload = await readCharacterPayload(stored.value);
    if (
      payload.status === 'ok'
      && payload.value
      && typeof payload.value === 'object'
      && !Array.isArray(payload.value)
    ) {
      items.push(normalizeCharacter(payload.value));
    } else {
      failed += 1;
    }
  }
  return { items, missing, failed };
}

function ensureDefaultCharacterOrPersistHint(items) {
  const hadDefault = items.some(item => item.id === DEFAULT_CHARACTER.id);
  const { list: ensured, changed } = ensureDefaultCharacter(items);
  const list = sortCharacters(ensured);
  return { list, mustPersist: !hadDefault || changed };
}

export async function getCharacterLibrary() {
  const [index, legacy, marker] = await Promise.all([
    readCharacterIndex(),
    readLegacyCharacterItems(),
    readCharacterMigrationMarker(),
  ]);
  let items = [];
  let needsPersist = false;
  let writeBlocked = false;

  if (index.ids) {
    const loaded = await readCharacterItems(index.ids);
    items = loaded.items;
    const loadedIds = new Set(items.map(item => item.id));
    const legacyHasMissing = legacy.status === 'ok'
      && legacy.items.some(item => item.id && !loadedIds.has(item.id));
    const legacyOnlyDefaultRecovery = index.ids.length <= 1
      && !marker
      && legacy.status === 'ok'
      && legacy.items.length > items.length;

    if (legacyOnlyDefaultRecovery) {
      items = legacy.items;
      needsPersist = true;
    } else if (legacyHasMissing && (loaded.missing > 0 || loaded.failed > 0)) {
      items = mergeCharacterItems(items, legacy.items);
      needsPersist = true;
    }

    const availableIds = new Set(items.map(item => item.id));
    const unresolved = index.ids.filter(id => !availableIds.has(id));
    if (unresolved.length > 0) {
      writeBlocked = true;
    }
    if (
      !writeBlocked
      && index.ids.length <= 1
      && !marker
      && legacy.status === 'unreadable'
    ) {
      writeBlocked = true;
    }
  } else if (index.corrupt) {
    const rebuilt = await rebuildCharacterItemsFromKeys();
    items = legacy.status === 'ok'
      ? mergeCharacterItems(rebuilt.items, legacy.items)
      : rebuilt.items;
    needsPersist = true;
    writeBlocked = rebuilt.failed > 0 || legacy.status === 'unreadable';
  } else if (legacy.status === 'ok') {
    items = legacy.items;
    needsPersist = true;
  } else if (legacy.status === 'missing') {
    const single = await readLegacySingleCharacter();
    if (single.status === 'ok') {
      items = [single.item];
      const active = await getActiveCharacterId();
      if (!active) {
        try {
          await setActiveCharacterId(single.item.id);
        } catch (error) {}
      }
    } else if (single.status === 'unreadable') {
      writeBlocked = true;
    }
    needsPersist = true;
  } else {
    writeBlocked = true;
  }

  const { list, mustPersist } = ensureDefaultCharacterOrPersistHint(items);
  if (writeBlocked) {
    characterLibraryWriteBlocked = true;
    return list;
  }

  characterLibraryWriteBlocked = false;
  if (index.ids && !marker && !needsPersist && !mustPersist) {
    try {
      await AsyncStorage.setItem(CHARACTER_MIGRATION_KEY, JSON.stringify({
        version: CHARACTER_PAYLOAD_FILE_VERSION,
        ids: index.ids,
      }));
    } catch (error) {
      characterLibraryWriteBlocked = true;
      return list;
    }
  }
  if (needsPersist || mustPersist) {
    try {
      await persistLibrary(list);
    } catch (error) {
      characterLibraryWriteBlocked = true;
    }
  }
  return list;
}

export async function saveCharacterLibrary(list) {
  if (characterLibraryWriteBlocked) {
    throw new Error('角色库仍在恢复中，请稍后重试。');
  }
  const { list: ensured } = ensureDefaultCharacter(list);
  const next = sortCharacters(ensured);
  await persistLibrary(next);
  return next;
}

export async function saveCharacterState(list, activeId, deletedIds, clearVectorIds = []) {
  const vectorIds = Array.isArray(clearVectorIds)
    ? clearVectorIds
    : (clearVectorIds ? [clearVectorIds] : []);
  for (const id of vectorIds) {
    if (id && id !== DEFAULT_CHARACTER.id) {
      await clearVectorIndex(id);
    }
  }
  await saveCharacterLibrary(list);
  await setActiveCharacterId(activeId);
  const removed = Array.isArray(deletedIds) ? deletedIds : (deletedIds ? [deletedIds] : []);
  for (const id of removed) {
    if (id && id !== DEFAULT_CHARACTER.id) {
      try {
        await AsyncStorage.removeItem(messagesKey(id));
      } catch (error) {}
    }
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

function makeApiConfigId() {
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeApiConfig(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const legacyModel = String(source.model || source.activeModel || DEFAULT_API_CONFIG.model);
  const providedModels = Array.isArray(source.models)
    ? source.models.map(item => String(item || '').trim()).filter(Boolean)
    : null;
  const models = providedModels !== null ? providedModels : [legacyModel];
  const requestedActive = String(source.activeModel || '');
  const activeModel = models.includes(requestedActive)
    ? requestedActive
    : (models.includes(legacyModel) ? legacyModel : (models[0] || ''));
  return {
    id: String(source.id || `cfg-${index}`),
    name: String(source.name || `配置 ${index + 1}`),
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : DEFAULT_API_CONFIG.baseUrl,
    apiKey: String(source.apiKey || ''),
    vendorId: String(source.vendorId || ''),
    protocol: source.protocol === 'anthropic' ? 'anthropic' : 'openai',
    authHeader: String(source.authHeader || 'Authorization'),
    authScheme: source.authScheme === undefined || source.authScheme === null
      ? 'Bearer '
      : String(source.authScheme),
    apiKeyUrl: String(source.apiKeyUrl || ''),
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

function enqueueVectorIndexMutation(characterId, task) {
  const key = vectorIndexKey(characterId);
  const previous = vectorIndexWriteQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  vectorIndexWriteQueues.set(key, next.catch(() => {}));
  return next;
}

function normalizeVectorIndex(index) {
  return (Array.isArray(index) ? index : [])
    .filter(item => item && item.id && typeof item.text === 'string')
    .map(item => ({
      id: String(item.id),
      messageId: String(item.messageId || ''),
      sessionId: String(item.sessionId || ''),
      role: String(item.role || ''),
      at: Number(item.at) || 0,
      text: String(item.text),
      vector: Array.isArray(item.vector) ? item.vector.map(Number) : [],
    }));
}

async function readVectorIndexStatus(characterId) {
  const key = vectorIndexKey(characterId);
  const stored = await readJsonStatus(key);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return { status: 'corrupt', index: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', index: [] };
  return { status: 'ok', index: normalizeVectorIndex(stored.value) };
}

export async function getVectorIndexStatus(characterId) {
  return readVectorIndexStatus(characterId);
}

export async function getVectorIndex(characterId) {
  const { index } = await readVectorIndexStatus(characterId);
  return index;
}

async function saveVectorIndexInternal(characterId, index) {
  const list = normalizeVectorIndex(index);
  await AsyncStorage.setItem(vectorIndexKey(characterId), JSON.stringify(list));
  return list;
}

export function saveVectorIndex(characterId, index) {
  return enqueueVectorIndexMutation(characterId, async () => {
    const status = await readVectorIndexStatus(characterId);
    if (status.status === 'corrupt') {
      throw new Error('向量记忆索引读取失败，请稍后重试');
    }
    return saveVectorIndexInternal(characterId, index);
  });
}

export function updateVectorIndex(characterId, updater) {
  return enqueueVectorIndexMutation(characterId, async () => {
    const status = await readVectorIndexStatus(characterId);
    if (status.status === 'corrupt') {
      throw new Error('向量记忆索引读取失败，请稍后重试');
    }
    const next = typeof updater === 'function' ? await updater(status.index) : status.index;
    if (next === undefined) return status.index;
    if (next === null) {
      await AsyncStorage.removeItem(vectorIndexKey(characterId));
      return [];
    }
    return saveVectorIndexInternal(characterId, next);
  });
}

export function removeVectorIndexForSessions(characterId, sessionIds) {
  const ids = new Set(
    (Array.isArray(sessionIds) ? sessionIds : [sessionIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  return updateVectorIndex(characterId, current => (
    ids.size === 0 ? current : current.filter(item => !ids.has(String(item.sessionId || '')))
  ));
}

export function removeVectorIndexForSession(characterId, sessionId) {
  return removeVectorIndexForSessions(characterId, [sessionId]);
}

export function removeVectorIndexForMessages(characterId, sessionId, messageIds) {
  const targetSession = String(sessionId || '');
  const ids = new Set(
    (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  return updateVectorIndex(characterId, current => (
    ids.size === 0 ? current : current.filter(item => (
      String(item.sessionId || '') !== targetSession || !ids.has(String(item.messageId || ''))
    ))
  ));
}

export function removeVectorIndexForMessage(characterId, sessionId, messageId) {
  return removeVectorIndexForMessages(characterId, sessionId, [messageId]);
}

function clearVectorIndex(characterId) {
  return enqueueVectorIndexMutation(
    characterId,
    () => AsyncStorage.removeItem(vectorIndexKey(characterId))
  );
}

export async function reconcileVectorIndexes() {
  const sessionsStatus = await readSessionsStatus();
  if (sessionsStatus.status === 'corrupt') {
    throw new Error('会话列表读取失败，请稍后重试');
  }
  const sessionMap = new Map(
    sessionsStatus.sessions.map(session => [String(session.id || ''), session])
  );
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    throw new Error('向量索引列表读取失败，请稍后重试');
  }
  const prefix = `${VECTOR_INDEX_PREFIX}::`;
  const vectorKeys = (Array.isArray(keys) ? keys : [])
    .filter(key => typeof key === 'string' && key.startsWith(prefix));
  const report = {
    scannedKeys: vectorKeys.length,
    removed: 0,
    legacyRetained: 0,
    failedKeys: [],
  };
  for (const key of vectorKeys) {
    const characterId = key.slice(prefix.length);
    if (!characterId) continue;
    const status = await readVectorIndexStatus(characterId);
    if (status.status === 'missing') continue;
    if (status.status === 'corrupt') {
      report.failedKeys.push(key);
      continue;
    }
    report.legacyRetained += status.index.filter(item => !String(item.sessionId || '')).length;
    try {
      const result = await updateVectorIndex(characterId, current => {
        const next = current.filter(item => {
          const sessionId = String(item.sessionId || '');
          if (!sessionId) return true;
          const session = sessionMap.get(sessionId);
          return !!session && session.type !== 'group';
        });
        if (next.length === current.length) return undefined;
        return next.length > 0 ? next : null;
      });
      report.removed += Math.max(0, status.index.length - result.length);
    } catch (error) {
      report.failedKeys.push(key);
      if (__DEV__) console.warn('[vector] reconciliation failed', error);
    }
  }
  return report;
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
  const raw = await readJson(IMAGE_GEN_KEY, null);
  return normalizeImageGenSettings(raw);
}

export async function saveImageGenSettings(settings) {
  const normalized = normalizeImageGenSettings(settings);
  await AsyncStorage.setItem(IMAGE_GEN_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizeChatOptions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    streaming: source.streaming !== false,
    fullWidth: source.fullWidth === true,
    // 含 <style>/<script> 的助手消息是否用 WebView 渲染；缺省开启。
    richHtml: source.richHtml !== false,
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
    providerId: normalizeImageProviderId(source.providerId),
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

function stickerItemKey(id) {
  return `${STICKER_ITEM_PREFIX}::${String(id || '')}`;
}

function normalizeSticker(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || '').trim(),
    uri: String(source.uri || ''),
    mime: String(source.mime || 'image/jpeg'),
    width: Number(source.width) || 0,
    height: Number(source.height) || 0,
    createdAt: Number(source.createdAt) || 0,
  };
}

async function readStickerIndexStatus() {
  const stored = await readJsonStatus(STICKER_INDEX_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(STICKER_INDEX_KEY);
    return { status: 'corrupt', ids: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', ids: [] };
  return {
    status: 'ok',
    ids: [...new Set((stored.value || []).map(id => String(id || '')).filter(Boolean))],
  };
}

function sortStickers(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeSticker)
    .filter(item => item.id && item.name && item.uri)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function migrateLegacyStickers() {
  const legacy = await readJsonStatus(STICKERS_KEY);
  if (legacy.status === 'missing') return { status: 'missing', stickers: [] };
  if (legacy.status === 'corrupt' || !Array.isArray(legacy.value)) {
    await backupCorruptValue(STICKERS_KEY);
    return { status: 'corrupt', stickers: [] };
  }
  const normalized = legacy.value.map(normalizeSticker);
  if (normalized.some(item => !item.id || !item.name || !item.uri)) {
    await backupCorruptValue(STICKERS_KEY);
    return { status: 'corrupt', stickers: [] };
  }
  const stickers = sortStickers(normalized);
  const ids = [...new Set(stickers.map(item => item.id))];
  if (ids.length > 0) {
    await AsyncStorage.multiSet(stickers.map(item => [stickerItemKey(item.id), JSON.stringify(item)]));
    await AsyncStorage.setItem(STICKER_INDEX_KEY, JSON.stringify(ids));
  } else {
    await AsyncStorage.setItem(STICKER_INDEX_KEY, JSON.stringify([]));
  }
  await AsyncStorage.removeItem(STICKERS_KEY);
  return { status: 'ok', stickers };
}

async function readStickerStatus() {
  const index = await readStickerIndexStatus();
  if (index.status === 'missing') return migrateLegacyStickers();
  if (index.status !== 'ok') return { status: index.status, stickers: [] };
  const stickers = [];
  for (const id of index.ids) {
    const stored = await readJsonStatus(stickerItemKey(id));
    if (stored.status === 'missing') {
      await backupCorruptValue(stickerItemKey(id));
      return { status: 'corrupt', stickers: [] };
    }
    if (stored.status === 'corrupt' || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) {
      await backupCorruptValue(stickerItemKey(id));
      return { status: 'corrupt', stickers: [] };
    }
    const normalized = normalizeSticker(stored.value);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      await backupCorruptValue(stickerItemKey(id));
      return { status: 'corrupt', stickers: [] };
    }
    stickers.push(normalized);
  }
  const legacy = await readJsonStatus(STICKERS_KEY);
  if (legacy.status !== 'missing') {
    if (legacy.status === 'corrupt' || !Array.isArray(legacy.value)) {
      await backupCorruptValue(STICKERS_KEY);
      return { status: 'ok', stickers: sortStickers(stickers) };
    }
    const normalizedLegacy = legacy.value.map(normalizeSticker);
    if (normalizedLegacy.some(item => !item.id || !item.name || !item.uri)) {
      await backupCorruptValue(STICKERS_KEY);
      return { status: 'ok', stickers: sortStickers(stickers) };
    }
    const byId = new Map(stickers.map(item => [item.id, item]));
    normalizedLegacy.forEach(item => {
      if (!byId.has(item.id)) byId.set(item.id, item);
    });
    const merged = sortStickers([...byId.values()]);
    await writeStickerCollection(merged);
    return { status: 'ok', stickers: merged };
  }
  return { status: 'ok', stickers: sortStickers(stickers) };
}

async function writeStickerCollection(stickers) {
  const list = sortStickers(stickers).filter(
    (item, index, all) => all.findIndex(other => other.id === item.id) === index
  );
  const ids = list.map(item => item.id);
  if (list.length > 0) {
    await AsyncStorage.multiSet(list.map(item => [stickerItemKey(item.id), JSON.stringify(item)]));
  }
  await AsyncStorage.setItem(STICKER_INDEX_KEY, JSON.stringify(ids));
  await AsyncStorage.removeItem(STICKERS_KEY);
  try {
    const keys = await AsyncStorage.getAllKeys();
    const activeIds = new Set(ids);
    const staleKeys = keys.filter(key => (
      String(key).startsWith(`${STICKER_ITEM_PREFIX}::`)
      && !activeIds.has(String(key).slice(`${STICKER_ITEM_PREFIX}::`.length))
    ));
    if (staleKeys.length > 0) await AsyncStorage.multiRemove(staleKeys);
  } catch (error) {}
}

export function getStickers() {
  const task = stickerWriteQueue.then(async () => {
    const result = await readStickerStatus();
    return result.stickers;
  });
  stickerWriteQueue = task.catch(() => {});
  return task;
}

export async function collectStickerImageFiles() {
  const status = await readStickerStatus();
  if (status.status !== 'ok') return false;
  const referenced = new Set(status.stickers.map(item => String(item.uri || '')).filter(Boolean));
  const directory = `${FileSystem.documentDirectory || ''}stickers/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  for (const entry of entries) {
    const uri = `${directory}${entry}`;
    if (referenced.has(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  return true;
}

export async function collectOrphanImageFiles() {
  const [chatResult, stickerResult] = await Promise.all([
    collectChatImageFiles(),
    collectStickerImageFiles(),
  ]);
  return chatResult !== false && stickerResult !== false;
}

export function saveSticker(sticker) {
  const task = stickerWriteQueue.then(async () => {
    const normalized = normalizeSticker(sticker);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      throw new Error('表情包信息不完整');
    }
    const result = await readStickerStatus();
    if (result.status === 'corrupt') {
      throw new Error('表情包记录读取失败，请稍后重试');
    }
    await writeStickerCollection([
      normalized,
      ...result.stickers.filter(item => item.id !== normalized.id),
    ]);
    return normalized;
  });
  stickerWriteQueue = task.catch(() => {});
  return task;
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
    // 这条动态是从哪段对话（记忆）里来的：评论回复会依据它对应的记忆来生成。
    // 老数据没有这个字段，按空串处理（回复时退化为只用角色设定 + 动态本身）。
    sessionId: String(source.sessionId || ''),
    trigger: String(source.trigger || ''),
    text: String(source.text || ''),
    createdAt: Number(source.createdAt) || 0,
    likedByUser: source.likedByUser === true,
    likes,
    comments,
  };
}

export async function getMomentsStatus() {
  const stored = await readJsonStatus(MOMENTS_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    // 动态此前没有任何损坏保护：读失败被当成空列表，写回时就把整表清掉。先备份再拒绝覆盖。
    await backupCorruptValue(MOMENTS_KEY);
    return { status: 'corrupt', moments: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', moments: [] };
  const moments = stored.value
    .map(normalizeMoment)
    .filter(item => item.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  return { status: 'ok', moments };
}

export async function getMoments() {
  const { moments } = await getMomentsStatus();
  return moments;
}

async function readMomentsForMutation() {
  const { status, moments } = await getMomentsStatus();
  if (status === 'corrupt') {
    throw new Error('动态记录读取失败，请稍后重试');
  }
  return moments;
}

async function saveMomentsInternal(moments) {
  const list = Array.isArray(moments) ? moments.map(normalizeMoment).filter(item => item.id) : [];
  await AsyncStorage.setItem(MOMENTS_KEY, JSON.stringify(list));
  return list;
}

export function saveMoments(moments) {
  return enqueueMomentsMutation(async () => {
    await readMomentsForMutation();
    return saveMomentsInternal(moments);
  });
}

export function updateMoments(updater) {
  return enqueueMomentsMutation(async () => {
    const current = await readMomentsForMutation();
    const next = typeof updater === 'function' ? await updater(current) : current;
    if (next === undefined) return current;
    return saveMomentsInternal(next);
  });
}

function normalizeForgeDraft(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const draft = {};
  FORGE_FIELDS.forEach(key => {
    draft[key] = String(source[key] || '').slice(0, 4000);
  });
  draft.tags = Array.isArray(source.tags)
    ? source.tags.map(item => String(item || '').trim()).filter(Boolean).slice(0, 10)
    : [];
  // 这几个字段不参与 AI 改写，但要随草稿一起持久化，保证「角色 → 制卡 → 角色」往返不丢内容
  draft.systemPrompt = String(source.systemPrompt || '').slice(0, 12000);
  draft.alternateGreetings = Array.isArray(source.alternateGreetings)
    ? source.alternateGreetings.map(item => String(item || '')).filter(Boolean).slice(0, 20)
    : [];
  draft.worldInfo = Array.isArray(source.worldInfo)
    ? source.worldInfo.filter(item => item && typeof item === 'object').slice(0, 100)
    : [];
  draft.regexScripts = Array.isArray(source.regexScripts)
    ? source.regexScripts.filter(item => item && typeof item === 'object').slice(0, 100)
    : [];
  return draft;
}

function normalizeForgeTranscript(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id || `forge-${index}`),
      role: item.role === 'ai' || item.role === 'user' ? item.role : 'note',
      text: String(item.text || '').slice(0, 4000),
      questionId: String(item.questionId || ''),
      createdAt: Number(item.createdAt) || 0,
    }))
    .filter(item => item.text)
    .slice(-200);
}

function normalizeCardForgeState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!source) return null;
  const sourceAnswers = source.answers && typeof source.answers === 'object' ? source.answers : {};
  const answers = {};
  FORGE_QUESTIONS.forEach(question => {
    const value = String(sourceAnswers[question.id] || '').slice(0, 600);
    if (value) answers[question.id] = value;
  });
  return {
    version: 1,
    step: Math.min(
      Math.max(0, Math.trunc(Number(source.step)) || 0),
      FORGE_QUESTIONS.length
    ),
    answers,
    draft: normalizeForgeDraft(source.draft),
    transcript: normalizeForgeTranscript(source.transcript),
    updatedAt: Number(source.updatedAt) || 0,
  };
}

export async function getCardForgeStatus() {
  const stored = await readJsonStatus(CARD_FORGE_KEY);
  const invalidShape = stored.status === 'ok'
    && (!stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value));
  if (stored.status === 'corrupt' || invalidShape) {
    await backupCorruptValue(CARD_FORGE_KEY);
    return { status: 'corrupt', state: null };
  }
  if (stored.status === 'missing') return { status: 'missing', state: null };
  return { status: 'ok', state: normalizeCardForgeState(stored.value) };
}

export async function getCardForge() {
  const { state } = await getCardForgeStatus();
  return state;
}

export async function saveCardForge(state) {
  const status = await getCardForgeStatus();
  if (status.status === 'corrupt') {
    throw new Error('制卡草稿读取失败，请先处理损坏数据');
  }
  const normalized = normalizeCardForgeState(state);
  if (!normalized) throw new Error('制卡状态无效');
  await AsyncStorage.setItem(CARD_FORGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function clearCardForge() {
  try {
    await AsyncStorage.removeItem(CARD_FORGE_KEY);
  } catch (error) {}
}

// 删除锚定在这些会话（记忆）上的动态。返回被删除的动态 id，便于调用方提示结果。
export async function deleteMomentsBySessionIds(sessionIds) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : [])
    .map(item => String(item || ''))
    .filter(Boolean);
  if (ids.length === 0) return [];
  let removedIds = [];
  await updateMoments(list => {
    removedIds = list
      .filter(item => ids.includes(String(item.sessionId || '')))
      .map(item => item.id);
    return removedIds.length > 0 ? removeMomentsBySessionIds(list, ids) : list;
  });
  return removedIds;
}

export async function deleteMomentsForCharacterDeletion(characterIds, sessionIds = []) {
  let removedIds = [];
  await updateMoments(moments => {
    const next = removeMomentsForCharacterDeletion(moments, characterIds, sessionIds);
    removedIds = moments
      .filter(item => !next.includes(item))
      .map(item => String(item && item.id || ''))
      .filter(Boolean);
    return removedIds.length > 0 ? next : moments;
  });
  return removedIds;
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

export async function getAffinityStatus() {
  const stored = await readJsonStatus(AFFINITY_KEY);
  const isBadObject = stored.status === 'ok'
    && (!stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value));
  if (stored.status === 'corrupt' || isBadObject) {
    await backupCorruptValue(AFFINITY_KEY);
    return { status: 'corrupt', map: {} };
  }
  if (stored.status === 'missing') return { status: 'missing', map: {} };
  return { status: 'ok', map: normalizeAffinityState(stored.value) };
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
  const stored = await readJsonStatus(API_CONFIGS_KEY);
  let payload = stored.status === 'ok' ? stored.value : null;
  const shapeInvalid = payload !== null
    && (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.configs));
  if (stored.status === 'corrupt' || shapeInvalid) {
    // 以前这里直接抛错：用户会卡在“读不到配置”，原始数据既没备份也无法自愈。
    // 现在先备份原始值，再按“缺失”重建默认配置。
    await backupCorruptValue(API_CONFIGS_KEY);
    payload = null;
  }
  let configs = [];
  let activeId = '';
  let needsPersist = false;

  if (payload) {
    configs = ensureUniqueApiConfigIds(payload.configs.map(normalizeApiConfig));
    activeId = String(payload.activeId || '');
  } else {
    const legacy = await readJsonStatus(API_CONFIG_KEY);
    if (legacy.status === 'corrupt') await backupCorruptValue(API_CONFIG_KEY);
    const legacyValue = legacy.status === 'ok'
      && legacy.value && typeof legacy.value === 'object' && !Array.isArray(legacy.value)
      ? legacy.value
      : null;
    const seed = legacyValue
      ? { ...legacyValue, id: 'default', name: '默认配置' }
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

const DEFAULT_USER_PROFILE = { userName: '', persona: '', avatarUri: '' };
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
  };
}

export async function getPersonas() {
  const stored = await readJsonStatus(PERSONAS_KEY);
  if (stored.status === 'ok' && Array.isArray(stored.value) && stored.value.length > 0) {
    return stored.value.map(normalizePersona);
  }
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    // 读不出就不落盘，更不能把其余人设覆盖成一条；返回默认值，下次可重试。
    await backupCorruptValue(PERSONAS_KEY);
    const now = Date.now();
    return [{ id: DEFAULT_PERSONA_ID, userName: '', persona: '', createdAt: now, updatedAt: now }];
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
  const stored = await readJsonStatus(PRESET_LIST_KEY);
  if (stored.status === 'missing') return GLOBAL_PRESETS.map(normalizePreset);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(PRESET_LIST_KEY);
    return GLOBAL_PRESETS.map(normalizePreset);
  }
  try {
    return normalizePresetList(stored.value);
  } catch (error) {
    // 结构不合法时尽量保留可用项，而不是整份丢弃（原始值已备份）
    const list = Array.isArray(stored.value) ? stored.value : [];
    const kept = [];
    const seen = new Set();
    list.forEach(item => {
      try {
        const preset = normalizePreset(item);
        if (seen.has(preset.id)) return;
        seen.add(preset.id);
        kept.push(preset);
      } catch (entryError) {}
    });
    await backupCorruptValue(PRESET_LIST_KEY);
    return kept.length > 0 ? kept : GLOBAL_PRESETS.map(normalizePreset);
  }
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
  const stored = await readJsonStatus(GLOBAL_PRESETS_KEY);
  if (stored.status === 'missing') return {};
  const enabled = stored.status === 'ok' ? stored.value : null;
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) {
    // 这里抛错会连累 getEnabledGlobalPresetPrompts，而后者位于发送消息的
    // Promise.all 中 —— 一个损坏的开关文件会导致“聊天完全发不出去”。
    // 改为退回空开关并备份原始值。
    await backupCorruptValue(GLOBAL_PRESETS_KEY);
    return {};
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

function buildDefaultPlugins() {
  return DEFAULT_PLUGINS.map(preset => normalizePlugin(preset));
}

export async function getPlugins() {
  const stored = await readJsonStatus(PLUGINS_KEY);
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

export async function isOnboardingDone() {
  const raw = await AsyncStorage.getItem(ONBOARDING_DONE_KEY);
  return raw === 'true';
}

export async function completeOnboarding() {
  await AsyncStorage.setItem(ONBOARDING_DONE_KEY, 'true');
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

// 会话列表的读取状态：损坏时先备份原始值再当作空列表，避免调用方
// 用空列表把“暂时读不出”的真实数据整表覆盖掉（Android cursor window 等）。
async function readSessionsStatus() {
  const stored = await readJsonStatus(SESSIONS_KEY);
  if (stored.status === 'missing') return { status: 'missing', sessions: [] };
  if (stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    await backupCorruptValue(SESSIONS_KEY);
    return { status: 'corrupt', sessions: [] };
  }
  return {
    status: 'ok',
    sessions: ensureUniqueSessionIds(stored.value.map(normalizeSession)),
  };
}

// 只读路径：损坏时返回空列表（UI 容忍空列表，且不会写回）。
export async function getSessions() {
  const { sessions } = await readSessionsStatus();
  return sessions;
}

// 读改写路径：列表损坏时必须中止，否则会把 SESSIONS_KEY 覆盖成空/单条。
async function requireSessions() {
  const { status, sessions } = await readSessionsStatus();
  if (status === 'corrupt') {
    throw new Error('会话记录读取失败，请稍后重试');
  }
  return sessions;
}

async function saveSessionsInternal(sessions) {
  const list = ensureUniqueSessionIds(
    (Array.isArray(sessions) ? sessions : []).map(normalizeSession)
  );
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  return list;
}

export function saveSessions(sessions) {
  return enqueueSessionMutation(async () => {
    const status = await readSessionsStatus();
    if (status.status === 'corrupt') {
      throw new Error('会话记录读取失败，请稍后重试');
    }
    return saveSessionsInternal(sessions);
  });
}

export async function getActiveSessionId() {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
    return raw ? String(JSON.parse(raw)) : '';
  } catch (error) {
    return '';
  }
}

async function setActiveSessionIdInternal(id) {
  await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(String(id || '')));
}

export function setActiveSessionId(id) {
  return enqueueSessionMutation(() => setActiveSessionIdInternal(id));
}

export function setProtectedChatImageUris(uris) {
  protectedChatImageUris.clear();
  (Array.isArray(uris) ? uris : []).forEach(uri => {
    const value = String(uri || '');
    if (value.includes('/chat-images/')) protectedChatImageUris.add(value);
  });
}

function imageUrisFromMessages(messages) {
  const result = new Set();
  (Array.isArray(messages) ? messages : []).forEach(item => {
    const uri = String(item && item.image && item.image.uri || '');
    if (uri.includes('/chat-images/')) result.add(uri);
  });
  return result;
}

export async function collectChatImageFiles(protectedUris = []) {
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    return false;
  }
  const messageKeys = keys.filter(key => (
    key === MESSAGES_KEY_PREFIX || String(key).startsWith(`${MESSAGES_KEY_PREFIX}::`)
  ));
  const referenced = new Set([
    ...protectedChatImageUris,
    ...(Array.isArray(protectedUris) ? protectedUris : [])
      .map(uri => String(uri || ''))
      .filter(uri => uri.includes('/chat-images/')),
  ]);
  for (const key of messageKeys) {
    if (String(key).endsWith(CORRUPT_BACKUP_SUFFIX)) return false;
    let raw = null;
    try {
      raw = await AsyncStorage.getItem(key);
    } catch (error) {
      raw = await readLargeAsyncStorageValue(key);
    }
    if (raw === null || raw === undefined) return false;
    if (!raw) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return false;
    }
    if (!Array.isArray(parsed)) return false;
    imageUrisFromMessages(parsed).forEach(uri => referenced.add(uri));
  }
  const directory = `${FileSystem.documentDirectory || ''}chat-images/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  for (const entry of entries) {
    const uri = `${directory}${entry}`;
    if (referenced.has(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  return true;
}

export async function getMessagesBySessionStatus(sessionId) {
  const key = sessionMessagesKey(sessionId);
  const stored = await readJsonStatus(key);
  // 读失败、或结构不是数组（合法 JSON 但类型不对）都算损坏：先留副本，
  // 调用方据此提示“记录未删除”，并避免把它误当成空会话被后续写盘覆盖。
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return { status: 'corrupt', messages: [] };
  }
  return {
    status: stored.status === 'missing' ? 'missing' : 'ok',
    messages: Array.isArray(stored.value) ? stored.value.filter(item => item && !item.pending) : [],
  };
}

export async function getMessagesBySession(sessionId) {
  const { messages } = await getMessagesBySessionStatus(sessionId);
  return messages;
}

async function saveMessagesBySessionInternal(sessionId, messages, characterId = '', protectedUris = []) {
  const id = String(sessionId || '');
  if (deletedSessionIds.has(id)) return [];
  const persistable = (messages || []).filter(item => item && !item.pending);
  const previousStatus = await getMessagesBySessionStatus(sessionId);
  if (previousStatus.status === 'corrupt') {
    throw new Error('聊天记录读取失败，请稍后重试');
  }
  const previousImages = previousStatus.status === 'corrupt'
    ? new Set()
    : imageUrisFromMessages(previousStatus.messages);
  const nextImages = imageUrisFromMessages(persistable);
  const removedImage = [...previousImages].some(uri => !nextImages.has(uri));
  await AsyncStorage.setItem(sessionMessagesKey(sessionId), JSON.stringify(persistable));
  if (removedImage && previousStatus.status !== 'corrupt') {
    await collectChatImageFiles(protectedUris);
  }
  const sessionsStatus = await readSessionsStatus();
  // 会话列表读不出时只保留消息体落盘，绝不用空/部分列表整表覆盖（否则会真丢会话）。
  if (sessionsStatus.status === 'corrupt') return persistable;
  const sessions = sessionsStatus.sessions;
  const existing = sessions.find(session => session.id === sessionId);
  if (existing) {
    const updated = sessions.map(session =>
      session.id === sessionId
        ? { ...session, preview: buildPreview(persistable), updatedAt: Date.now() }
        : session
    );
    await saveSessionsInternal(sortSessions(updated));
    return persistable;
  }
  // 会话条目缺失（历史版本的 startNewSession 会误删），但消息体还在：
  // 只要调用方能给出归属角色，就补回这一行，避免“消息还在、会话却永远看不见”。
  // 只补“仍然是当前会话”的那一个：删除会话会立刻把 activeSessionId 切到新会话，
  // 因此这条判断能挡住“用飞行中的写盘请求把已删除的会话复活”。
  const ownerId = String(characterId || '');
  if (persistable.length > 0 && ownerId) {
    const activeId = await getActiveSessionId();
    if (activeId === String(sessionId)) {
      const summaryStatus = await getSessionSummariesStatus(sessionId);
      if (summaryStatus.status === 'corrupt') {
        throw new Error('记忆摘要读取失败，请稍后重试');
      }
      const timestamps = persistable
        .map(item => Number(item.timestamp))
        .filter(value => Number.isFinite(value));
      const restored = {
        ...createEmptySession(ownerId, sessions),
        id: String(sessionId),
        characterId: ownerId,
        preview: buildPreview(persistable),
        createdAt: timestamps.length ? Math.min(...timestamps) : Date.now(),
        updatedAt: timestamps.length ? Math.max(...timestamps) : Date.now(),
      };
      const boundary = String(
        summaryStatus.summaries.length > 0
          ? summaryStatus.summaries[summaryStatus.summaries.length - 1].boundary
          : ''
      );
      if (boundary && persistable.some(item => String(item.id || '') === boundary)) {
        restored.summarizedUpTo = boundary;
      }
      await saveSessionsInternal(sortSessions([...sessions, restored]));
    }
  }
  return persistable;
}

async function setSessionSummarizedUpToInternal(sessionId, messageId) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target) throw new Error('会话不存在');
  const nextBoundary = String(messageId || '');
  if (!nextBoundary) {
    if (!target.summarizedUpTo) return target;
    const updated = { ...target, summarizedUpTo: '' };
    await saveSessionsInternal(sessions.map(session => (
      session.id === sessionId ? updated : session
    )));
    return updated;
  }
  const messages = await getMessagesBySession(sessionId);
  const newIndex = messages.findIndex(item => item.id === nextBoundary);
  if (newIndex < 0) throw new Error('总结边界无效');
  const oldIndex = messages.findIndex(item => item.id === target.summarizedUpTo);
  if (target.summarizedUpTo && oldIndex >= 0 && newIndex <= oldIndex) {
    return target;
  }
  const updated = { ...target, summarizedUpTo: nextBoundary };
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

export function setSessionSummarizedUpTo(sessionId, messageId, expectedRevision = null) {
  return enqueueSessionMutation(() => {
    if (expectedRevision !== null && !isSessionSummaryRevisionCurrent(sessionId, expectedRevision)) {
      throw new Error('会话摘要已重置');
    }
    return setSessionSummarizedUpToInternal(sessionId, messageId);
  });
}

function sessionSummariesKey(sessionId) {
  return `${SESSION_SUMMARIES_PREFIX}::${String(sessionId || '')}`;
}

function bumpSessionSummaryRevision(sessionId) {
  const id = String(sessionId || '');
  const next = (sessionSummaryRevisions.get(id) || 0) + 1;
  sessionSummaryRevisions.set(id, next);
  return next;
}

export function getSessionSummaryRevision(sessionId) {
  return sessionSummaryRevisions.get(String(sessionId || '')) || 0;
}

export function isSessionSummaryRevisionCurrent(sessionId, revision) {
  return getSessionSummaryRevision(sessionId) === Number(revision || 0);
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

export async function getSessionSummariesStatus(sessionId) {
  const key = sessionSummariesKey(sessionId);
  const stored = await readJsonStatus(key);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return { status: 'corrupt', summaries: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', summaries: [] };
  const summaries = stored.value
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
  return { status: 'ok', summaries };
}

export async function getSessionSummaries(sessionId) {
  const { summaries } = await getSessionSummariesStatus(sessionId);
  return summaries;
}

async function saveSessionSummariesInternal(sessionId, list) {
  const normalized = (Array.isArray(list) ? list : [])
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
  await AsyncStorage.setItem(sessionSummariesKey(sessionId), JSON.stringify(normalized));
  return normalized;
}

export function resetSessionSummaries(sessionId) {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(async () => {
    const sessions = await requireSessions();
    const target = sessions.find(session => session.id === sessionId);
    if (!target) throw new Error('会话不存在');
    const key = sessionSummariesKey(sessionId);
    const previous = await AsyncStorage.getItem(key);
    await AsyncStorage.removeItem(key);
    try {
      return await saveSessionsInternal(sessions.map(session => (
        session.id === sessionId ? { ...session, summarizedUpTo: '' } : session
      )));
    } catch (error) {
      if (previous !== null && previous !== undefined) {
        await AsyncStorage.setItem(key, previous).catch(() => {});
      }
      throw error;
    }
  });
}

export function appendSessionSummary(sessionId, entry, expectedRevision = null) {
  const task = enqueueSessionMutation(async () => {
    if (expectedRevision !== null && !isSessionSummaryRevisionCurrent(sessionId, expectedRevision)) {
      throw new Error('会话摘要已重置');
    }
    const { status, summaries } = await getSessionSummariesStatus(sessionId);
    if (status === 'corrupt') throw new Error('记忆摘要读取失败，请稍后重试');
    const normalizedEntry = normalizeSessionSummary(entry);
    const next = [...summaries, normalizedEntry];
    await saveSessionSummariesInternal(sessionId, next);
    try {
      await setSessionSummarizedUpToInternal(sessionId, normalizedEntry.boundary);
    } catch (error) {
      if (
        expectedRevision === null
        || isSessionSummaryRevisionCurrent(sessionId, expectedRevision)
      ) {
        await saveSessionSummariesInternal(sessionId, summaries).catch(() => {});
      }
      throw error;
    }
    return next;
  });
  return task;
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
      const text = String(
        message.text
        || (message.image && (message.image.stickerName || message.image.name))
        || ''
      );
      if (!text || !text.toLowerCase().includes(needle)) continue;
      results.push({
         sessionId: session.id,
         sessionType: session.type || 'single',
         sessionName: String(session.name || ''),
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

async function startNewSessionInternal(characterId, opening = null) {
  // 这里以前会先扫描每个会话的消息体，只把“读得到内容”的会话写回列表。
  // 于是任何一次读取失败（例如值过大触发 Android cursor window）都会让该会话
  // 被静默地从会话列表里删除：消息体还在，但会话再也看不见、也删不掉，
  // 只有下次扫描恰好成功时才会“复活”。新建对话无权删掉别的会话。
  const sessions = await requireSessions();
  const created = createEmptySession(characterId, sessions);
  created.greetingSelected = opening !== null && opening !== undefined;
  const openingText = String(opening && opening.text || '').trim();
  const openingTemplate = String(opening && opening.template || openingText).trim();
  if (openingText) {
    const greeting = {
      id: `greeting-${created.id}`,
      role: 'assistant',
      text: openingText,
      timestamp: Date.now(),
      kind: 'greeting',
      greetingTemplate: openingTemplate,
    };
    created.preview = buildPreview([greeting]);
    await AsyncStorage.setItem(sessionMessagesKey(created.id), JSON.stringify([greeting]));
  }
  const next = sortSessions([...sessions, created]);
  await saveSessionsInternal(next);
  await setActiveSessionIdInternal(created.id);
  return created;
}

async function setSessionGreetingSelectedInternal(sessionId, selected = true) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target || target.type === 'group') return target || null;
  const updated = { ...target, greetingSelected: selected !== false };
  if (updated.greetingSelected === target.greetingSelected) return target;
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

async function createGroupSessionInternal(members, name, extras = {}) {
  const sessions = await requireSessions();
  const created = buildGroupSession(members, name, sessions, Date.now(), extras);
  const next = sortSessions([...sessions, created]);
  await saveSessionsInternal(next);
  await setActiveSessionIdInternal(created.id);
  return created;
}

async function updateSessionInfoInternal(sessionId, patch = {}) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target || target.type !== 'group') return target || null;
  const source = patch && typeof patch === 'object' ? patch : {};
  const updated = { ...target };
  if (source.name !== undefined) updated.name = String(source.name || '');
  if (source.avatarUri !== undefined) updated.avatarUri = String(source.avatarUri || '');
  if (source.bgUri !== undefined) updated.bgUri = String(source.bgUri || '');
  updated.updatedAt = Date.now();
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

async function updateSessionMemberProfilesInternal(sessionId, memberProfiles) {
  const sessions = await requireSessions();
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
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

async function cloneSessionInternal(sessionId) {
  const sessions = await requireSessions();
  const source = sessions.find(session => session.id === sessionId);
  if (!source) throw new Error('会话不存在');
  const messages = await getMessagesBySession(sessionId);
  const now = Date.now();
  const copy = buildClonedSession(sessions, source, messages, now);
  await AsyncStorage.setItem(
    sessionMessagesKey(copy.id),
    JSON.stringify(regenerateMessageIds(messages, now))
  );
  await saveSessionsInternal(sortSessions([...sessions, copy]));
  return copy;
}

async function deleteSessionInternal(sessionId) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  const activeId = await getActiveSessionId();
  const remaining = sessions.filter(session => session.id !== sessionId);
  await saveSessionsInternal(remaining);
  if (target && target.type !== 'group') {
    try {
      await removeVectorIndexForSession(target.characterId, sessionId);
    } catch (error) {
      if (__DEV__) console.warn('[vector] session cleanup failed', error);
    }
  }
  deletedSessionIds.add(String(sessionId));
  try {
    await AsyncStorage.multiRemove([
      sessionMessagesKey(sessionId),
      sessionSummariesKey(sessionId),
    ]);
  } catch (error) {}
  await collectChatImageFiles();
  if (activeId === sessionId) {
    const created = createEmptySession(target && target.characterId, remaining);
    const next = sortSessions([...remaining, created]);
    await saveSessionsInternal(next);
    await setActiveSessionIdInternal(created.id);
    return { sessions: next, activeSessionId: created.id, created };
  }
  return { sessions: remaining, activeSessionId: activeId, created: null };
}

async function deleteSessionsInternal(sessionIds) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  const sessions = await requireSessions();
  if (ids.length === 0) {
    return { sessions, activeSessionId: await getActiveSessionId() };
  }
  const idSet = new Set(ids);
  const remaining = sessions.filter(session => !idSet.has(session.id));
  await saveSessionsInternal(remaining);
  const vectorTargets = new Map();
  for (const id of ids) {
    const target = sessions.find(session => session.id === id);
    if (!target || target.type === 'group' || !target.characterId) continue;
    const ownerId = String(target.characterId);
    const targetIds = vectorTargets.get(ownerId) || [];
    targetIds.push(id);
    vectorTargets.set(ownerId, targetIds);
  }
  for (const [ownerId, targetIds] of vectorTargets) {
    try {
      await removeVectorIndexForSessions(ownerId, targetIds);
    } catch (error) {
      if (__DEV__) console.warn('[vector] batch session cleanup failed', error);
    }
  }
  ids.forEach(id => deletedSessionIds.add(String(id)));
  try {
    await AsyncStorage.multiRemove(ids.flatMap(id => [
      sessionMessagesKey(id),
      sessionSummariesKey(id),
    ]));
  } catch (error) {}
  await collectChatImageFiles();
  return { sessions: remaining, activeSessionId: await getActiveSessionId() };
}

export function saveMessagesBySession(sessionId, messages, characterId = '', protectedUris = []) {
  return enqueueSessionMutation(() => saveMessagesBySessionInternal(
    sessionId,
    messages,
    characterId,
    protectedUris
  ));
}

export function startNewSession(characterId, opening = null) {
  return enqueueSessionMutation(() => startNewSessionInternal(characterId, opening));
}

export function setSessionGreetingSelected(sessionId, selected = true) {
  return enqueueSessionMutation(() => setSessionGreetingSelectedInternal(sessionId, selected));
}

export function createGroupSession(members, name, extras = {}) {
  return enqueueSessionMutation(() => createGroupSessionInternal(members, name, extras));
}

export function updateSessionInfo(sessionId, patch = {}) {
  return enqueueSessionMutation(() => updateSessionInfoInternal(sessionId, patch));
}

export function updateSessionMemberProfiles(sessionId, memberProfiles) {
  return enqueueSessionMutation(() => updateSessionMemberProfilesInternal(sessionId, memberProfiles));
}

export function cloneSession(sessionId) {
  return enqueueSessionMutation(() => cloneSessionInternal(sessionId));
}

export function deleteSession(sessionId) {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(() => deleteSessionInternal(sessionId));
}

export function deleteSessions(sessionIds) {
  (Array.isArray(sessionIds) ? sessionIds : []).forEach(id => bumpSessionSummaryRevision(id));
  return enqueueSessionMutation(() => deleteSessionsInternal(sessionIds));
}

export function restoreSession(sessionId, characterId) {
  return enqueueSessionMutation(() => restoreSessionInternal(sessionId, characterId));
}

export function migrateLegacyMessages(characters) {
  return enqueueSessionMutation(() => migrateLegacyMessagesInternal(characters));
}

// 找出"消息体还在、会话记录却丢了"的孤儿对话。
// 历史版本的 startNewSession 会把读不到消息体的会话从列表里静默删除，
// 结果消息留在 @easychat2_messages::<id>，但列表里再也看不到、也删不掉。
export async function findOrphanSessions() {
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    throw new Error('会话列表读取失败，请稍后重试');
  }
  const prefix = `${MESSAGES_KEY_PREFIX}::`;
  const ids = (Array.isArray(keys) ? keys : [])
    .filter(key => typeof key === 'string' && key.startsWith(prefix))
    // 损坏备份键（<消息键>__corrupt_backup）不是真实消息体，排除掉避免误当孤儿
    .filter(key => !key.endsWith(CORRUPT_BACKUP_SUFFIX))
    .map(key => key.slice(prefix.length))
    .filter(Boolean);
  if (ids.length === 0) return [];

  const { status, sessions } = await readSessionsStatus();
  // 列表读不出时不能判定孤儿（否则会把所有消息体都误判成“会话丢失”），
  // 明确抛错让调用方提示“读不到”，而不是伪装成“没有丢失的对话”。
  if (status === 'corrupt') throw new Error('会话列表读取失败，请稍后重试');
  const known = new Set(sessions.map(session => session.id));
  // 老版本按角色 id 存消息（messagesKey(characterId)），键的形状和会话键一样，
  // 会把它们当成孤儿。这里按角色库排除，避免把历史遗留键恢复成重复的对话。
  const characters = await getCharacterLibrary().catch(() => []);
  const characterIds = new Set(
    (Array.isArray(characters) ? characters : []).map(item => String((item && item.id) || ''))
  );
  const candidates = ids.filter(id => !known.has(id) && !characterIds.has(id));
  if (candidates.length === 0) return [];

  // 逐个读取：单个消息体过大触发读取失败时只跳过它，不能让整批孤儿陪葬
  // （最需要这个功能的就是“消息过大”的场景）。
  const entries = await Promise.all(candidates.map(async sessionId => {
    try {
      const raw = await AsyncStorage.getItem(sessionMessagesKey(sessionId));
      return { sessionId, raw };
    } catch (error) {
      return { sessionId, raw: null };
    }
  }));

  const orphans = [];
  for (const entry of entries) {
    const sessionId = entry && entry.sessionId;
    const raw = entry && entry.raw;
    if (!sessionId || !raw) continue;
    let parsed = [];
    try {
      const value = JSON.parse(raw);
      parsed = Array.isArray(value) ? value.filter(item => item && !item.pending) : [];
    } catch (error) {
      // 解析不了的消息体不参与恢复，避免把坏数据当成一段对话
      continue;
    }
    const messages = parsed.filter(item => (
      item && (item.role === 'user' || item.role === 'assistant')
    ));
    if (messages.length === 0) continue;
    const timestamps = messages
      .map(item => Number(item.timestamp))
      .filter(value => Number.isFinite(value));
    const firstReply = messages.find(item => (
      item.role === 'assistant' && String(item.text || '').trim()
    ));
    orphans.push({
      sessionId,
      messageCount: messages.length,
      preview: buildPreview(messages),
      createdAt: timestamps.length ? Math.min(...timestamps) : 0,
      updatedAt: timestamps.length ? Math.max(...timestamps) : 0,
      greeting: firstReply ? String(firstReply.text || '') : '',
      // 群聊消息带 speakerId：把发言人带出去，恢复时才能还原成群聊
      speakers: collectMessageSpeakers(messages),
    });
  }
  orphans.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return orphans;
}

// 把孤儿对话按指定角色补回会话列表，id 沿用原值，消息与已有的记忆摘要都会接上。
// 群聊（消息里带多个 speakerId）不需要归属角色，会还原成群聊并保留成员。
async function restoreSessionInternal(sessionId, characterId) {
  const id = String(sessionId || '');
  const owner = String(characterId || '');
  if (!id) throw new Error('恢复参数不完整');
  const sessions = await requireSessions();
  const existing = sessions.find(session => session.id === id);
  if (existing) return existing;
  const messages = await getMessagesBySession(id);
  if (messages.length === 0) throw new Error('这段对话没有可恢复的消息');
  if (!isMessageGroup(messages) && !owner) throw new Error('恢复参数不完整');
  const restored = buildRestoredSession({ sessionId: id, characterId: owner, messages });
  // 会话摘要还在（单独按 sessionId 存）：把总结边界接到最后一条摘要的边界上，
  // 免得下次总结把已经总结过的消息再总结一遍（弹窗承诺“记忆摘要会回来”）。
  const summaryStatus = await getSessionSummariesStatus(id);
  if (summaryStatus.status === 'corrupt') {
    throw new Error('记忆摘要读取失败，请稍后重试');
  }
  if (summaryStatus.summaries.length > 0) {
    const boundary = String(summaryStatus.summaries[summaryStatus.summaries.length - 1].boundary || '');
    if (boundary && messages.some(item => item && String(item.id) === boundary)) {
      restored.summarizedUpTo = boundary;
    }
  }
  await saveSessionsInternal(sortSessions([...sessions, restored]));
  return restored;
}

async function migrateLegacyMessagesInternal(characters) {
  const list = Array.isArray(characters) ? characters : [];
  const sessions = await requireSessions();
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
    await saveSessionsInternal(sortSessions([...sessions, ...migrated]));
  }
  return migrated;
}
