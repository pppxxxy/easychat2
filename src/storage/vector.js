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
// 删除失败必须留痕（L2/M3：分片里是整份 embedding，静默失败 = 隐私残留）。
import { recordDiagnostic } from './diagnostics.js';
// 分片与紧凑编码（纯函数，零原生依赖）：把 embedding 从「单个几十 MB 的 JSON 键」里拆出来。
// 见 vectorCodec.js 的文件头——那里的实测数字解释了为什么必须拆。
import {
  VECTOR_SHARD_COUNT,
  VECTOR_SHARD_PREFIX,
  decodeVector,
  encodeVector,
  parseVectorShardKey,
  vectorShardIndex,
  vectorShardKey,
} from './vectorCodec.js';
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

function normalizeVectorEntry(item) {
  // 刻意**不复制**向量数组（此前是 item.vector.map(Number)）：
  // ① 向量数组的引用就是分片缓存的新鲜度判据——写入侧用它判断「这一条的向量是否已存在
  //    片里」（见 planShardWrites）。map(Number) 每次都造新数组，引用比较永远不等，
  //    结果是每次写入都重写全部分片（实测 26/26 片，分片等于白分）。
  // ② 读路径上它还会把整份向量再复制一遍（1000 条 × 1024 维 = 一份多余的大数组）。
  // 值本身已经是数字：来自 decodeVector（Float32 → number）或 embedTexts 的 JSON 数字。
  // 安全性：全仓没有一处就地修改 item.vector（无 .vector[i] = / push / splice / sort）。
  const vector = Array.isArray(item.vector) ? item.vector : [];
  const storedDim = Math.floor(Number(item.dim));
  return {
    id: String(item.id),
    messageId: String(item.messageId || ''),
    sessionId: String(item.sessionId || ''),
    role: String(item.role || ''),
    at: Number(item.at) || 0,
    text: String(item.text),
    vector,
    // dim = 「这一条应该有多少维」。分片布局下元数据里**不再内联向量**，只留 dim：
    // ① 判断要不要去分片取（dim > 0 且内存里没有向量）；
    // ② 让「这条到底嵌过没有」不必碰分片就能回答（写入侧据此决定要不要重新嵌入）。
    // 内联向量（旧布局 / 刚从分片读回）存在时以实际长度为准——那是唯一真源。
    dim: vector.length > 0
      ? vector.length
      : (Number.isFinite(storedDim) && storedDim > 0 ? storedDim : 0),
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
  };
}

function normalizeVectorIndex(index) {
  return (Array.isArray(index) ? index : [])
    .filter(item => item && item.id && typeof item.text === 'string')
    .map(normalizeVectorEntry);
}

function vectorSegmentKey(item) {
  return `${String(item && item.sessionId || '')}\u0000${String(item && item.id || '')}`;
}

// 分片载荷的形状：{ [分段键]: base64 }。读到任何别的形状（数组 / 原语 / 坏值）都当空片——
// 缺向量的分段会被重新嵌入（写入侧的 emptyVectors 判据），属于自愈，不是静默丢数据。
function shardPayloadOf(stored) {
  if (stored.status !== 'ok') return {};
  const value = stored.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

// 把存在分片里的向量按需取回，拼成调用方熟悉的形状（每条都带 vector）。
async function fillVectorsFromShards(characterId, meta) {
  const neededShards = new Set();
  for (const item of meta) {
    if (item.dim > 0 && item.vector.length === 0) {
      neededShards.add(vectorShardIndex(vectorSegmentKey(item)));
    }
  }
  if (neededShards.size === 0) return meta;
  const loaded = new Map();
  await Promise.all([...neededShards].map(async shard => {
    const shardKey = vectorShardKey(characterId, shard);
    const stored = await readJsonStatus(shardKey);
    // 坏片先备份再当空片：backupCorruptValue 自己会留一条诊断（io.js:202），
    // 所以这里不必再记一遍。丢掉的向量会被重新嵌入。
    if (stored.status === 'corrupt') {
      await backupCorruptValue(shardKey);
      loaded.set(shard, {});
      return;
    }
    loaded.set(shard, shardPayloadOf(stored));
  }));
  return meta.map(item => {
    if (item.dim <= 0 || item.vector.length > 0) return item;
    const payload = loaded.get(vectorShardIndex(vectorSegmentKey(item)));
    const vector = decodeVector(payload ? payload[vectorSegmentKey(item)] : '');
    if (vector.length === 0) return item;
    // 维度口径校验（L4/L5）：解码出来的长度必须与元数据声明的 dim 一致。
    //
    // 为什么必须校验：分片里的 base64 若被**截断**（JSON 仍然合法、只是串变短），
    // decodeVector 会安静地解出**更少**的浮点数。此前这里直接 `{ ...item, vector }`，
    // 于是：
    //   · normalizeVectorEntry 把 dim 改写成那个错误长度（元数据的 dim 被静默覆盖）；
    //   · 检索侧 cosineSimilarity 见维度不等就返回 0（vectorMemory/index.js:201），
    //     该条被 threshold 过滤掉 —— 这条记忆**永久搜不到**，而且没有任何提示。
    // 更糟的是它不会自愈：indexMessages 的重新嵌入判据是
    // 「无向量 / 空向量 / signature 变化」，而这条有向量、signature 也没变。
    //
    // 处置：**当作没取到**（保持 vector 为空）并留痕。空向量会被 indexMessages 认成
    // 「需要重新嵌入」⇒ 下一条消息落盘时它就被修复，是真正的自愈而不是掩盖。
    if (vector.length !== item.dim) {
      recordDiagnostic(
        'storage',
        new Error(tActive('error.storage.vectorDimMismatch')),
        `${characterId}：${vectorSegmentKey(item)} 实际 ${vector.length} 维 != 元数据 ${item.dim} 维（该片可能已截断）`
      );
      return item;
    }
    return { ...item, vector };
  });
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
  // 旧布局判定（升级迁移用）：只要有一条**内联着向量**，这份元数据就是分片化之前写的。
  // 写入侧必须知道这件事——旧布局下「按引用判断没变化」会把向量丢在元数据里，
  // 而元数据即将被改写成不含向量的形状（那批向量就再也没有地方存了）。见 planShardWrites。
  const inlineVectors = (Array.isArray(stored.value) ? stored.value : [])
    .some(item => item && Array.isArray(item.vector) && item.vector.length > 0);
  const index = await fillVectorsFromShards(characterId, normalizeVectorIndex(stored.value));
  return { status: 'ok', index, inlineVectors };
}

export async function getVectorIndexStatus(characterId) {
  return readVectorIndexStatus(characterId);
}

export async function getVectorIndex(characterId) {
  const { index } = await readVectorIndexStatus(characterId);
  return index;
}

// 删除某个角色的全部分片键。分片数固定，所以这里是确定性循环——不需要 getAllKeys
// （那条路要枚举整库的键，代价远大于 32 次 removeItem）。
//
// 失败**不再吞掉**（L2）：此前每个 removeItem 都 `.catch(() => {})`，于是「清空记忆」
// 可能一个分片都没删掉、调用方却拿到成功的返回值。分片里是整份 embedding（可还原语义），
// 静默失败等于「用户以为删了，其实还在」。现在把失败收集起来交给调用方决定——
// 删除是幂等的，失败后重试即可，所以这里抛错比假装成功安全得多。
async function removeAllVectorShards(characterId) {
  const keys = [];
  for (let shard = 0; shard < VECTOR_SHARD_COUNT; shard += 1) {
    const shardKey = vectorShardKey(characterId, shard);
    if (shardKey) keys.push(shardKey);
  }
  const failures = [];
  await Promise.all(keys.map(async shardKey => {
    try {
      await AsyncStorage.removeItem(shardKey);
    } catch (error) {
      failures.push({ shardKey, error });
    }
  }));
  if (failures.length > 0) {
    recordDiagnostic(
      'storage',
      new Error(tActive('error.storage.vectorShardClearFailed')),
      `${characterId}：${failures.length}/${keys.length} 片删除失败，首条=${String((failures[0].error && failures[0].error.message) || '')}`
    );
    throw new Error(tActive('error.storage.vectorShardClearFailed'));
  }
}

// ── M3：孤儿分片扫描 ────────────────────────────────────────────────────────
//
// 分片键此前**不在任何扫描范围内**：
//   · 快速导出按前缀白名单挑键（dataBackup.js），分片键不在其中 ⇒ 备份里没有向量
//     （这本身是合理的：向量可重建），但**也意味着导出无法带走它们**；
//   · 向量对账只扫 `@easychat2_vector_index::` 元数据键 ⇒ 分片完全不在视野内。
// 于是「清空向量记忆 / 删角色」若中途失败（或历史版本吞错），分片会永久留在盘上。
// 用户以为记忆已删干净，而整份 embedding 仍在——这是**隐私残留**，不是垃圾数据。
//
// 这里补上「按前缀枚举全部孤儿分片」的能力：某角色的元数据键不存在 ⇒ 它的分片全是孤儿。
// 只读，不删；删除由调用方（对账 / 清空）显式决定，便于测试与审计。
//
// 为什么用 getAllKeys 而不是 32×N 次探测：孤儿分片的 characterId 是**未知集合**
// （角色可能已被删除，我们不知道要探测谁），只能枚举。
export async function listOrphanVectorShards() {
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    recordDiagnostic('storage', error, 'listOrphanVectorShards：枚举键失败');
    throw new Error(tActive('error.storage.vectorIndexListReadFailed'));
  }
  const prefix = `${VECTOR_SHARD_PREFIX}::`;
  const shardKeys = (Array.isArray(keys) ? keys : [])
    .filter(key => typeof key === 'string' && key.startsWith(prefix));
  if (shardKeys.length === 0) return { orphans: [], scanned: 0 };

  // 按角色分组：同一角色的元数据键只需查一次（否则 N 片 = N 次元数据读）。
  const byCharacter = new Map();
  for (const shardKey of shardKeys) {
    const parsed = parseVectorShardKey(shardKey);
    // 认不出的键（形状不符/片号越界）**不猜**：留着不动，但单独报出来，
    // 免得它变成「谁也看不见」的静默残留。
    if (!parsed) continue;
    if (!byCharacter.has(parsed.characterId)) byCharacter.set(parsed.characterId, []);
    byCharacter.get(parsed.characterId).push(shardKey);
  }
  const orphans = [];
  const unknownKeys = shardKeys.filter(key => !parseVectorShardKey(key));
  for (const [characterId, shardKeysOfCharacter] of byCharacter) {
    let hasMetadata = false;
    try {
      const status = await readJsonStatus(vectorIndexKey(characterId));
      // 元数据存在（ok/corrupt 都算存在）：分片有归属，不是孤儿。
      // corrupt 时也不能当孤儿删——那会把「元数据读坏了」变成「向量全丢」。
      hasMetadata = status.status !== 'missing';
    } catch (error) {
      hasMetadata = true; // 读失败：保守当作存在，绝不误删
    }
    if (!hasMetadata) orphans.push(...shardKeysOfCharacter);
  }
  return { orphans, scanned: shardKeys.length, unknownKeys };
}

// 清掉全部孤儿分片（某角色元数据已不存在，但分片还在）。返回 { removed, failed }。
// 删除失败**要报出来**（同 removeAllVectorShards 的理由：这是隐私残留）。
export async function purgeOrphanVectorShards() {
  const { orphans } = await listOrphanVectorShards();
  if (orphans.length === 0) return { removed: 0, failed: 0 };
  let removed = 0;
  const failures = [];
  await Promise.all(orphans.map(async shardKey => {
    try {
      await AsyncStorage.removeItem(shardKey);
      removed += 1;
    } catch (error) {
      failures.push(shardKey);
    }
  }));
  if (failures.length > 0) {
    recordDiagnostic(
      'storage',
      new Error(tActive('error.storage.vectorShardClearFailed')),
      `purgeOrphanVectorShards：${failures.length}/${orphans.length} 片失败`
    );
  }
  return { removed, failed: failures.length };
}

// 增量写入计划：算出「哪几片要重写」以及「每片里哪些分段要更新 / 删除」。
//
// previous 是**刚读出来的上一份索引**（含向量），previousInline 表示那份还是旧布局。
// 「向量没变」的判据是**向量数组的引用相等**：normalizeVectorEntry 刻意不复制向量数组，
// 而 indexMessages 对未改动的分段原样返回同一个对象（vectorMemory/index.js:356 的
// `embeddedById.get(key) || item`）、pruneMergedSources 是 `{ ...item }`（数组仍是同一个
// 引用）。所以引用相等 ⇒ 片里那份还是对的 ⇒ 这一片不必重写。
//
// 注意 previous 必须用**原始**数组（不能先 normalize）：normalize 会为每条造新对象，
// 拿它做基准就永远比不出「没变」。
//
// previousInline 为真时**所有**带向量的分段都必须落片：旧布局的向量内联在元数据里，
// 而元数据这次会被改写成不含向量的形状——不落片那些向量就再没有地方存了（等于丢数据）。
function planShardWrites(list, previous, previousInline) {
  const prevByKey = new Map();
  for (const item of (Array.isArray(previous) ? previous : [])) {
    if (!item) continue;
    if (!Array.isArray(item.vector) || item.vector.length === 0) continue;
    prevByKey.set(vectorSegmentKey(item), item);
  }
  const upserts = new Map();
  const add = (shard, segKey, value) => {
    if (!upserts.has(shard)) upserts.set(shard, new Map());
    upserts.get(shard).set(segKey, value);
  };
  const nextWithVector = new Set();
  for (const item of list) {
    const segKey = vectorSegmentKey(item);
    if (item.vector.length === 0) continue;
    nextWithVector.add(segKey);
    const before = prevByKey.get(segKey);
    const unchanged = !previousInline && before && before.vector === item.vector;
    if (unchanged) continue;
    add(vectorShardIndex(segKey), segKey, item.vector);
  }
  // 上一份里有、这一份里已经没有向量的分段：必须从片里删掉。否则片只增不减，
  // 而且分段键是「会话 + 消息 id」——消息重新生成时 id 可能复用，残留的旧向量会被
  // 当成新分段的向量读出来（张冠李戴）。
  for (const [segKey] of prevByKey) {
    if (nextWithVector.has(segKey)) continue;
    add(vectorShardIndex(segKey), segKey, null);
  }
  return upserts;
}

async function saveVectorIndexInternal(characterId, index, previousState = null) {
  const key = vectorIndexKey(characterId);
  const list = normalizeVectorIndex(index);
  if (!key) return list; // 空 id：不写盘（上层 getVectorOwnerId 已守卫，这里是纵深防御）
  const previous = previousState && Array.isArray(previousState.index) ? previousState.index : [];
  const previousInline = !!(previousState && previousState.inlineVectors === true);
  const plan = planShardWrites(list, previous, previousInline);

  // 顺序是硬约束：**先写分片，最后写元数据**。元数据是权威索引（谁存在、多少维），
  // 分片只是它的附属数据。反过来先写元数据的话，中间被杀就会出现「元数据说有向量、
  // 分片里还没有」的窗口——那一段会永久缺向量（虽然下次会被重新嵌入，但要白付一次
  // 嵌入调用）。
  //
  // ⚠️ 旧注释在这里写的是「最坏只是留下一片没人引用的多余分片，下次写入即清掉」——
  // **后半句不成立**（L1）：写入只重写 plan 里那几片，从不去扫「没人引用的片」。
  // 真正的后果是孤儿分片**永久留在盘上**，而这正是 M3 要处理的问题（见
  // listOrphanVectorShards / purgeOrphanVectorShards）。顺序本身仍然正确：宁可留下
  // 孤儿分片（可扫描清理），也不要出现「元数据说有、分片没有」（不可恢复）。
  for (const [shard, updates] of plan) {
    const shardKey = vectorShardKey(characterId, shard);
    if (!shardKey) continue;
    // 片内是 {分段键: base64}，所以是读-改-写：只覆盖本次变化的那几条，
    // 同一片里其它分段的向量必须原样保留。
    const current = { ...shardPayloadOf(await readJsonStatus(shardKey)) };
    for (const [segKey, vector] of updates) {
      if (vector === null) delete current[segKey];
      else current[segKey] = encodeVector(vector);
    }
    if (Object.keys(current).length === 0) {
      await AsyncStorage.removeItem(shardKey);
    } else {
      // L3：分片写入也必须过预算校验。
      // 此前只有元数据调 assertValueBudget，分片**从来没有**——而分片才是真正装
      // 向量的地方（一条 1024 维 ≈ 5.5KB base64）。一片越过 1.5MB 预算时，
      // 越界写入在 Android 上会撞 CursorWindow 上限，症状是「读不出」而不是「写不进」，
      // 极难定位。这里补上留痕：分片超预算 = 该调大 VECTOR_SHARD_COUNT 或调小批量。
      const shardJson = JSON.stringify(current);
      assertValueBudget(shardKey, shardJson);
      await AsyncStorage.setItem(shardKey, shardJson);
    }
  }

  // 元数据：只留 dim（= 这一条应有多少维），不再内联向量本体。
  // 这样这个键的大小只与**条数**有关（每条约 130 字节文本），与维度无关：
  // 1000 条约 130KB（此前含向量是 19.8MB），不再越过单值预算与 CursorWindow 上限。
  const meta = list.map(item => {
    const { vector, ...rest } = item;
    return rest;
  });
  const json = JSON.stringify(meta);
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
    // 把刚读到的那一份作为「上一份」传下去：写入侧据此判断哪些分段的向量真的变了
    // （引用相等即未变），只重写涉及到的分片。inlineVectors 一并传：旧布局必须全量落片。
    return saveVectorIndexInternal(characterId, [...byKey.values()], status);
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
      // 整条清掉：元数据键与**所有**分片键都要走，否则片会永远留在盘上
      // （清空索引的语义是「这个角色不再有记忆」，不是「元数据看不见了」）。
      await AsyncStorage.removeItem(key);
      await removeAllVectorShards(characterId);
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
    // S2：上面那条契约是**隐式**的——它靠「上游记得原样返回同一引用」维持。一旦上游
    // 改成 `return [...current]` / `current.map(...)` / 深拷贝，行为就静默降级：
    // 轻则每次落盘白付一次 O(条数×维度) 序列化（性能悄悄退化，无任何报错），
    // 重则在内容没变时把整条索引重写一遍。反方向更隐蔽：上游**真改了内容却复用旧引用**
    // ⇒ 这里判「无变化」直接 return，改动**不落盘**。
    //
    // 护栏：引用不同但深比较相等 ⇒ 说明上游在做无意义的复制。**正确性优先**——照常
    // 按「有变化」写盘（绝不因优化丢改动），但留一条诊断让退化可见。
    if (isDeepEqualIndex(next, status.index)) {
      recordDiagnostic(
        'storage',
        new Error(tActive('error.storage.vectorIndexReferenceContract')),
        `${characterId}：updater 返回了新引用但内容未变（应原样返回 current）`
      );
    }
    return saveVectorIndexInternal(characterId, next, status);
  });
}

// 索引深比较：**只用于诊断护栏**（判断「引用不同但内容等价」），不参与写入决策。
// 刻意保守：任何不确定都返回 false（＝当作有变化）。漏报一次退化只是少一条诊断，
// 而误判成「无变化」会丢改动——两者代价不对等。
function isDeepEqualIndex(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (vectorSegmentKey(left) !== vectorSegmentKey(right)) return false;
    const lv = Array.isArray(left.vector) ? left.vector : [];
    const rv = Array.isArray(right.vector) ? right.vector : [];
    if (lv.length !== rv.length) return false;
    for (let k = 0; k < lv.length; k += 1) {
      if (lv[k] !== rv[k]) return false;
    }
    // 向量之外的字段（dim / sessionId / mergedFrom…）也决定元数据形状，变了就要写盘。
    const { vector: _lv, ...lrest } = left;
    const { vector: _rv, ...rrest } = right;
    if (JSON.stringify(lrest) !== JSON.stringify(rrest)) return false;
  }
  return true;
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
  // 引用契约（2026-10-21 真机日志）：没有任何分段命中时**原样返回 current**。
  // 此前的 `current.filter(...).flatMap(...)` 即使一个都没删掉也会造出新数组，
  // 触发 updateVectorIndex 的「新引用但内容未变」诊断，并白做一次整索引序列化
  //（空索引也照写）。删除路径常在「这个会话还没有任何向量」时被调用（切分支/
  // 重生成/删消息），所以这不是边角。
  return updateVectorIndex(characterId, current => {
    if (ids.size === 0) return current;
    let changed = false;
    const next = [];
    for (const item of current) {
      if (!item) {
        next.push(item);
        continue;
      }
      // 命中本条 ⇒ 整条删。未命中也要试着 pruneMergedSources：合并记忆的
      // messageId 是 ''，按消息删永远命中不了它，但它的 mergedFrom 快照可能
      // 引用了被删消息（P1-6b 的删除语义），必须一起清。
      if (hit(item.sessionId, item.messageId)) {
        changed = true;
        continue;
      }
      const pruned = pruneMergedSources(item, entry => hit(entry.sessionId, entry.messageId));
      if (pruned.length !== 1 || pruned[0] !== item) changed = true;
      next.push(...pruned);
    }
    return changed ? next : current;
  });
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
    // 引用契约（2026-10-21 真机日志）：没删到任何东西 → 原样返回 current。
    // `filter` 无条件造新数组，哪怕结果与输入逐项相同——空索引时尤其常见
    //（新会话切分支/重生成都会走到这里），会白写一次整索引并报契约诊断。
    if (!pruneSources) return kept.length === current.length ? current : kept;
    // pruneSources：即使没有整条被删，合并记忆的 mergedFrom 也可能引用被删会话
    //（条目本身属于别的会话）——所以不能在上面提前 return，必须逐条 prune。
    let prunedAny = false;
    const pruned = kept.flatMap(item => {
      const part = pruneMergedSources(item, entry => hit(entry.sessionId));
      if (part.length !== 1 || part[0] !== item) prunedAny = true;
      return part;
    });
    if (kept.length === current.length && !prunedAny) return current;
    return pruned;
  });
}

export function removeVectorIndexForSession(characterId, sessionId, options = {}) {
  return removeVectorIndexForSessions(characterId, [sessionId], options);
}

export function clearVectorIndex(characterId) {
  const key = vectorIndexKey(characterId);
  if (!key) return Promise.resolve();
  return enqueueVectorIndexMutation(characterId, async () => {
    // 顺序（L2）：**先删分片，最后删元数据**。
    //
    // 旧实现是先删元数据、再删分片。那个顺序一旦中途失败（或历史版本的
    // `.catch(() => {})` 吞掉错误），分片就成了**孤儿**：元数据没了，谁也找不到它们，
    // 而里面是整份 embedding。用户以为「记忆已删干净」，实际仍留在盘上。
    //
    // 反过来：先删分片、失败就抛（元数据还在，下次重试仍能定位到这个角色）；
    // 只有分片全删干净了才删元数据。最坏情况是「元数据还在、分片已空」——那只是
    // 一条没有向量的空索引，下次写入/对账即可收敛，且**不含任何内容**。
    // 换句话说：宁可留下空壳，也不留下内容。
    await removeAllVectorShards(characterId);
    await AsyncStorage.removeItem(key);
  });
}
