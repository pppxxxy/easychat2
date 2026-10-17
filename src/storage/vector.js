// 向量记忆存储领域：多配置载荷 + 按角色的向量索引 CRUD。从 src/storage.js 原样外提（无行为变化）。
// 注：reconcileVectorIndexes 依赖会话列表读取（readSessionsStatus），暂留在 storage.js barrel，
// 待 sessions 领域抽出后再并入本模块。为此这里导出 readVectorIndexStatus / VECTOR_INDEX_PREFIX。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  assertValueBudget,
  backupCorruptValue,
  createMutationQueue,
  readJsonStatus,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from './io.js';
import { tActive } from '../i18n/index.js';
// provider 默认值只认 providers.js 的目录（唯一真源）：此前这里手抄了一份
// 'openai-embeddings' / 'https://api.openai.com/v1' / 'text-embedding-3-small'，
// 目录一改就悄悄漂移。providers.js 只依赖 i18n（纯 JS），不构成循环依赖。
import { DEFAULT_VECTOR_PROVIDER } from '../vectorMemory/providers.js';
// 上限/默认值同样只有一处定义（limits.js，零依赖）。此前这里手抄了一份 20/2000/64 与
// 5/400/16，与 vectorMemory/index.js 的同一组数字各改各的——设置页夹取用的上限一旦
// 与发请求时用的上限不是同一个数，用户看到的与真正生效的就会不一致。
import {
  VECTOR_BATCH_SIZE_DEFAULT,
  VECTOR_BATCH_SIZE_MAX,
  VECTOR_MAX_CHARS_DEFAULT,
  VECTOR_MAX_CHARS_MAX,
  VECTOR_TOP_K_DEFAULT,
  VECTOR_TOP_K_MAX,
} from '../vectorMemory/limits.js';

const VECTOR_MEMORY_KEY = '@easychat2_vector_memory';
const VECTOR_MEMORY_CONFIGS_KEY = '@easychat2_vector_memory_configs';
export const VECTOR_INDEX_PREFIX = '@easychat2_vector_index';

const vectorIndexMutation = createMutationQueue();

function normalizeVectorMemoryConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const topK = Math.trunc(Number(source.topK));
  const maxChars = Math.trunc(Number(source.maxChars));
  const batchSize = Math.trunc(Number(source.batchSize));
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    enabled: source.enabled === true,
    providerId: String(source.providerId || DEFAULT_VECTOR_PROVIDER.id),
    // 空地址/空模型必须原样落盘，**不得**回填 provider 默认值：此前这里手抄了
    // api.openai.com 与 text-embedding-3-small 两份兜底，用户清空「接口地址」后 500ms
    // 防抖落盘即被回填，回读又把地址灌回输入框（useVectorSettings 的 setVectorPayload），
    // 输入框「自己长回地址」；随后生成时聊天正文与别家 Key 被发往用户从未配置的第三方。
    // 向量 provider 在 UI 上不可选，兜底等于替用户凭空指定目的地——缺失交由
    // embedTexts 的原始值守卫报 error.vectorMemory.baseUrlRequired。
    baseUrl: String(source.baseUrl || ''),
    apiKey: String(source.apiKey || ''),
    model: String(source.model || ''),
    topK: Number.isFinite(topK) && topK > 0 ? Math.min(VECTOR_TOP_K_MAX, topK) : VECTOR_TOP_K_DEFAULT,
    maxChars: Number.isFinite(maxChars) && maxChars > 0
      ? Math.min(VECTOR_MAX_CHARS_MAX, maxChars)
      : VECTOR_MAX_CHARS_DEFAULT,
    batchSize: Number.isFinite(batchSize) && batchSize > 0
      ? Math.min(VECTOR_BATCH_SIZE_MAX, batchSize)
      : VECTOR_BATCH_SIZE_DEFAULT,
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
  // 损坏时先备份原始值再按缺失处理：否则下次保存会把损坏配置静默覆盖成默认（apiKey 丢失无副本）。
  const storedStatus = await readJsonStatusWithSecrets(VECTOR_MEMORY_CONFIGS_KEY);
  if (storedStatus.status === 'corrupt') await backupCorruptValue(VECTOR_MEMORY_CONFIGS_KEY);
  const stored = storedStatus.status === 'ok' ? storedStatus.value : null;
  if (stored) return normalizeVectorMemoryPayload(stored);
  // 旧单配置键：迁移前可能是明文，也走 hydrate 以防已转引用。
  const legacyStatus = await readJsonStatusWithSecrets(VECTOR_MEMORY_KEY);
  if (legacyStatus.status === 'corrupt') await backupCorruptValue(VECTOR_MEMORY_KEY);
  const legacy = legacyStatus.status === 'ok' ? legacyStatus.value : null;
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

// 空 id 不落任何桶：'default' 是内置 EasyChat2 助手的角色 id，用它兜底会让无归属的
// 分段沉淀进助手的桶（助手会话就能召回别人的记忆）。空 id 一律拒绝读写。
function vectorIndexKey(characterId) {
  const id = String(characterId || '').trim();
  return id ? `${VECTOR_INDEX_PREFIX}::${id}` : '';
}

function enqueueVectorIndexMutation(characterId, task) {
  // 按角色分桶：不同角色的向量索引写入互不阻塞，同一角色串行。
  return vectorIndexMutation.enqueue(task, vectorIndexKey(characterId) || 'vector:no-owner');
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
      // 溯源字段（记忆溯源）：普通记忆由某条消息切出，来源就是 messageId；
      // AI 合并出来的记忆（origin='merged'）来源的两条原文已被删除，只能靠
      // mergedFrom 快照留证，否则证据链会随合并一起断掉。
      origin: item.origin === 'merged' ? 'merged' : 'message',
      mergedFrom: Array.isArray(item.mergedFrom)
        ? item.mergedFrom
          .filter(entry => entry && entry.id)
          .map(entry => ({
            id: String(entry.id),
            sessionId: String(entry.sessionId || ''),
            messageId: String(entry.messageId || ''),
            text: String(entry.text || ''),
            at: Number(entry.at) || 0,
          }))
        : [],
    }));
}

function vectorSegmentKey(item) {
  return `${String(item && item.sessionId || '')}\u0000${String(item && item.id || '')}`;
}

export async function readVectorIndexStatus(characterId) {
  const key = vectorIndexKey(characterId);
  if (!key) return { status: 'missing', index: [] };
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
  const key = vectorIndexKey(characterId);
  const list = normalizeVectorIndex(index);
  if (!key) return list; // 空 id：不写盘（上层 getVectorOwnerId 已守卫，这里是纵深防御）
  const json = JSON.stringify(list);
  // 整条索引（含每条记忆的 embedding 向量）塞在**单键**里，是最容易越过单值预算的写入点：
  // 越过之后 Android 的 getItem 会直接抛错，只能靠 SQLite 分块兜底读回。
  // 这里只留痕不改行为（见 io.js assertValueBudget）。
  assertValueBudget(key, json);
  await AsyncStorage.setItem(key, json);
  return list;
}

export function saveVectorIndex(characterId, index) {
  if (!vectorIndexKey(characterId)) return Promise.resolve([]);
  return enqueueVectorIndexMutation(characterId, async () => {
    const status = await readVectorIndexStatus(characterId);
    if (status.status === 'corrupt') {
      throw new Error(tActive('error.storage.vectorIndexReadFailed'));
    }
    const byKey = new Map(status.index.map(item => [vectorSegmentKey(item), item]));
    normalizeVectorIndex(index).forEach(item => byKey.set(vectorSegmentKey(item), item));
    return saveVectorIndexInternal(characterId, [...byKey.values()]);
  });
}

export function updateVectorIndex(characterId, updater) {
  const key = vectorIndexKey(characterId);
  if (!key) return Promise.resolve([]);
  return enqueueVectorIndexMutation(characterId, async () => {
    const status = await readVectorIndexStatus(characterId);
    if (status.status === 'corrupt') {
      throw new Error(tActive('error.storage.vectorIndexReadFailed'));
    }
    const next = typeof updater === 'function' ? await updater(status.index) : status.index;
    if (next === undefined) return status.index;
    if (next === null) {
      await AsyncStorage.removeItem(key);
      return [];
    }
    // 无变化就不写。**契约**：updater 没改动内容时必须**原样返回同一个数组引用**
    // （indexMessages 在「没有新分段可嵌入」/开关关闭时正是 return current；本文件里
    // removeVectorIndexFor* 在 ids 为空时也 return current；vectorReconcile 走的是
    // 「无变化返回 undefined」那条）。
    //
    // 为什么必须加这一条：整条索引（含每条记忆的 embedding）挤在**单键**里，
    // saveVectorIndexInternal 的 normalizeVectorIndex + JSON.stringify 是 O(条数×维度)。
    // 实测（Node 基准，1024 维）：1000 条 → 单键 JSON 约 19.8 MB，stringify 145ms、
    // parse 71ms、两遍 normalize 33ms；3000 条 → 59.4 MB、stringify 444ms。此前
    // **每次会话落盘都会**把这份几 MB～几十 MB 的 JSON 重新规整、序列化并整键写回，
    // 哪怕内容一个字节都没变（向量记忆关闭时也照写，因为 indexMessages 会原样返回
    // current 而被当成「新内容」）。取消这次写入后，同一条路径只剩读盘成本。
    if (next === status.index) return status.index;
    return saveVectorIndexInternal(characterId, next);
  });
}

// 清掉一条记忆里「来源已被删除」的 mergedFrom 快照，并决定这条记忆的去留。
//
// 为什么必须清：合并记忆（origin='merged'）把**被合并的原文**整段抄进了
// mergedFrom[].text（写入见 memory/MemoryProvenanceModal.js 的合并分支，读出并展示见
// memory/provenance.js:64-75 的 memorySources）。它的 item.messageId 是 ''（合并记忆没有
// 单条来源消息），所以按 messageId 过滤的删除路径**永远命中不了它**——用户删掉消息后，
// 被删的原文仍然留在盘上，并且还能在溯源面板里全文读到（P1-6b）。
// 删除语义见 evidence.deleteConfirm.body「原始对话消息不受影响」：反向同样成立——
// 删了消息，记忆里那份原文快照也必须一起走。
// 返回 [] = 整条退休；没有命中任何快照（含没有 mergedFrom 的普通记忆/脏数据）时
// **原样返回同一个对象**，绝不因为「过滤了一次」就重写条目。
function pruneMergedSources(item, hitSource) {
  const merged = Array.isArray(item.mergedFrom) ? item.mergedFrom : [];
  const kept = merged.filter(entry => !hitSource(entry));
  if (kept.length === merged.length) return [item];
  // 全部来源都被删：这条合并记忆已没有任何可溯源的原文，整条退休——与普通记忆
  // 「消息没了，记忆也没了」同一处置。否则会留下一条只有结论、没有任何来源的记忆，
  // 而它的正文恰恰是从被删消息合并出来的。
  return kept.length === 0 ? [] : [{ ...item, mergedFrom: kept }];
}

export function removeVectorIndexForMessages(characterId, sessionId, messageIds) {
  const targetSession = String(sessionId || '');
  const ids = new Set(
    (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  // 命中判据：会话与消息 id 同时对上（跨会话同 id 不是同一条消息，不能误删）。
  const hit = (entrySession, entryMessage) => (
    String(entrySession || '') === targetSession && ids.has(String(entryMessage || ''))
  );
  return updateVectorIndex(characterId, current => (
    ids.size === 0 ? current : current
      .filter(item => !hit(item.sessionId, item.messageId))
      .flatMap(item => pruneMergedSources(item, entry => hit(entry.sessionId, entry.messageId)))
  ));
}

export function removeVectorIndexForMessage(characterId, sessionId, messageId) {
  return removeVectorIndexForMessages(characterId, sessionId, [messageId]);
}

// 按会话整段清索引。
//
// ⚠️ 本函数有**两种调用语义**，二者在调用点长得一模一样（都只传 characterId + sessionId），
// 存储层无法自己分辨，所以清理 mergedFrom 快照这件事必须由调用方**显式选择**：
//
//  ① 归档 / 切换分支 / 重生成 / 修改重发 / 整段清空（useChatSend.js:1789、
//     useChatSend.js:1895、ChatScreen.js:1267、ChatScreen.js:1442）——消息被**归档成分支**
//     （storage/sessionBranches.js 的 archiveBranch），随时可以 checkout 回来
//     （ChatScreen.js:1215 的 onCheckoutBranch 把分支正文重新拼回活动时间线）。这里清索引
//     只是为了「按活动时间线整段重建」，**不是删除**：归档中的消息仍是可召回的有效证据，
//     其 mergedFrom 快照**必须原样保留**。
//     ⚠️ ChatScreen.js:1442（「全选 + 删除」清空整会话）**属于本类**，不是真删除：同一条
//     路径在 ChatScreen.js:1431 先 `archiveBranch(sessionId, tailPlan.forkMessageId,
//     tailPlan.tail)` 把被删的整段尾段归档成分支，消息**可以召回** ⇒ 不传 options 是对的。
//  ② 真删除（sessionList/mutations.js 的 deleteSessionInternal / deleteSessionsInternal）
//     ——这两个函数随后都会 deleteAllBranchesInternal(sessionId) 把归档分支一并清掉，
//     消息**再也回不来**，此时按会话清掉 mergedFrom 快照才与 removeVectorIndexForMessages
//     的删除语义一致（P1-6b：删了消息，记忆里那份原文快照也必须一起走）。
//
// 因此默认 **不清快照**（= 语义 ①，与既有行为逐字节一致），语义 ② 的调用点必须显式传
// { pruneSources: true }。绝不能让本函数一律清：那会把「归档」当成「删除」，误删仍然有效
// 的证据链（这正是上一批刻意没修的理由）。
export function removeVectorIndexForSessions(characterId, sessionIds, options = {}) {
  const ids = new Set(
    (Array.isArray(sessionIds) ? sessionIds : [sessionIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  const pruneSources = options && options.pruneSources === true;
  // 命中判据只有会话：整会话都没了，它名下所有消息（不分 messageId）都不再存在。
  const hit = entrySession => ids.has(String(entrySession || ''));
  return updateVectorIndex(characterId, current => {
    if (ids.size === 0) return current;
    const kept = current.filter(item => !hit(item.sessionId));
    if (!pruneSources) return kept;
    return kept.flatMap(item => pruneMergedSources(item, entry => hit(entry.sessionId)));
  });
}

export function removeVectorIndexForSession(characterId, sessionId, options = {}) {
  return removeVectorIndexForSessions(characterId, [sessionId], options);
}

export function clearVectorIndex(characterId) {
  const key = vectorIndexKey(characterId);
  if (!key) return Promise.resolve();
  return enqueueVectorIndexMutation(characterId, () => AsyncStorage.removeItem(key));
}
