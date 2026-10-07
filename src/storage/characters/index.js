// 角色库存储领域：索引与迁移、活动角色、编辑草稿的聚合实现。
// 从 src/storage/characters.js 原样外提（无行为变化）。
// 公开导出面由 ../characters.js barrel 逐字保留。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { tActive } from '../../i18n/index.js';
import { recordDiagnostic } from '../diagnostics.js';
import { readJsonStatus } from '../io.js';
import {
  DEFAULT_CHARACTER,
  ensureDefaultCharacter,
  isCharacterLibraryWriteBlocked,
  normalizeCharacter,
  seedDefaultGreeting,
  setCharacterLibraryWriteBlocked,
  sortCharacters,
} from './shared.js';
import {
  CHARACTER_ITEM_PREFIX,
  CHARACTER_PAYLOAD_FILE_VERSION,
  characterItemKey,
  characterPayloadPath,
  cleanupCharacterPayloadFiles,
  readCharacterPayload,
  writeCharacterPayload,
} from './payload.js';

// 聚合对外导出：shared/payload 的公开符号统一从本模块转发，barrel 只需指向这里。
export { CHARACTER_ITEM_PREFIX } from './payload.js';
export { DEFAULT_CHARACTER, isCharacterLibraryWriteBlocked, sortCharacters } from './shared.js';

const CHARACTER_KEY = '@easychat2_character';
// 旧格式：整库数组存一个键（超过约 2MB 会触发 Android SQLite 行读取上限）。
const CHARACTERS_KEY = '@easychat2_characters';
// 新格式：只存角色 id 索引，角色本体按 id 拆到 CHARACTER_ITEM_PREFIX 键。
const CHARACTER_INDEX_KEY = '@easychat2_character_index';
const CHARACTER_MIGRATION_KEY = '@easychat2_character_migration';
// 一次性标记：内置默认角色的教学开场白是否已播种。播种后即使用户清空也不再补回，
// 避免「用户主动删掉开场白、下次启动又被填回」。
const DEFAULT_GREETING_SEED_KEY = '@easychat2_default_greeting_seed';
// 一次性标记：是否已为默认角色自动开启过含教学开场白的会话。
// 置位后，用户清空/删除会话也不再自动重开，尊重用户意图。
const DEFAULT_GREETING_SHOWN_KEY = '@easychat2_default_greeting_shown';

const ACTIVE_CHARACTER_KEY = '@easychat2_active_character';

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

async function readDefaultGreetingSeed() {
  try {
    return (await AsyncStorage.getItem(DEFAULT_GREETING_SEED_KEY)) === '1';
  } catch (error) {
    return false;
  }
}

async function markDefaultGreetingSeeded() {
  try {
    await AsyncStorage.setItem(DEFAULT_GREETING_SEED_KEY, '1');
  } catch (error) {}
}

// 内置教学开场白是否已自动展示过（一次性）。用于「默认角色空会话自动显示开场白」，
// 展示过之后即使用户清空也不再自动补，尊重用户意图。
export async function hasShownDefaultGreeting() {
  try {
    return (await AsyncStorage.getItem(DEFAULT_GREETING_SHOWN_KEY)) === '1';
  } catch (error) {
    return false;
  }
}

export async function markDefaultGreetingShown() {
  try {
    await AsyncStorage.setItem(DEFAULT_GREETING_SHOWN_KEY, '1');
  } catch (error) {}
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

function ensureDefaultCharacterOrPersistHint(items, greetingSeeded) {
  const hadDefault = items.some(item => item.id === DEFAULT_CHARACTER.id);
  const { list: ensured, changed } = ensureDefaultCharacter(items);
  const { list: seeded, changed: seededChanged } = seedDefaultGreeting(ensured, greetingSeeded);
  const list = sortCharacters(seeded);
  return { list, mustPersist: !hadDefault || changed || seededChanged, seededChanged };
}

export async function getCharacterLibrary() {
  const [index, legacy, marker, greetingSeeded] = await Promise.all([
    readCharacterIndex(),
    readLegacyCharacterItems(),
    readCharacterMigrationMarker(),
    readDefaultGreetingSeed(),
  ]);
  let items = [];
  let needsPersist = false;
  let writeBlocked = false;
  // 遗留键清理的守卫输入（见 getCharacterLibrary 尾部）：索引健康 + 逐角色键全部解析。
  let indexHealthy = false;
  let allItemsResolved = false;

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
    indexHealthy = true;
    allItemsResolved = unresolved.length === 0;
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

  const { list, mustPersist } = ensureDefaultCharacterOrPersistHint(items, greetingSeeded);
  if (writeBlocked) {
    setCharacterLibraryWriteBlocked(true);
    return list;
  }

  setCharacterLibraryWriteBlocked(false);
  if (index.ids && !marker && !needsPersist && !mustPersist) {
    try {
      await AsyncStorage.setItem(CHARACTER_MIGRATION_KEY, JSON.stringify({
        version: CHARACTER_PAYLOAD_FILE_VERSION,
        ids: index.ids,
      }));
    } catch (error) {
      setCharacterLibraryWriteBlocked(true);
      return list;
    }
  }
  if (needsPersist || mustPersist) {
    try {
      await persistLibrary(list);
    } catch (error) {
      setCharacterLibraryWriteBlocked(true);
    }
  }
  // 播种成功（或无需播种）后打一次性标记：避免用户主动清空后每次启动又被填回。
  if (!greetingSeeded && !isCharacterLibraryWriteBlocked()) {
    await markDefaultGreetingSeeded();
  }
  // ---- 守卫式一次性清理：角色遗留单体键（2026-10-07 收尾任务书）----
  // @easychat2_characters 是旧版「整库一个键」存储（>2MB 触发 CursorWindow 上限，
  // 当年正是它促发按 id 拆键迁移），迁移完成后一直没删——如今读不出（超限），
  // 却让每次备份导出都报「备份不完整」。守卫全绿才清：索引健康 + 逐角色键全部
  // 解析 + 写闸未触发（含持久化/标记写入未失败）。恢复老备份时先走 legacy 合并
  // → persistLibrary 写好逐角色键与索引 → 走到这里才清，顺序即保护。
  // 探测用 getAllKeys 成员判断，绝不能用 getItem 探测（超限值直接抛错——问题本身）。
  if (indexHealthy && allItemsResolved && !isCharacterLibraryWriteBlocked()) {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const legacyNames = [CHARACTERS_KEY, CHARACTER_KEY]
        .filter(name => (allKeys || []).includes(name));
      if (legacyNames.length > 0) {
        await AsyncStorage.multiRemove(legacyNames);
        // 等诊断落盘：本函数已到末尾，await 无代价且让测试可确定性断言。
        await recordDiagnostic(
          'storage',
          new Error(`已清理角色遗留存储键：${legacyNames.join(', ')}`),
          'character-legacy-cleanup'
        );
      }
    } catch (error) {}
  }
  return list;
}

export async function saveCharacterLibrary(list) {
  if (isCharacterLibraryWriteBlocked()) {
    throw new Error(tActive('error.storage.characterLibraryRecovering'));
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
  if (!id) throw new Error(tActive('error.storage.draftMissingCharacterId'));
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
