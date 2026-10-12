// 角色库存储领域：索引与迁移、活动角色、编辑草稿的聚合实现。
// 从 src/storage/characters.js 原样外提（无行为变化）。
// 公开导出面由 ../characters.js barrel 逐字保留。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { tActive } from '../../i18n/index.js';
import { recordDiagnostic } from '../diagnostics.js';
import { onCharacterDeleted } from '../characterLifecycle.js';
import { readJsonStatus, backupCorruptValue } from '../io.js';
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
export {
  DEFAULT_CHARACTER,
  isCharacterLibraryWriteBlocked,
  // 写闸的置位入口需要出圈：启动加载失败时 AppContext 要**主动**合闸（见下方
  // getCharacterLibrary 的 catch），不能只依赖存储层内部路径。状态本身仍只声明在
  // shared.js（禁止跨模块复制），这里只是转发，不产生第二份状态。
  setCharacterLibraryWriteBlocked,
  sortCharacters,
} from './shared.js';

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

// 读取 + 迁移的实现体。**不是公开入口**：任何一次读取失败都必须先合上写闸再抛出去，
// 那个「先合闸」的动作在下方 getCharacterLibrary 的包装里做，绕开包装直接调用会漏掉它。
async function readCharacterLibrary() {
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
    // 变体②：留副本 + 重建。
    // 参考 src/storage/localModels.js:63-64（getLocalModelIndex）：
    //   `await backupCorruptValue(LOCAL_MODEL_INDEX_KEY); return rebuildLocalModelIndex();`
    //
    // 这是本文件「三步缺①」里缺的那一步：索引坏了确实能识别（readJsonStatus）、
    // 也确实会重建（rebuildCharacterItemsFromKeys），但**从来没有留过副本**——
    // 「索引坏 → 重建 → persistLibrary 覆盖 CHARACTER_INDEX_KEY」这条链上原始字节
    // 一个副本都没有，用户事后没有任何人工恢复的依据。补上这一步。
    await backupCorruptValue(CHARACTER_INDEX_KEY);
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
        // 变体②的另一半：**删前先留副本**。
        // 参考 src/storage/localModels.js:63-64 的「留副本 + 重建」顺序，方向选择同
        // src/storage/mediaProtection.js:47（删除永远是可推迟的）。
        //
        // 为什么必须留副本：这两个键正是最可能「读不出」的那类数据——
        // CHARACTERS_KEY 是旧版整库单体键，>2MB 时 getItem 直接抛错（当年正是它促发
        // 按 id 拆键迁移）。此前是直接 multiRemove：原始字节零副本，而这是**唯一**一份
        // 旧格式数据。现在先备份、备份成功的才删。
        //
        // 为什么备份失败的键**不删**：留副本 + 重建的前提是副本真的留下了。
        // 「备份没成功却照样删」把不可恢复变成既成事实；留下的代价只是备份导出继续
        // 报「有键没进备份」——那是事实，而且比丢掉唯一一份旧数据轻得多。
        // 下次启动会重试（守卫条件不变）。探测仍只用 getAllKeys 成员判断，
        // 不用 getItem 判断存在性（超限值会抛错，那正是本条要绕开的问题）。
        const backedUp = [];
        for (const name of legacyNames) {
          if (await backupCorruptValue(name)) backedUp.push(name);
        }
        if (backedUp.length > 0) {
          await AsyncStorage.multiRemove(backedUp);
          // 等诊断落盘：本函数已到末尾，await 无代价且让测试可确定性断言。
          await recordDiagnostic(
            'storage',
            new Error(`已清理角色遗留存储键：${backedUp.join(', ')}`),
            'character-legacy-cleanup'
          );
        }
      }
    } catch (error) {}
  }
  return list;
}

// 角色库读取的**唯一公开入口**。这里包一层 try/catch 的原因是一整条已核实的不可逆链：
//
//   索引损坏 → rebuildCharacterItemsFromKeys → `AsyncStorage.getAllKeys()` 抛错（未包）
//   → 本函数 reject → 调用方（AppContext 启动加载）退回「1 个角色 + 0 会话」的内存快照
//   → 用户点一次编辑/置顶/新增 → saveCharacterLibrary(list) → persistLibrary 用**盘上**索引
//     算 stale（previousIds 仍是完整的 N 个 id）→ 只 stale.delete 掉这 1 个 → multiRemove
//     删掉其余 N-1 个逐角色键 + 索引改写成 [default] + cleanupCharacterPayloadFiles 删掉
//     大卡正文文件 ⇒ 不可逆。
//
// 所以「读失败」与「写闸」必须在**同一个函数里**绑定，而不是指望每个调用方记得自己合闸：
// 调用方有十余处（moments/diary/taskRunner/orphanMedia/workspace…），漏一处就是一次数据
// 丢失。fail-closed 的方向与仓库既有先例一致：
//   - src/storage/worldMap.js:19-40（读失败抛错，绝不返回默认值）；
//   - src/storage/characters/index.js 自身的 persistLibrary catch（写失败 → 置位写闸）。
// 注意本函数的返回**只有**「合法列表」与「抛出」两种；「合法的空库」不是失败
// （ensureDefaultCharacter 会补上初始卡），照常返回并清掉写闸——「真的没有角色」与
// 「读不到」必须区分。
export async function getCharacterLibrary() {
  try {
    return await readCharacterLibrary();
  } catch (error) {
    // 先合闸再抛：顺序不能反。抛出去之后调用方可能已经拿着残缺列表去做写操作，
    // 闸必须在那一刻之前就是合上的。
    setCharacterLibraryWriteBlocked(true);
    // 诊断文本必须**自足**：recordDiagnostic 会先跑 maskSecrets（见 diagnostics.js
    // 的 mask），它可能把「疑似密钥」的片段替换成占位符甚至清空（上面那个
    // `getAllKeys 读取失败` 就被清成了空串，与同窗口内其它 storage 诊断同签名而被去重
    // 丢掉）。所以把「发生了什么」写进 message 本身，而不是只放在 context 里。
    recordDiagnostic(
      'storage',
      new Error('角色库读取失败，已合上写闸（中止保存以免角色库被覆盖）'),
      `getCharacterLibrary：${String((error && error.message) || '')}`
    );
    throw error;
  }
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

// 活动角色指针的三态读取，与 sessionCore.getActiveSessionIdStatus 同构、同理：
// 裸 getItem + JSON.parse + catch 返回 '' 会把「从未设过」与「读不出/结构坏了」合并成
// 同一个 ''，调用方据此改写指针就等于永久改掉用户「上次用的角色」。
// 裁定同 sessionLibrary.shouldPersistResolvedId：ok/missing 且解析结果确实变了才写回，
// corrupt 时保持盘上原值不动。
export async function getActiveCharacterIdStatus() {
  const stored = await readJsonStatus(ACTIVE_CHARACTER_KEY);
  if (stored.status === 'ok') {
    return {
      status: 'ok',
      value: stored.value === null || stored.value === undefined ? '' : String(stored.value),
    };
  }
  return { status: stored.status, value: '' };
}

export async function getActiveCharacterId() {
  const { value } = await getActiveCharacterIdStatus();
  return value;
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

// 角色编辑草稿是**按角色分键**的（@easychat2_character_edit_draft::<id>）：删角色时不清
// 就是永久孤儿（formState 可能不小），而此前它只由两个界面的删除流程顺手清一次——
// 换条删除路径就漏。按「谁的数据谁负责」注册到角色生命周期（见 characterLifecycle.js）。
onCharacterDeleted('characterEditDraft', async characterIds => {
  const ids = (Array.isArray(characterIds) ? characterIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  await Promise.all(ids.map(id => clearCharacterEditDraft(id)));
});
