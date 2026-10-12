import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { buildEmbeddingUrl, DEFAULT_VECTOR_PROVIDER, getVectorProvider } from '../src/vectorMemory/providers.js';
import {
  VECTOR_BATCH_SIZE_DEFAULT,
  VECTOR_BATCH_SIZE_MAX,
  VECTOR_MAX_CHARS_DEFAULT,
  VECTOR_MAX_CHARS_MAX,
  VECTOR_TIMEOUT_MS_DEFAULT,
  VECTOR_TOP_K_DEFAULT,
  VECTOR_TOP_K_MAX,
} from '../src/vectorMemory/limits.js';
import { tActive } from '../src/i18n/index.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/vectorMemory/index.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const filename = path.resolve('src/vectorMemory/index.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));

// 出网桩：P1-1 的关键断言是「空地址时**没有发生任何请求**」，必须能观测 vendorXhr 是否被调用。
// 桩照 src/network/vendorHttp.js:165 的 200 分支实现——finish(resolve, parse(xhr))。
const xhrRequests = [];
const vendorXhrStub = async request => {
  xhrRequests.push(request);
  return request.parse({ responseText: JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }) });
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/vendorHttp.js')) return { __esModule: true, default: vendorXhrStub };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  runtimeModule._compile(transformed, filename);
} finally {
  Module._load = originalLoad;
}
const {
  buildMemoryContext,
  chunkMessages,
  cosineSimilarity,
  embedTexts,
  indexMessages,
  selectVectorHits,
  vectorSignature,
} = runtimeModule.exports;

const message = {
  id: 'shared-message',
  role: 'assistant',
  text: '同一段角色记忆',
  timestamp: 1,
};

test('相同消息 id 的不同会话片段可以同时建立索引', async () => {
  const first = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-a',
    existing: [],
  });
  const second = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-b',
    existing: first,
  });
  assert.equal(second.length, 2);
  assert.deepEqual(second.map(item => item.sessionId), ['session-a', 'session-b']);
});

test('不同维度的向量不会被截断后当成高相似度', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0, 999]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
});

test('低于相关性门槛的向量命中被过滤', () => {
  const signature = vectorSignature({ enabled: true, model: 'm', maxChars: 400 });
  const items = [
    { id: 'strong', signature, vector: [1, 0] },
    { id: 'weak', signature, vector: [0.1, 1] },
    { id: 'stale', signature: 'other', vector: [1, 0] },
  ];
  const hits = selectVectorHits(items, [1, 0], { signature, topK: 5, minScore: 0.5 });
  assert.deepEqual(hits.map(item => item.id), ['strong']);
  // minScore=0 时保留弱命中，但仍排除指纹不匹配项
  const loose = selectVectorHits(items, [1, 0], { signature, topK: 5, minScore: 0 });
  assert.deepEqual(loose.map(item => item.id), ['strong', 'weak']);
});

test('记忆上下文总长度不会超过配置上限', () => {
  const context = buildMemoryContext([{ text: 'a'.repeat(2000) }], { maxTotalChars: 1200 });
  assert.ok(context.length <= 1210);
  assert.ok(context.endsWith('a'.repeat(1200)));
});

test('索引片段会带上向量配置指纹', async () => {
  const items = await indexMessages({
    messages: [message],
    config: { enabled: true, model: 'embed-a', maxChars: 400 },
    sessionId: 'session-sig',
    existing: [],
  });
  assert.equal(items[0].signature, vectorSignature({ enabled: true, model: 'embed-a', maxChars: 400 }));
  assert.notEqual(
    vectorSignature({ enabled: true, model: 'embed-a', maxChars: 400 }),
    vectorSignature({ enabled: true, model: 'embed-b', maxChars: 400 })
  );
  assert.notEqual(
    vectorSignature({ enabled: true, model: 'embed-a', maxChars: 400 }),
    vectorSignature({ enabled: true, model: 'embed-a', maxChars: 800 })
  );
});

test('同一会话同一消息不会重复建立片段', async () => {
  const first = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-a',
    existing: [],
  });
  const second = await indexMessages({
    messages: [message],
    config: { enabled: true },
    sessionId: 'session-a',
    existing: first,
  });
  assert.deepEqual(second, first);
  assert.equal(chunkMessages([message], { sessionId: 'session-a' })[0].id, 'shared-message-0');
});

// ---------------------------------------------------------------------------
// P1-1：空地址/空模型不得被静默回填成 OpenAI 默认值
// ---------------------------------------------------------------------------

// src/storage/vector.js 的隔离加载（AsyncStorage 与 io 全桩）。「清空地址后保存不被回填」
// 必须真的走一遍落盘再读回来：只断言 index.js 的归一化证明不了设置页那条
// 500ms 防抖落盘 → 回读 → setVectorPayload 的路径不再把地址灌回输入框。
const vectorStore = new Map();
const AsyncStorageStub = {
  getItem: async key => (vectorStore.has(key) ? vectorStore.get(key) : null),
  setItem: async (key, value) => { vectorStore.set(key, value); },
  removeItem: async key => { vectorStore.delete(key); },
};
function readStoredJson(key) {
  const raw = vectorStore.get(key);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch (error) { return null; }
}
const ioStub = {
  createMutationQueue: () => {
    let single = Promise.resolve();
    return {
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
    };
  },
  backupCorruptValue: async () => {},
  assertValueBudget: () => 0,
  readJson: async key => readStoredJson(key),
  readJsonStatus: async key => {
    const value = readStoredJson(key);
    return value === null ? { status: 'missing' } : { status: 'ok', value };
  },
  readJsonWithSecrets: async (key, fallback) => {
    const value = readStoredJson(key);
    return value === null ? fallback : value;
  },
  setJsonWithSecrets: async (key, payload) => { vectorStore.set(key, JSON.stringify(payload)); },
};

const vectorStoragePath = path.resolve('src/storage/vector.js');
const vectorStorageTransformed = babel.transformSync(fs.readFileSync(vectorStoragePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: vectorStoragePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const vectorStorageModule = new Module(vectorStoragePath);
vectorStorageModule.filename = vectorStoragePath;
vectorStorageModule.paths = Module._nodeModulePaths(path.dirname(vectorStoragePath));
Module._load = function patchedStorageLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorageStub;
  if (request.endsWith('/io.js')) return ioStub;
  return originalLoad.call(this, request, parent, isMain);
};
try {
  vectorStorageModule._compile(vectorStorageTransformed, vectorStoragePath);
} finally {
  Module._load = originalLoad;
}
const vectorStorage = vectorStorageModule.exports;

test('P1-1：清空接口地址/模型后保存不被回填，回读仍为空', async () => {
  vectorStore.clear();
  await vectorStorage.saveVectorMemorySettings({
    enabled: true,
    activeId: 'default',
    configs: [{ id: 'default', name: '默认向量配置', baseUrl: '', model: '', apiKey: 'sk-user-owned' }],
  });
  const payload = await vectorStorage.getVectorMemorySettings();
  assert.equal(payload.configs[0].baseUrl, '', '空地址必须原样保存，不得回填 api.openai.com');
  assert.equal(payload.configs[0].model, '', '空模型必须原样保存，不得回填 text-embedding-3-small');
  assert.equal(payload.configs[0].apiKey, 'sk-user-owned', '用户自己的 Key 原样保留');
  // providerId 的默认值取自 providers.js 的目录（唯一真源），不是手抄字面量
  assert.equal(payload.configs[0].providerId, DEFAULT_VECTOR_PROVIDER.id);
  const raw = [...vectorStore.values()].join('\n');
  assert.ok(!raw.includes('api.openai.com'), '盘上不得出现凭空写入的第三方地址');
  assert.ok(!raw.includes('text-embedding-3-small'), '盘上不得出现凭空写入的模型名');
});

test('P1-1：旧单配置写入路径同样不回填空地址', async () => {
  vectorStore.clear();
  await vectorStorage.saveVectorMemoryConfig({ id: 'default', name: '默认向量配置', enabled: true });
  const active = await vectorStorage.getVectorMemoryConfig();
  assert.equal(active.baseUrl, '');
  assert.equal(active.model, '');
});

test('P1-1：storage/vector.js 不得再手抄 provider 默认字面量', () => {
  // 先剥注释：说明「为什么不能回填 api.openai.com」的注释本身会命中字面量断言。
  const source = fs.readFileSync(path.resolve('src/storage/vector.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!source.includes('api.openai.com'), '地址默认值只应来自 providers.js');
  assert.ok(!source.includes('text-embedding-3-small'), '模型默认值只应来自 providers.js');
  assert.ok(!source.includes("'openai-embeddings'"), 'providerId 默认值只应来自 providers.js');
  assert.ok(source.includes('DEFAULT_VECTOR_PROVIDER'), '应从 providers.js 取唯一真源');
});

test('P1-1：空地址时 embedTexts 抛 baseUrlRequired，且没有发生任何请求', async () => {
  xhrRequests.length = 0;
  const expected = tActive('error.vectorMemory.baseUrlRequired');
  await assert.rejects(
    () => embedTexts({
      config: { enabled: true, baseUrl: '   ', apiKey: 'sk-user-owned', model: 'm' },
      texts: ['用户的一段聊天正文'],
    }),
    error => error.message === expected,
    '空白地址必须报「请先填写向量服务地址」'
  );
  // 归一化之后才判空会永远判不出空（此前正是如此，守卫恒不可达）；这条断言钉死原始值守卫。
  await assert.rejects(
    () => embedTexts({ config: null, texts: ['x'] }),
    error => error.message === expected
  );
  assert.equal(xhrRequests.length, 0, '空地址不得发出任何请求（否则正文与 Key 会外发）');
});

test('P1-1 对照：地址非空时只发往用户自己的地址（证明出网桩已接线）', async () => {
  xhrRequests.length = 0;
  const vectors = await embedTexts({
    config: { enabled: true, baseUrl: 'https://user-own.example/v1', apiKey: 'k', model: 'm' },
    texts: ['你好'],
  });
  assert.deepEqual(vectors, [[0.5, 0.5]]);
  assert.equal(xhrRequests.length, 1);
  assert.equal(xhrRequests[0].url, 'https://user-own.example/v1/embeddings');
  assert.ok(!xhrRequests[0].url.includes('api.openai.com'));
});

// ---------------------------------------------------------------------------
// P1-2：buildEmbeddingUrl 不得拼坏带 query 的地址（Azure 部署地址必踩）
// ---------------------------------------------------------------------------

test('P1-2：已以 /embeddings 结尾（含 query）的地址原样返回，不重复追加', () => {
  const azure = 'https://x.openai.azure.com/openai/deployments/d/embeddings?api-version=2023-05-15';
  assert.equal(buildEmbeddingUrl(azure), azure, 'Azure 部署地址不得被追加成 .../embeddings?api-version=.../embeddings');
  assert.equal(buildEmbeddingUrl('https://x.example/v1/embeddings'), 'https://x.example/v1/embeddings');
  // 尾斜杠要归一掉，但 query 必须原样保住
  assert.equal(
    buildEmbeddingUrl('https://x.example/v1/embeddings/?api-version=1'),
    'https://x.example/v1/embeddings?api-version=1'
  );
});

test('P1-2：不带 /embeddings 的地址仍追加端点，query 接在端点之后', () => {
  assert.equal(buildEmbeddingUrl('https://x.example/v1'), 'https://x.example/v1/embeddings');
  assert.equal(buildEmbeddingUrl('https://x.example/v1/'), 'https://x.example/v1/embeddings');
  assert.equal(
    buildEmbeddingUrl('https://x.openai.azure.com/openai/deployments/d?api-version=2023-05-15'),
    'https://x.openai.azure.com/openai/deployments/d/embeddings?api-version=2023-05-15'
  );
  assert.equal(buildEmbeddingUrl(''), '');
});

test('P1-2：端点后缀取本次实际 provider，不写死默认 provider', () => {
  const source = fs.readFileSync(path.resolve('src/vectorMemory/providers.js'), 'utf8');
  const body = source.slice(source.indexOf('export function buildEmbeddingUrl'));
  assert.ok(
    !body.includes('DEFAULT_VECTOR_PROVIDER'),
    '端点必须按传入的 providerId 取，否则会出现「鉴权按新 provider、端点按默认 provider」的半应用状态'
  );
  assert.ok(body.includes('getVectorProvider(providerId)'));
  assert.equal(buildEmbeddingUrl('https://x.example/v1', DEFAULT_VECTOR_PROVIDER.id), 'https://x.example/v1/embeddings');
  // 未知 providerId 在 buildEmbeddingUrl 里只兜「端点形状」（getVectorProvider 本身已
  // fail-closed 返回 null，见下面 P1-3），故这里仍不得抛错。
  assert.equal(buildEmbeddingUrl('https://x.example/v1', 'not-a-provider'), 'https://x.example/v1/embeddings');
});

// ---------------------------------------------------------------------------
// P1-3：未知 providerId 必须 fail-closed，不得被静默改写成默认 provider
// ---------------------------------------------------------------------------

test('P1-3：getVectorProvider 对未知 id 返回 null（fail-closed），不再静默回落', () => {
  assert.equal(getVectorProvider(DEFAULT_VECTOR_PROVIDER.id), DEFAULT_VECTOR_PROVIDER);
  assert.equal(
    getVectorProvider('not-a-provider'),
    null,
    '未知 id 必须交给调用方决定（照 src/localModel/adapter.js 的 fail-closed 方向），不得静默换成默认 provider'
  );
  assert.equal(getVectorProvider(undefined), null);
});

test('P1-3：getVectorProvider 源码里不得再留静默回落的兜底（源码级）', () => {
  const source = fs.readFileSync(path.resolve('src/vectorMemory/providers.js'), 'utf8');
  // 先剥行注释：解释「此前为什么会静默回落」的注释本身会命中字面量断言
  // （照本文件 P1-1「storage/vector.js 不得再手抄 provider 默认字面量」的先例）。
  const code = source.replace(/\/\/[^\n]*/g, '');
  const body = code.slice(
    code.indexOf('export function getVectorProvider'),
    code.indexOf('export function buildEmbeddingUrl')
  );
  assert.ok(!body.includes('|| DEFAULT_VECTOR_PROVIDER'), '未知 id 不得回落到默认 provider');
  assert.ok(body.includes('|| null'), '应显式返回 null，由调用方决定怎么处理');
});

test('P1-3：normalizeVectorConfig 原样保留用户存下的 providerId，不改写指纹', () => {
  // 改写 providerId 的后果：vectorSignature（成员含 providerId）随之变化 ⇒ indexMessages
  // 把**全部**存量分段判成指纹不符而重新嵌入（等于把历史消息整体再发给向量服务），
  // 该次请求失败时还会以 vector: [] 把旧向量覆盖为空。
  const resolved = runtimeModule.exports.normalizeVectorConfig({ providerId: 'not-a-provider', model: 'm' });
  assert.equal(resolved.providerId, 'not-a-provider', '未知 providerId 必须原样保留，不得改写成默认 provider');
  assert.ok(
    runtimeModule.exports
      .vectorSignature({ providerId: 'not-a-provider', model: 'm', maxChars: 400 })
      .startsWith('not-a-provider\u0000'),
    '指纹首段必须是用户存下的 providerId（否则降级/换端回来就会全量重嵌入）'
  );
  // 既有语义不变：未指定时默认值仍取自 providers.js 目录（唯一真源）
  assert.equal(runtimeModule.exports.normalizeVectorConfig({}).providerId, DEFAULT_VECTOR_PROVIDER.id);
  // 目录里查不到时只兜「形状」，不臆造 provider 的值
  assert.equal(resolved.batchSize, 16);
  assert.equal(resolved.timeoutMs, 30000);
});

test('P1-3：未知 providerId 时 embedTexts fail-closed，且没有发生任何请求', async () => {
  // 先把「词条真的存在」钉死：否则下面 message === tActive(...) 两边同时退化成键名原文，
  // 断言会自己骗自己（界面显示 'vectorProvider.unknownProvider' 也是缺词条的经典症状）。
  const expected = tActive('vectorProvider.unknownProvider', { id: 'not-a-provider' });
  assert.notEqual(expected, 'vectorProvider.unknownProvider', '词条必须存在于语言包，不得回退成键名原文');
  assert.ok(expected.includes('not-a-provider'), '报错要带上用户存下的 providerId，便于自查');

  xhrRequests.length = 0;
  await assert.rejects(
    () => embedTexts({
      config: {
        enabled: true,
        baseUrl: 'https://user-own.example/v1',
        apiKey: 'k',
        model: 'm',
        providerId: 'not-a-provider',
      },
      texts: ['用户的一段聊天正文'],
    }),
    error => error.message === expected,
    '未知 providerId 必须报「本版本不认识的向量服务」，而不是 provider.auth 的 TypeError'
  );
  assert.equal(xhrRequests.length, 0, '未知 providerId 不得发出任何请求（鉴权形状未知 ⇒ 正文与 Key 都不许外发）');
});

// ---------------------------------------------------------------------------
// P1-6b：删消息必须连带清掉合并记忆里的**原文快照**（mergedFrom[].text）
// ---------------------------------------------------------------------------
// 缺陷：合并记忆的 messageId 是 ''（它没有单条来源消息），而 removeVectorIndexForMessages
// 只按 item.messageId 过滤 ⇒ 合并记忆**永远命中不了**。可它的 mergedFrom[].text 里存着
// 被合并的完整原文（写入见 memory/MemoryProvenanceModal.js，展示见 memory/provenance.js:64-75）
// ⇒ 用户删掉消息后，原文仍留在盘上，还能在溯源面板里全文读到。
// 语义参照 memory.provenance.evidence.deleteConfirm.body「原始对话消息不受影响」：
// 反向同样成立——删了消息，记忆里那份原文快照也必须一起走。
//
// 行为测试（真的写盘再读回来）：清哪些、留哪些、清空之后整条怎么处置，三者都要钉住。

const MERGED_SNAPSHOT = {
  id: 'merged-1',
  sessionId: 's1',
  messageId: '',
  text: '用户对猫的喜好从喜欢变成了讨厌',
  vector: [0, 1],
  signature: 'sig',
  origin: 'merged',
  mergedFrom: [
    { id: 'seg-a', sessionId: 's1', messageId: 'm-gone', text: '用户：我喜欢猫', at: 10 },
    { id: 'seg-b', sessionId: 's1', messageId: 'm-keep', text: '用户：我讨厌猫', at: 20 },
  ],
};

test('P1-6b：删消息清掉命中的 mergedFrom 快照，未命中的原样保留', async () => {
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-snap', [
    { id: 'seg-plain', sessionId: 's1', messageId: 'm-keep', text: '用户：我讨厌猫', vector: [1, 0] },
    { id: 'seg-doomed', sessionId: 's1', messageId: 'm-gone', text: '用户：我喜欢猫', vector: [1, 1] },
    MERGED_SNAPSHOT,
  ]);

  await vectorStorage.removeVectorIndexForMessages('char-snap', 's1', ['m-gone']);
  const index = await vectorStorage.getVectorIndex('char-snap');

  // 普通记忆：原有语义不变（命中 messageId 的整条移除）
  assert.deepEqual(
    index.map(item => item.id).sort(),
    ['merged-1', 'seg-plain'],
    '普通记忆按 messageId 移除，合并记忆因还有存活来源而保留'
  );
  const merged = index.find(item => item.id === 'merged-1');
  assert.deepEqual(
    merged.mergedFrom.map(entry => entry.messageId),
    ['m-keep'],
    '命中被删消息的快照必须被清掉'
  );
  assert.equal(merged.mergedFrom[0].text, '用户：我讨厌猫', '未命中的快照原样保留（防过度清理）');
  assert.ok(
    !JSON.stringify([...vectorStore.values()]).includes('我喜欢猫'),
    '被删消息的原文不得再留在盘上（包括快照里）'
  );
});

test('P1-6b：合并来源被全部删掉时整条记忆退休，不留只有结论的孤儿', async () => {
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-retire', [MERGED_SNAPSHOT]);
  await vectorStorage.removeVectorIndexForMessages('char-retire', 's1', ['m-gone', 'm-keep']);
  const index = await vectorStorage.getVectorIndex('char-retire');
  assert.deepEqual(index, [], '已无可溯源原文的合并记忆整条退休（与普通记忆同一处置）');
  assert.ok(!JSON.stringify([...vectorStore.values()]).includes('我喜欢猫'));
});

test('P1-6b：会话或消息 id 没对上就不动（跨会话同 id 不得误清）', async () => {
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-scope', [{
    ...MERGED_SNAPSHOT,
    id: 'merged-scope',
    sessionId: 's2',
    mergedFrom: [
      { id: 'seg-a', sessionId: 's1', messageId: 'shared-id', text: '别的会话里的同名消息', at: 10 },
      { id: 'seg-b', sessionId: 's2', messageId: 'other', text: '本会话的另一条', at: 20 },
    ],
  }]);
  // s2 里没有 shared-id 这条消息：会话对不上就不许清（跨会话同 id 是两条不同的消息）
  await vectorStorage.removeVectorIndexForMessages('char-scope', 's2', ['shared-id']);
  const [item] = await vectorStorage.getVectorIndex('char-scope');
  assert.deepEqual(
    item.mergedFrom.map(entry => `${entry.sessionId}:${entry.messageId}`),
    ['s1:shared-id', 's2:other'],
    '会话没对上的快照必须原样保留'
  );
});

test('P1-6b：空 messageIds 不触碰任何条目', async () => {
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-noop', [
    { id: 'plain', sessionId: 's1', messageId: 'm1', text: '普通记忆', vector: [1] },
    MERGED_SNAPSHOT,
  ]);
  const before = await vectorStorage.getVectorIndex('char-noop');
  await vectorStorage.removeVectorIndexForMessages('char-noop', 's1', []);
  const after = await vectorStorage.getVectorIndex('char-noop');
  assert.deepEqual(after, before, '空 id 集合时索引必须一个字节都不变');
});

// ---------------------------------------------------------------------------
// 按会话清理的两种语义：归档（可回溯，不清快照）vs 真删除（清快照）
// ---------------------------------------------------------------------------
// 背景：removeVectorIndexForSession 同时被两类路径调用，而两者在调用点长得一模一样：
//  · 归档/分支切换/重生成/修改重发/整段清空（useChatSend.js:1789、useChatSend.js:1895、
//    ChatScreen.js:1267、ChatScreen.js:1442）——消息被 archiveBranch 存成分支，随时能
//    checkout 回来（ChatScreen.js:1215 onCheckoutBranch 把分支正文拼回活动时间线）
//    ⇒ 归档中的消息仍是可召回的有效证据，其 mergedFrom 快照**必须原样保留**（否则误删证据链）。
//    ⚠️ ChatScreen.js:1442（「全选 + 删除」清空整会话）属于本类：它在 :1431 先 archiveBranch
//    把整段尾段归档成分支，消息可召回 ⇒ 不传 options 是对的，**不要**给它加 pruneSources。
//  · 真删除（sessionList/mutations.js 的 deleteSessionInternal / deleteSessionsInternal）
//    ——这两个函数随后都会 deleteAllBranchesInternal 把归档分支一并清掉，消息再也回不来
//    ⇒ 与 removeVectorIndexForMessages 的删除语义一致，快照必须一起走（P1-6b）。
// 存储层分辨不了这两者，所以「清快照」只能由调用方显式选择：默认不清（= 归档语义，
// 与既有行为逐字节一致），真删除路径传 { pruneSources: true }。
//
// 下面两条断言必须**成对**存在：只钉「删除会清」会漏掉误删归档证据，只钉「归档不清」
// 则会让真删除继续留盘（就是本次要修的那个缺陷）。

// 跨会话合并记忆：条目挂在存活会话 s2，mergedFrom 里一条来自 s1、一条来自 s2。
// 用它才能把「按会话过滤条目」与「清 mergedFrom 快照」两件事分开验——条目本身的
// sessionId 若是 s1，它会被会话过滤先拿走，pruneSources 开不开就看不出差别了。
const CROSS_SESSION_MERGED = {
  ...MERGED_SNAPSHOT,
  id: 'merged-cross',
  sessionId: 's2',
  mergedFrom: [
    { id: 'seg-a', sessionId: 's1', messageId: 'm-gone', text: '被归档会话的原文', at: 10 },
    { id: 'seg-b', sessionId: 's2', messageId: 'm-keep', text: '存活会话的原文', at: 20 },
  ],
};

test('按会话清理·归档语义：默认不清 mergedFrom 快照（归档可回溯，快照是有效证据）', async () => {
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-archive', [
    { id: 'seg-plain', sessionId: 's1', messageId: 'm1', text: '用户：我喜欢猫', vector: [1, 0] },
    CROSS_SESSION_MERGED,
  ]);

  // 归档路径的真实调用形状：只传 (ownerId, sessionId)，不带任何选项。
  await vectorStorage.removeVectorIndexForSession('char-archive', 's1');
  const index = await vectorStorage.getVectorIndex('char-archive');

  assert.deepEqual(index.map(item => item.id), ['merged-cross'], '本会话的普通分段仍按会话清掉');
  const merged = index.find(item => item.id === 'merged-cross');
  assert.deepEqual(
    merged.mergedFrom.map(entry => `${entry.sessionId}:${entry.messageId}`),
    ['s1:m-gone', 's2:m-keep'],
    '归档不是删除：来自归档会话的快照必须原样保留，否则 checkout 回来就再也读不到原始证据'
  );
  assert.ok(
    JSON.stringify([...vectorStore.values()]).includes('被归档会话的原文'),
    '归档中的原文仍应留盘（它是可回溯消息的证据，不是残留）'
  );
});

test('按会话清理·删除语义：显式 { pruneSources: true } 才清快照，且全删时整条退休', async () => {
  // 真删除 s1：只清 s1 那一份快照，s2 的原样保留。
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-forget-2', [CROSS_SESSION_MERGED]);
  await vectorStorage.removeVectorIndexForSessions('char-forget-2', ['s1'], { pruneSources: true });
  const [cross] = await vectorStorage.getVectorIndex('char-forget-2');
  assert.deepEqual(
    cross.mergedFrom.map(entry => `${entry.sessionId}:${entry.messageId}`),
    ['s2:m-keep'],
    '只清被真删会话的那一份快照，别的会话原样保留'
  );
  assert.ok(
    !JSON.stringify([...vectorStore.values()]).includes('被归档会话的原文'),
    '真删会话的原文不得再留在盘上（包括快照里）'
  );

  // 快照全被真删 ⇒ 整条退休，与 removeVectorIndexForMessages 同一处置。
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-forget-3', [{
    ...MERGED_SNAPSHOT,
    id: 'merged-all-gone',
    sessionId: 's2',
    mergedFrom: [{ id: 'seg-a', sessionId: 's1', messageId: 'm-gone', text: '仅存来源', at: 10 }],
  }]);
  await vectorStorage.removeVectorIndexForSession('char-forget-3', 's1', { pruneSources: true });
  assert.deepEqual(
    await vectorStorage.getVectorIndex('char-forget-3'),
    [],
    '已无可溯源原文的合并记忆整条退休，不留只有结论的孤儿'
  );

  // 对照：同一份索引走默认（归档）入口，条目必须一个字节都不少——防过度修正。
  vectorStore.clear();
  await vectorStorage.saveVectorIndex('char-forget-4', [{
    ...MERGED_SNAPSHOT,
    id: 'merged-all-gone',
    sessionId: 's2',
    mergedFrom: [{ id: 'seg-a', sessionId: 's1', messageId: 'm-gone', text: '仅存来源', at: 10 }],
  }]);
  await vectorStorage.removeVectorIndexForSession('char-forget-4', 's1');
  const kept = await vectorStorage.getVectorIndex('char-forget-4');
  assert.equal(kept.length, 1, '默认入口不得清快照（否则归档证据被误删）');
  assert.equal(kept[0].mergedFrom.length, 1);
});

test('按会话清理·语义分派钉死在源码：默认分支不清快照，归档调用点不得显式开清', () => {
  const storageSource = fs.readFileSync(path.resolve('src/storage/vector.js'), 'utf8');
  const body = storageSource.slice(storageSource.indexOf('export function removeVectorIndexForSessions'));
  assert.ok(
    body.includes('options.pruneSources === true'),
    '清快照必须由调用方显式选择（默认 false），否则归档会被当成删除'
  );
  assert.ok(
    body.includes('if (!pruneSources) return kept;'),
    '未显式选择时必须早退，保持既有「只按会话过滤」的行为'
  );

  // 归档/回溯路径是只读依赖（别的批次也会改它），这里只断言**它没有**开清快照：
  // 一旦有人给归档路径加上 pruneSources，可回溯的消息证据会被误删。
  // 不钉死调用点数量——该文件会被别的批次改动，数量变化不该让本测试变红。
  const sendSource = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  const archiveCalls = sendSource
    .split('\n')
    .filter(line => line.includes('removeVectorIndexForSession('));
  assert.ok(archiveCalls.length >= 2, '归档路径的调用点消失了，请复核语义是否被改动');
  archiveCalls.forEach(line => {
    assert.ok(
      !line.includes('pruneSources'),
      '归档/回溯路径不得清 mergedFrom 快照（归档中的消息随时可 checkout 回来）'
    );
  });
});

// 上面那条只钉了「归档侧**不得**开清」——它**不足以**发现「删除侧忘了开清」：
// 只钉一半时，pruneSources 可以在生产代码里零调用点（正是本次修的那个半成品状态），
// 测试照样全绿。这条补上另一半，两条合起来才把「归档 vs 删除」钉成不变量。
test('按会话清理·真删除调用点必须显式开清快照，归档调用点必须不开（成对不变量）', () => {
  // 剥注释再匹配：本仓注释里大量引用这两个函数名与选项名（含本次新增的说明），
  // 不剥注释就会把说明文字当成代码来断言。
  const stripComments = source => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // 只取**调用形状**（带左括号）：import 行里的裸标识符没有括号，天然被排除。
  const callsIn = relative => stripComments(fs.readFileSync(path.resolve(relative), 'utf8'))
    .split('\n')
    .filter(line => /removeVectorIndexForSessions?\(/.test(line));

  // ① 真删除侧：deleteSessionInternal / deleteSessionsInternal 随后都会
  //    deleteAllBranchesInternal 把归档分支一并清掉 ⇒ 消息再也 checkout 不回来
  //    ⇒ 必须传 { pruneSources: true }，否则被删消息的原文仍留在盘上、还能在溯源面板读到（P1-6b）。
  const deleteCalls = callsIn('src/storage/sessionList/mutations.js');
  assert.ok(
    deleteCalls.length >= 2,
    '真删除路径的调用点消失了，请复核语义是否被改动（deleteSession / deleteSessions）'
  );
  deleteCalls.forEach(line => {
    assert.ok(
      line.includes('pruneSources: true'),
      `真删除路径必须显式清 mergedFrom 快照（删了消息，记忆里那份原文快照也要一起走）：${line.trim()}`
    );
  });

  // ② 归档侧反向断言：归档/分支切换/重生成/修改重发/整段清空的消息被 archiveBranch 存成
  //    分支、随时可召回 ⇒ 一旦给它们加上 pruneSources，可回溯的证据链会被误删。
  //    ChatScreen.js:1442（「全选 + 删除」）也在这一侧：它在 :1431 先 archiveBranch。
  const archiveSources = ['src/chat/useChatSend.js', 'src/ChatScreen.js'];
  const archiveCallLines = archiveSources.flatMap(callsIn);
  assert.ok(
    archiveCallLines.length >= 3,
    '归档/回溯路径的调用点数量异常（预期 useChatSend 两处 + ChatScreen 两处）'
  );
  archiveCallLines.forEach(line => {
    assert.ok(
      !line.includes('pruneSources'),
      `归档/回溯路径不得清 mergedFrom 快照（归档中的消息随时可 checkout 回来）：${line.trim()}`
    );
  });
});

// ---------------------------------------------------------------------------
// 数值边界与默认值：单一真源（limits.js）——三处不得再各手抄一份
// ---------------------------------------------------------------------------
// 此前 batchSize=16 在 providers.js（目录真源）、vectorMemory/index.js 的
// DEFAULT_BATCH_SIZE、storage/vector.js 的兜底字面量各写一份；上限/默认
// 20/2000/64 与 5/400/16 在 index.js 与 storage/vector.js 各一份；timeoutMs=30000 在
// providers.js 与 index.js 各一份。收敛到 limits.js 后，源码级与行为级各钉一遍。

test('收敛：三处数值来源唯一，且不再留手抄字面量（源码级）', () => {
  const strip = relative => fs.readFileSync(path.resolve(relative), 'utf8').replace(/\/\/[^\n]*/g, '');

  const limits = strip('src/vectorMemory/limits.js');
  assert.ok(!/\bimport\b/.test(limits), 'limits.js 必须零依赖，否则会与 storage/vector.js 形成环');

  const indexSource = strip('src/vectorMemory/index.js');
  const storageSource = strip('src/storage/vector.js');
  const providersSource = strip('src/vectorMemory/providers.js');

  // 两侧都必须从 limits.js 取值
  [indexSource, storageSource].forEach((source, i) => {
    const label = i === 0 ? 'vectorMemory/index.js' : 'storage/vector.js';
    assert.ok(source.includes("from './limits.js'") || source.includes("from '../vectorMemory/limits.js'"),
      `${label} 必须从 limits.js 取数值真源`);
    // 手抄的夹取字面量必须消失：Math.min(20, …) / Math.min(2000, …) / Math.min(64, …)
    assert.ok(!/Math\.min\(20,/.test(source), `${label} 不得再手抄 topK 上限 20`);
    assert.ok(!/Math\.min\(2000,/.test(source), `${label} 不得再手抄 maxChars 上限 2000`);
    assert.ok(!/Math\.min\(64,/.test(source), `${label} 不得再手抄 batchSize 上限 64`);
  });

  // providers.js 的目录项也不再手抄 30000 / 16
  assert.ok(!/timeoutMs:\s*\d+/.test(providersSource), 'providers.js 不得再手抄 timeoutMs 字面量');
  assert.ok(!/batchSize:\s*\d+/.test(providersSource), 'providers.js 不得再手抄 batchSize 字面量');
});

test('收敛：两处归一化对同一组边界逐条给出同一结果（行为级）', async () => {
  const resolved = runtimeModule.exports.normalizeVectorConfig;
  const viaIndex = input => resolved({ providerId: DEFAULT_VECTOR_PROVIDER.id, ...input });

  // 上限：超限一律夹到 limits.js 的值
  assert.equal(viaIndex({ topK: 999 }).topK, VECTOR_TOP_K_MAX);
  assert.equal(viaIndex({ maxChars: 99999 }).maxChars, VECTOR_MAX_CHARS_MAX);
  assert.equal(viaIndex({ batchSize: 999 }).batchSize, VECTOR_BATCH_SIZE_MAX);

  // 默认：非正/非数一律回落到 limits.js 的默认值
  assert.equal(viaIndex({ topK: 0 }).topK, VECTOR_TOP_K_DEFAULT);
  assert.equal(viaIndex({ maxChars: -1 }).maxChars, VECTOR_MAX_CHARS_DEFAULT);
  assert.equal(viaIndex({}).batchSize, VECTOR_BATCH_SIZE_DEFAULT);
  assert.equal(viaIndex({}).timeoutMs, VECTOR_TIMEOUT_MS_DEFAULT);

  // storage/vector.js 侧：走真实落盘再读回，确认设置页那条路径用的是同一组数字
  vectorStore.clear();
  await vectorStorage.saveVectorMemorySettings({
    enabled: true,
    activeId: 'default',
    configs: [{ id: 'default', name: '默认向量配置', topK: 999, maxChars: 99999, batchSize: 999 }],
  });
  const clamped = (await vectorStorage.getVectorMemorySettings()).configs[0];
  assert.equal(clamped.topK, VECTOR_TOP_K_MAX, '设置页夹取上限必须与发请求侧同源');
  assert.equal(clamped.maxChars, VECTOR_MAX_CHARS_MAX);
  assert.equal(clamped.batchSize, VECTOR_BATCH_SIZE_MAX);

  await vectorStorage.saveVectorMemorySettings({
    enabled: true,
    activeId: 'default',
    configs: [{ id: 'default', name: '默认向量配置', topK: 0, maxChars: 0, batchSize: 0 }],
  });
  const defaults = (await vectorStorage.getVectorMemorySettings()).configs[0];
  assert.equal(defaults.topK, VECTOR_TOP_K_DEFAULT);
  assert.equal(defaults.maxChars, VECTOR_MAX_CHARS_DEFAULT);
  assert.equal(defaults.batchSize, VECTOR_BATCH_SIZE_DEFAULT);
});
