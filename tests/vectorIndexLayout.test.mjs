// 向量索引的存储形态：元数据 / 分片分离 + 紧凑编码 + 增量写入。
//
// 为什么必须真写盘再读回来验（不能只做源码断言）：这次改的是**数据布局**，
// 出错的方式是静默丢数据——元数据里不再内联向量，一旦分片没写成功或迁移时漏判，
// 用户的历史记忆就永久失去了向量（表面上一切正常，检索却再也召回不到）。
//
// 三条核心判据：
//   ① 元数据键里**不得再有**向量本体，只留 dim；向量的唯一去处是分片键；
//   ② 只改一条记忆时，只重写它所在的那一片（其余片一个字节都不动）；
//   ③ 旧布局（向量内联在元数据里）读回来照旧可用，且第一次写入就迁移成分片布局、
//      一条向量都不丢。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  VECTOR_SHARD_COUNT,
  decodeVector,
  encodeVector,
  vectorShardIndex,
  vectorShardKey,
} from '../src/storage/vectorCodec.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const store = new Map();
const setCalls = [];
const removed = [];
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { setCalls.push(key); store.set(key, value); },
  removeItem: async key => { removed.push(key); store.delete(key); },
};

function readStored(key) {
  const raw = store.get(key);
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
  backupCorruptValue: async key => { store.set(`${key}__corrupt_backup`, store.get(key)); },
  assertValueBudget: () => 0,
  readJson: async key => readStored(key),
  readJsonStatus: async key => {
    const raw = store.get(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    try { return { status: 'ok', value: JSON.parse(raw) }; } catch (error) { return { status: 'corrupt' }; }
  },
  readJsonWithSecrets: async (key, fallback) => {
    const value = readStored(key);
    return value === null ? fallback : value;
  },
  readJsonStatusWithSecrets: async key => {
    const raw = store.get(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    try { return { status: 'ok', value: JSON.parse(raw) }; } catch (error) { return { status: 'corrupt' }; }
  },
  setJsonWithSecrets: async (key, payload) => { store.set(key, JSON.stringify(payload)); },
};

function loadSourceModule(relativePath) {
  const sourcePath = path.resolve(relativePath);
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
    if (request.endsWith('/io.js')) return ioStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

const vector = loadSourceModule('src/storage/vector.js');

const INDEX_KEY = 'character-layout';
const indexKeyOf = id => `@easychat2_vector_index::${id}`;

function reset() {
  store.clear();
  setCalls.length = 0;
  removed.length = 0;
}

const seg = (id, extra = {}) => ({
  id,
  sessionId: 's1',
  messageId: `m-${id}`,
  role: 'assistant',
  at: 1,
  text: `记忆 ${id}`,
  vector: [1, 2, 3, 4],
  signature: 'sig',
  ...extra,
});

const shardKeysOf = characterId => [...store.keys()]
  .filter(key => key.startsWith(`@easychat2_vector_shard::${characterId}::`));

// ---- 编码层（纯函数）----

test('编码往返：整数向量逐位相等，浮点向量在 float32 精度内', () => {
  assert.deepEqual(decodeVector(encodeVector([1, 0, -3, 1024])), [1, 0, -3, 1024]);
  assert.deepEqual(decodeVector(encodeVector([0])), [0]);
  // float32 只有约 7 位有效数字：0.1 回来会是 0.10000000149011612。embedding 只用于
  // 余弦相似度排序，这个量级的误差不改变排序；但必须**明确**写下来，别让它看起来像精度无损。
  const [restored] = decodeVector(encodeVector([0.1]));
  assert.ok(Math.abs(restored - 0.1) < 1e-6, `float32 往返误差应在 1e-6 内，实际 ${restored}`);
});

test('编码体积：1024 维约 5.5KB，比 JSON 数字数组小 3 倍以上', () => {
  const vector1024 = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.5);
  const packed = encodeVector(vector1024);
  const jsonSize = JSON.stringify(vector1024).length;
  assert.ok(packed.length < 6000, `1024 维 base64 应小于 6000 字符，实际 ${packed.length}`);
  assert.ok(
    jsonSize / packed.length > 3,
    `应比 JSON 小 3 倍以上（JSON ${jsonSize} / base64 ${packed.length}）`
  );
  assert.equal(decodeVector(packed).length, 1024, '维度必须完整还原');
});

test('编码容错：空 / 非数组 / 脏值 / 半截 base64 都不抛，按「没有向量」返回', () => {
  assert.equal(encodeVector([]), '');
  assert.equal(encodeVector(null), '');
  assert.equal(encodeVector('not-an-array'), '');
  assert.deepEqual(decodeVector(''), []);
  assert.deepEqual(decodeVector(null), []);
  assert.deepEqual(decodeVector('!!!!'), [], '非法字符按读不出处理，不得产出垃圾向量');
  // encodeVector 里的 NaN/Infinity 落成 0（否则 base64 里会出现 NaN 位模式）
  assert.deepEqual(decodeVector(encodeVector([Number.NaN, Infinity])), [0, 0]);
});

test('分片：同一个分段键永远落在同一片，且散布在全部片上', () => {
  for (let i = 0; i < 200; i += 1) {
    const key = `s1\u0000m-${i}`;
    const first = vectorShardIndex(key);
    assert.equal(vectorShardIndex(key), first, '分片必须稳定（否则只能全量重写，分片白分）');
    assert.ok(first >= 0 && first < VECTOR_SHARD_COUNT, `分片下标越界：${first}`);
  }
  const used = new Set();
  for (let i = 0; i < 400; i += 1) used.add(vectorShardIndex(`s\u0000${i}`));
  assert.equal(used.size, VECTOR_SHARD_COUNT, `400 个键应覆盖全部 ${VECTOR_SHARD_COUNT} 片，实际 ${used.size}`);
});

test('分片键形状：带角色 id；空角色 id 不落任何键', () => {
  assert.equal(vectorShardKey('c1', 3), '@easychat2_vector_shard::c1::3');
  assert.equal(vectorShardKey('', 3), '');
  assert.equal(vectorShardKey(null, 0), '');
});

// ---- 存储布局（真写盘再读回）----

test('元数据键里不再有向量本体，只留 dim（这是本改造的核心判据）', async () => {
  reset();
  await vector.saveVectorIndex(INDEX_KEY, [seg('a'), seg('b')]);
  const meta = readStored(indexKeyOf(INDEX_KEY));
  assert.equal(Array.isArray(meta), true, '元数据仍是数组（形状不变）');
  assert.equal(meta.length, 2);
  for (const item of meta) {
    assert.equal('vector' in item, false, `元数据里不得再有向量本体：${JSON.stringify(Object.keys(item))}`);
    assert.equal(item.dim, 4, 'dim 必须留下（写入侧据此判断要不要重新嵌入）');
  }
  // 元数据体积与**维度**无关：1024 维的向量不会让它变大。
  reset();
  await vector.saveVectorIndex(INDEX_KEY, [seg('big', { vector: Array.from({ length: 1024 }, () => 0.5) })]);
  const metaSize = store.get(indexKeyOf(INDEX_KEY)).length;
  assert.ok(metaSize < 400, `元数据应只与条数有关（一条应小于 400 字节），实际 ${metaSize}`);
});

test('向量落在分片键里，且读回来与写入时一致', async () => {
  reset();
  const input = [seg('a', { vector: [1, 2, 3, 4] }), seg('b', { vector: [5, 6, 7, 8] })];
  await vector.saveVectorIndex(INDEX_KEY, input);
  const shards = shardKeysOf(INDEX_KEY);
  assert.ok(shards.length > 0, '必须有分片键');
  for (const key of shards) {
    const payload = readStored(key);
    assert.equal(typeof payload, 'object', '分片载荷是 {分段键: base64}');
    assert.equal(Array.isArray(payload), false);
    for (const packed of Object.values(payload)) {
      assert.equal(typeof packed, 'string', '分片里存的是 base64 字符串，不是数字数组');
    }
  }
  const index = await vector.getVectorIndex(INDEX_KEY);
  const byId = new Map(index.map(item => [item.id, item]));
  assert.deepEqual(byId.get('a').vector, [1, 2, 3, 4]);
  assert.deepEqual(byId.get('b').vector, [5, 6, 7, 8]);
});

test('增量写入：只改一条时只重写它所在的那一片', async () => {
  reset();
  // 造足够多的分段，确保至少落在两片以上（否则「只写一片」是废话）。
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push(seg(`m${i}`, { vector: [i, i + 1] }));
  await vector.saveVectorIndex(INDEX_KEY, many);
  const shardCount = shardKeysOf(INDEX_KEY).length;
  assert.ok(shardCount >= 2, `样例应覆盖多片，实际 ${shardCount} 片`);

  setCalls.length = 0;
  // 只动一条：updateVectorIndex 里 updater 对未改动项原样返回（引用相等），
  // 改动项换成新对象 + 新向量数组。
  await vector.updateVectorIndex(INDEX_KEY, current => current.map(item => (
    item.id === 'm0' ? { ...item, vector: [999, 998] } : item
  )));
  const writtenShards = setCalls.filter(key => key.startsWith('@easychat2_vector_shard::'));
  assert.equal(writtenShards.length, 1, `只应重写 1 片，实际 ${writtenShards.length} 片：${writtenShards}`);
  assert.ok(setCalls.includes(indexKeyOf(INDEX_KEY)), '元数据必须写（它记着谁存在）');

  const index = await vector.getVectorIndex(INDEX_KEY);
  const byId = new Map(index.map(item => [item.id, item]));
  assert.deepEqual(byId.get('m0').vector, [999, 998], '改动的向量必须落盘');
  assert.deepEqual(byId.get('m1').vector, [1, 2], '未改动的向量必须原样还在（不能因为只写一片就丢）');
  assert.equal(index.length, 40);
});

test('删除分段：分片里的向量一并删掉，片空了连键一起删', async () => {
  reset();
  await vector.saveVectorIndex(INDEX_KEY, [seg('only', { vector: [7, 7] })]);
  assert.equal(shardKeysOf(INDEX_KEY).length, 1);
  removed.length = 0;
  await vector.removeVectorIndexForMessage(INDEX_KEY, 's1', 'm-only');
  assert.equal((await vector.getVectorIndex(INDEX_KEY)).length, 0, '元数据里应没有这条了');
  assert.deepEqual(shardKeysOf(INDEX_KEY), [], '片里也不得留下它的向量（否则盘上永远清不掉）');
  assert.ok(removed.some(key => key.startsWith('@easychat2_vector_shard::')), '空片应连键删掉');
});

test('清空索引：元数据键与全部分片键一起清掉', async () => {
  reset();
  await vector.saveVectorIndex(INDEX_KEY, [seg('a'), seg('b'), seg('c')]);
  assert.ok(shardKeysOf(INDEX_KEY).length > 0);
  await vector.clearVectorIndex(INDEX_KEY);
  assert.equal(store.has(indexKeyOf(INDEX_KEY)), false, '元数据键必须没了');
  assert.deepEqual(shardKeysOf(INDEX_KEY), [], '分片键也必须没了（否则 embedding 永久留盘）');
  assert.deepEqual(await vector.getVectorIndex(INDEX_KEY), []);
});

test('迁移：旧布局（向量内联在元数据里）读回来照旧可用，第一次写入即迁移且不丢向量', async () => {
  reset();
  // 直接造出旧布局的原始值——就是历史版本写盘的样子。
  store.set(indexKeyOf(INDEX_KEY), JSON.stringify([
    { id: 'old1', sessionId: 's1', messageId: 'm1', role: 'assistant', at: 1, text: '旧一', vector: [1, 2], signature: 'sig' },
    { id: 'old2', sessionId: 's1', messageId: 'm2', role: 'assistant', at: 2, text: '旧二', vector: [3, 4], signature: 'sig' },
  ]));
  const before = await vector.getVectorIndex(INDEX_KEY);
  assert.deepEqual(before.map(item => item.vector), [[1, 2], [3, 4]], '旧布局必须照旧读出向量');

  // 一次「什么都没改」的更新：返回的是同一个数组引用 ⇒ 不写（这是上一批加的省写契约）。
  // 迁移必须由**真的写入**触发，所以这里让 updater 产生新数组但内容等价。
  await vector.updateVectorIndex(INDEX_KEY, current => current.map(item => ({ ...item })));
  const meta = readStored(indexKeyOf(INDEX_KEY));
  for (const item of meta) {
    assert.equal('vector' in item, false, '迁移后元数据里不得再有向量');
    assert.equal(item.dim, 2);
  }
  // 关键：迁移不能把向量弄丢。旧布局下「按引用判断没变化」会跳过落片，
  // 而元数据马上要被改写成不含向量的形状——那批向量就再没有地方存了。
  const after = await vector.getVectorIndex(INDEX_KEY);
  const byId = new Map(after.map(item => [item.id, item]));
  assert.deepEqual(byId.get('old1').vector, [1, 2], '迁移后 old1 的向量必须还在');
  assert.deepEqual(byId.get('old2').vector, [3, 4], '迁移后 old2 的向量必须还在');
  assert.ok(shardKeysOf(INDEX_KEY).length > 0, '迁移必须把向量落到分片里');
});

test('坏片自愈：分片读不出时不留垃圾向量、不抛错，元数据与其它片照旧可用', async () => {
  reset();
  await vector.saveVectorIndex(INDEX_KEY, [seg('a', { vector: [1, 1] }), seg('b', { vector: [2, 2] })]);
  // 把其中一个片写成坏值（合法 JSON 但不是 {key: base64} 的形状）。
  const [firstShard] = shardKeysOf(INDEX_KEY);
  store.set(firstShard, '[]');
  const index = await vector.getVectorIndex(INDEX_KEY);
  assert.equal(index.length, 2, '坏片不得让整个索引读不出来');
  for (const item of index) {
    assert.equal(Array.isArray(item.vector), true);
    assert.equal(item.vector.length === 0 || item.vector.length === 2, true);
  }
  // 元数据里 dim 仍在 ⇒ 这些分段会被重新嵌入（自愈），而不是被当成「从没有过向量」。
  for (const item of readStored(indexKeyOf(INDEX_KEY))) assert.ok(item.dim > 0);
});

test('非数组的元数据仍按损坏处理（与旧行为一致，不得因为改造放宽）', async () => {
  reset();
  store.set(indexKeyOf(INDEX_KEY), JSON.stringify({ not: 'an array' }));
  const status = await vector.readVectorIndexStatus(INDEX_KEY);
  assert.equal(status.status, 'corrupt');
  assert.ok(store.has(`${indexKeyOf(INDEX_KEY)}__corrupt_backup`), '损坏值必须先备份');
});
