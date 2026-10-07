// 本地模型存储领域：设置（兼容旧单模型键）+ 多模型按 id 分键存储。
// 模型条目按 id 拆到 LOCAL_MODEL_ITEM_PREFIX 键，轻量索引最后写作为提交点，
// 避免整表 JSON 突破 Android SQLite 单值读取上限（CursorWindow 约 2MB）。
// 旧键 @easychat2_local_model 中的单模型会被迁移成一条条目，并回填 activeModelId。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, readJson, readJsonStatus, readJsonWithSecrets, setJsonWithSecrets } from './io.js';
import {
  LOCAL_MODEL_INDEX_KEY,
  LOCAL_MODEL_ITEM_PREFIX,
  LOCAL_MODEL_SETTINGS_KEY,
  LOCAL_MODEL_SETTINGS_SCHEMA,
  localModelIndexEntry,
  normalizeLocalModelIndexEntry,
  normalizeLocalModelItem,
  normalizeLocalModelSettings,
  migrateLegacyLocalModelSettings,
} from '../localModel/modelState.js';
import { tActive } from '../i18n/index.js';

export function localModelItemKey(id) {
  return `${LOCAL_MODEL_ITEM_PREFIX}::${String(id || '')}`;
}

export async function getLocalModelSettings() {
  // 设置键的 apiServer.apiKey 是密钥：与其他配置一致走保险箱读写，避免明文落盘。
  const raw = await readJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, null);
  const normalized = normalizeLocalModelSettings(raw);
  if (normalized.schema >= LOCAL_MODEL_SETTINGS_SCHEMA) return normalized;
  // 旧结构（无 schema 或 schema<2）：一次性迁移——写条目/索引 + 清空 legacy 字段 +
  // 记 schema:2。迁移后设置键只剩单一事实源字段，读路径不再见 legacy。
  await migrateLegacyLocalModel();
  return normalizeLocalModelSettings(await readJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, null));
}

export async function saveLocalModelSettings(settings) {
  // 写入一律盖 schema:2：调用方传的是已归一化的 v2 设置，此处兜底防止漏盖。
  const normalized = { ...normalizeLocalModelSettings(settings), schema: LOCAL_MODEL_SETTINGS_SCHEMA };
  await setJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, normalized);
  return normalized;
}

// 只读索引键，不做迁移；缺失或结构异常返回 []。
async function readStoredIndexEntries() {
  const stored = await readJsonStatus(LOCAL_MODEL_INDEX_KEY);
  if (stored.status !== 'ok' || !Array.isArray(stored.value)) return [];
  return stored.value.map(normalizeLocalModelIndexEntry).filter(entry => entry.id);
}

async function writeIndexEntries(entries) {
  await AsyncStorage.setItem(LOCAL_MODEL_INDEX_KEY, JSON.stringify(entries));
}

export async function getLocalModelIndex() {
  const stored = await readJsonStatus(LOCAL_MODEL_INDEX_KEY);
  if (stored.status === 'ok' && Array.isArray(stored.value)) {
    return stored.value.map(normalizeLocalModelIndexEntry).filter(entry => entry.id);
  }
  if (stored.status === 'missing') {
    return migrateLegacyLocalModel();
  }
  await backupCorruptValue(LOCAL_MODEL_INDEX_KEY);
  return rebuildLocalModelIndex();
}

// 旧单模型设置一次性迁移成多模型（v5 Stage A）：写条目 + 写索引 + 回填
// activeModelId，并把 legacy 字段清零、盖上 schema:2。此后读路径只见单一事实源。
// 无旧模型时也要落一次 schema:2，避免每次都判定为「待迁移」。
export async function migrateLegacyLocalModel() {
  const legacy = await readJson(LOCAL_MODEL_SETTINGS_KEY, null);
  const { settings, item } = migrateLegacyLocalModelSettings(legacy);
  try {
    if (item) {
      await AsyncStorage.setItem(localModelItemKey(item.id), JSON.stringify(item));
      await writeIndexEntries([localModelIndexEntry(item)]);
    }
    await setJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, { ...settings, schema: LOCAL_MODEL_SETTINGS_SCHEMA });
    return item ? [localModelIndexEntry(item)] : [];
  } catch (error) {
    return [];
  }
}

// 索引损坏时扫出散落的条目键，尽量把模型列表拼回来。
export async function rebuildLocalModelIndex() {
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    return [];
  }
  const entries = [];
  const itemKeys = (Array.isArray(keys) ? keys : [])
    .filter(key => typeof key === 'string' && key.startsWith(`${LOCAL_MODEL_ITEM_PREFIX}::`));
  for (const key of itemKeys) {
    const stored = await readJsonStatus(key);
    if (stored.status === 'ok' && stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value)) {
      const entry = localModelIndexEntry(stored.value);
      if (entry.id) entries.push(entry);
    }
  }
  try {
    await writeIndexEntries(entries);
  } catch (error) {}
  return entries;
}

export async function getLocalModelItem(id) {
  const itemId = String(id || '').trim();
  if (!itemId) return null;
  const stored = await readJsonStatus(localModelItemKey(itemId));
  if (stored.status !== 'ok' || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) {
    return null;
  }
  return normalizeLocalModelItem(stored.value);
}

// 写入条目后写索引（提交点）。任一步失败都回滚，避免「条目在、索引没了」。
export async function saveLocalModelItem(item) {
  const normalized = normalizeLocalModelItem(item);
  if (!normalized.id) throw new Error(tActive('error.storage.modelMissingId'));
  const now = Date.now();
  const next = {
    ...normalized,
    createdAt: normalized.createdAt || now,
    updatedAt: now,
  };
  const key = localModelItemKey(next.id);
  const previousItem = await AsyncStorage.getItem(key).catch(() => null);
  const previousIndex = await AsyncStorage.getItem(LOCAL_MODEL_INDEX_KEY).catch(() => null);
  try {
    await AsyncStorage.setItem(key, JSON.stringify(next));
    const entries = await readStoredIndexEntries();
    const entry = localModelIndexEntry(next);
    const existing = entries.findIndex(current => current.id === entry.id);
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
    await writeIndexEntries(entries);
  } catch (error) {
    if (previousItem === null) await AsyncStorage.removeItem(key).catch(() => {});
    else await AsyncStorage.setItem(key, previousItem).catch(() => {});
    if (previousIndex === null) await AsyncStorage.removeItem(LOCAL_MODEL_INDEX_KEY).catch(() => {});
    else await AsyncStorage.setItem(LOCAL_MODEL_INDEX_KEY, previousIndex).catch(() => {});
    throw error;
  }
  return next;
}

// 删除条目时级联清掉其参数（同一 item 键）；若是当前活动模型则清空指针（需求 4）。
export async function deleteLocalModelItem(id) {
  const itemId = String(id || '').trim();
  if (!itemId) return [];
  const key = localModelItemKey(itemId);
  const previousItem = await AsyncStorage.getItem(key).catch(() => null);
  const previousIndex = await AsyncStorage.getItem(LOCAL_MODEL_INDEX_KEY).catch(() => null);
  let entries = [];
  try {
    await AsyncStorage.removeItem(key);
    entries = (await readStoredIndexEntries()).filter(entry => entry.id !== itemId);
    await writeIndexEntries(entries);
  } catch (error) {
    if (previousItem !== null) await AsyncStorage.setItem(key, previousItem).catch(() => {});
    if (previousIndex !== null) await AsyncStorage.setItem(LOCAL_MODEL_INDEX_KEY, previousIndex).catch(() => {});
    throw error;
  }
  const settings = await getLocalModelSettings();
  if (settings.activeModelId === itemId) {
    await saveLocalModelSettings({ ...settings, activeModelId: '' }).catch(() => {});
  }
  return entries;
}

export async function getActiveLocalModel() {
  const settings = await getLocalModelSettings();
  if (!settings.activeModelId) return null;
  return getLocalModelItem(settings.activeModelId);
}

// ---- 下载队列持久化（v5 Stage B）----
//
// 队列是「任务」而非「表单动作」：任务的进度/取消/重试与任何 UI 生命周期解耦，
// 且活过 app 重启。这里只做键的读写原语，队列语义在 localModel/downloadQueue.js。
export const LOCAL_MODEL_QUEUE_KEY = '@easychat2_download_queue';

export async function readDownloadQueue() {
  const stored = await readJsonStatus(LOCAL_MODEL_QUEUE_KEY);
  if (stored.status !== 'ok' || !Array.isArray(stored.value)) return [];
  return stored.value;
}

export async function writeDownloadQueue(tasks) {
  await AsyncStorage.setItem(LOCAL_MODEL_QUEUE_KEY, JSON.stringify(Array.isArray(tasks) ? tasks : []));
}
