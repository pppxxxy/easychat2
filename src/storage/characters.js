// 角色库存储领域。从 src/storage.js 原样外提（无行为变化）。
// 角色按 id 拆键存储；大角色正文落到文件，AsyncStorage 只保留小型描述符，索引最后写作为提交点。
// 注：saveCharacterState（删除/保存的跨领域编排）仍留在 storage.js barrel。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { assignStableCharacterIds } from '../context/characterIdentity.js';
import { normalizeCharacterPresets } from '../characterPresets.js';
import { readJsonStatus, utf8ByteLength } from './io.js';

const CHARACTER_KEY = '@easychat2_character';
// 旧格式：整库数组存一个键（超过约 2MB 会触发 Android SQLite 行读取上限）。
const CHARACTERS_KEY = '@easychat2_characters';
// 新格式：只存角色 id 索引，角色本体按 id 拆到 CHARACTER_ITEM_PREFIX 键。
const CHARACTER_INDEX_KEY = '@easychat2_character_index';
export const CHARACTER_ITEM_PREFIX = '@easychat2_character_item';
const CHARACTER_MIGRATION_KEY = '@easychat2_character_migration';
const CHARACTER_PAYLOAD_DIRECTORY = 'characters';
const CHARACTER_PAYLOAD_FILE_VERSION = 1;
const CHARACTER_INLINE_LIMIT_BYTES = 512 * 1024;

let characterLibraryWriteBlocked = false;
const ACTIVE_CHARACTER_KEY = '@easychat2_active_character';

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
  // 旧数据没有 builtin：退化用"名字 + 系统提示"比对，尽量在首次读取时把真初始卡认出来并补标记。
  return String(character && character.name || '') === String(DEFAULT_CHARACTER.name || '')
    && String(character && character.systemPrompt || '') === String(DEFAULT_CHARACTER.systemPrompt || '');
}

function ensureDefaultCharacter(list, now = Date.now()) {
  const normalized = (Array.isArray(list) ? list : []).map(normalizeCharacter);
  const { list: items, changed } = assignStableCharacterIds(normalized, {
    defaultId: DEFAULT_CHARACTER.id,
    isInitial: isInitialCard,
    now,
  });
  // 补 builtin 标记：初始卡改名 / 改系统提示后仍能被识别，避免身份判定再次失效。
  // 同时只允许 default 持有 builtin：历史数据里可能残留多个 builtin，会让身份判定二义。
  let builtinChanged = false;
  const marked = items.map(item => {
    if (item.id === DEFAULT_CHARACTER.id) {
      if (item.builtin === true) return item;
      builtinChanged = true;
      return { ...item, builtin: true };
    }
    if (item.builtin === true) {
      builtinChanged = true;
      return { ...item, builtin: false };
    }
    return item;
  });
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

// ---- 角色编辑草稿 ----
// 角色页表单防抖暂存：切走/杀 App 后回来可恢复未保存的编辑。
// 草稿是辅助数据，读失败一律按“没有草稿”处理，不阻塞角色页正常流程。
const CHARACTER_EDIT_DRAFT_PREFIX = '@easychat2_character_edit_draft';

function characterEditDraftKey(id) {
  return `${CHARACTER_EDIT_DRAFT_PREFIX}::${String(id)}`;
}

export async function saveCharacterEditDraft(characterId, formState, characterSignature = '') {
  const id = String(characterId || '');
  if (!id) throw new Error('草稿缺少角色 id');
  await AsyncStorage.setItem(characterEditDraftKey(id), JSON.stringify({
    formState,
    characterSignature: String(characterSignature || ''),
    savedAt: Date.now(),
  }));
}

// 读即取走：返回草稿并立即删除，保证恢复确认框对同一份草稿只弹一次。
export async function takeCharacterEditDraft(characterId) {
  const id = String(characterId || '');
  if (!id) return null;
  const key = characterEditDraftKey(id);
  let draft = null;
  let raw = null;
  try {
    raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.formState && typeof parsed.formState === 'object') {
      draft = parsed;
    }
  } catch (error) {
    draft = null;
  }
  try {
    if (raw) await AsyncStorage.removeItem(key);
  } catch (error) {
    // 删除失败不影响返回，下次读取仍会取走
  }
  return draft;
}

export async function clearCharacterEditDraft(characterId) {
  const id = String(characterId || '');
  if (!id) return;
  try {
    await AsyncStorage.removeItem(characterEditDraftKey(id));
  } catch (error) {
    // 清理失败可忽略：草稿下次被读取或覆盖时自然处理
  }
}
