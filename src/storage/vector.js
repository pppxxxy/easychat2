// 向量记忆存储领域：多配置载荷 + 按角色的向量索引 CRUD。从 src/storage.js 原样外提（无行为变化）。
// 注：reconcileVectorIndexes 依赖会话列表读取（readSessionsStatus），暂留在 storage.js barrel，
// 待 sessions 领域抽出后再并入本模块。为此这里导出 readVectorIndexStatus / VECTOR_INDEX_PREFIX。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  backupCorruptValue,
  readJsonStatus,
  readJsonWithSecrets,
  setJsonWithSecrets,
} from './io.js';

const VECTOR_MEMORY_KEY = '@easychat2_vector_memory';
const VECTOR_MEMORY_CONFIGS_KEY = '@easychat2_vector_memory_configs';
export const VECTOR_INDEX_PREFIX = '@easychat2_vector_index';

const vectorIndexWriteQueues = new Map();

function normalizeVectorMemoryConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const topK = Math.trunc(Number(source.topK));
  const maxChars = Math.trunc(Number(source.maxChars));
  const batchSize = Math.trunc(Number(source.batchSize));
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
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

function makeVectorConfigId() {
  return `vec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 把任意读到的向量配置 payload 规整成 { enabled, configs, activeId }。
// 兼容三种历史形态：旧的单配置对象（含 enabled/地址/密钥）、带 configs 数组的新结构、空值。
// 旧单配置迁移为第一条，保留 enabled 与字段，避免老用户升级后设置丢失。
function normalizeVectorMemoryPayload(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.configs)) {
    const configs = raw.configs.map(item => normalizeVectorMemoryConfig(item));
    const list = configs.length ? configs : [defaultVectorConfig()];
    const activeId = list.some(item => item.id === raw.activeId) ? String(raw.activeId) : list[0].id;
    return { enabled: raw.enabled === true, configs: list, activeId };
  }
  const legacy = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const migrated = normalizeVectorMemoryConfig({ ...legacy, id: legacy.id || 'default', name: legacy.name || '默认向量配置' });
  return { enabled: legacy.enabled === true, configs: [migrated], activeId: migrated.id };
}

function defaultVectorConfig() {
  return normalizeVectorMemoryConfig({ id: 'default', name: '默认向量配置' });
}

// 兼容旧调用：返回「当前激活」的向量配置（含 enabled），供 ChatScreen / 向量检索直接使用。
// 读不到 configs 结构时回退旧的单配置键，保证升级后行为不变。
export async function getVectorMemoryConfig() {
  const payload = await readVectorMemoryPayload();
  const active = payload.configs.find(item => item.id === payload.activeId) || payload.configs[0];
  return { ...active, enabled: payload.enabled === true };
}

// 兼容旧调用：把整条配置写回（按 id 匹配或追加），并同步 enabled，保留其余配置。
export async function saveVectorMemoryConfig(config) {
  const normalized = normalizeVectorMemoryConfig(config);
  const payload = await readVectorMemoryPayload();
  const exists = payload.configs.some(item => item.id === normalized.id);
  const configs = exists
    ? payload.configs.map(item => (item.id === normalized.id ? normalized : item))
    : [...payload.configs, normalized];
  return saveVectorMemorySettings({
    enabled: normalized.enabled === true,
    configs,
    activeId: payload.activeId,
  });
}

// 读取完整多配置载荷（设置页用）。
async function readVectorMemoryPayload() {
  const stored = await readJsonWithSecrets(VECTOR_MEMORY_CONFIGS_KEY, null);
  if (stored) return normalizeVectorMemoryPayload(stored);
  // 旧单配置键：迁移前可能是明文，也走 hydrate 以防已转引用。
  const legacy = await readJsonWithSecrets(VECTOR_MEMORY_KEY, null);
  return normalizeVectorMemoryPayload(legacy);
}

export async function getVectorMemorySettings() {
  const payload = await readVectorMemoryPayload();
  return payload;
}

// 保存完整多配置载荷：{ enabled, configs, activeId }。
export async function saveVectorMemorySettings(payload) {
  const normalized = normalizeVectorMemoryPayload(payload);
  await setJsonWithSecrets(VECTOR_MEMORY_CONFIGS_KEY, normalized);
  return normalized;
}

export function createVectorConfig(partial = {}) {
  return normalizeVectorMemoryConfig({ id: makeVectorConfigId(), name: '新建向量配置', ...partial });
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
      signature: String(item.signature || ''),
    }));
}

function vectorSegmentKey(item) {
  return `${String(item && item.sessionId || '')}\u0000${String(item && item.id || '')}`;
}

export async function readVectorIndexStatus(characterId) {
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
    const byKey = new Map(status.index.map(item => [vectorSegmentKey(item), item]));
    normalizeVectorIndex(index).forEach(item => byKey.set(vectorSegmentKey(item), item));
    return saveVectorIndexInternal(characterId, [...byKey.values()]);
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

export function clearVectorIndex(characterId) {
  return enqueueVectorIndexMutation(
    characterId,
    () => AsyncStorage.removeItem(vectorIndexKey(characterId))
  );
}