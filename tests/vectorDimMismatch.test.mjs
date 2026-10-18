// L4/L5：分片解码出的维度必须与元数据 dim 一致——不一致要留痕并自愈，不能静默失忆。
//
// 缺陷（已核实）：
//   fillVectorsFromShards 此前一句 `vector.length > 0 ? { ...item, vector } : item`
//   直接采用解码结果，**从不比对元数据 dim**。而分片 base64 若被截断（JSON 仍合法、
//   只是串变短），decodeVector 会安静地解出更少的浮点数。后果连锁三步：
//     ① normalizeVectorEntry 把 dim 改写成那个错误长度（元数据的 dim 被静默覆盖）；
//     ② 检索侧 cosineSimilarity 见维度不等就 return 0（vectorMemory/index.js:201），
//        该条被 threshold 过滤掉 —— 这条记忆**永久搜不到**，且没有任何提示；
//     ③ 它不会自愈：indexMessages 的重新嵌入判据是「无向量 / 空向量 / signature 变化」，
//        而这条有向量、signature 也没变。
//
// 修法：维度不一致就**当作没取到**（保持 vector 为空）并留痕。空向量会被
// indexMessages 认成「需要重新嵌入」⇒ 真正自愈，而不是把坏数据当好的用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { encodeVector, vectorShardKey, vectorShardIndex } from '../src/storage/vectorCodec.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const PRESET_ENV = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');
const vectorPath = path.join(SRC_DIR, 'storage', 'vector.js');

const diagnostics = [];

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(key) { return map.has(key) ? map.get(key) : null; },
    async setItem(key, value) { map.set(key, String(value)); },
    async removeItem(key) { map.delete(key); },
    async getAllKeys() { return [...map.keys()]; },
    async multiRemove(keys) { (keys || []).forEach(k => map.delete(k)); },
  };
}

const transpiled = new Map();
function compileToCjs(absPath) {
  if (transpiled.has(absPath)) return transpiled.get(absPath);
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false, configFile: false, filename: absPath,
    presets: [[PRESET_ENV, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  transpiled.set(absPath, code);
  return code;
}

function loadVector(storage) {
  const originalLoad = Module._load;
  const mainCode = compileToCjs(vectorPath);
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') {
      return { __esModule: true, default: storage };
    }
    if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js') {
      return {
        __esModule: true,
        recordDiagnostic: (kind, error, ctx) => diagnostics.push({ kind, msg: String((error && error.message) || error), ctx }),
      };
    }
    if (request === 'expo-file-system/legacy' || request === 'expo-file-system') {
      return { __esModule: true, documentDirectory: 'file:///doc/', getInfoAsync: async () => ({ exists: false }) };
    }
    if (request === 'expo-sqlite') return { __esModule: true, openDatabaseSync: () => null };
    if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
      return { __esModule: true, tActive: key => String(key) };
    }
    if (parent && parent.filename && request.startsWith('.')) {
      const base = path.resolve(path.dirname(parent.filename), request);
      for (const candidate of [base, `${base}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const mod = new Module(candidate);
          mod.filename = candidate;
          mod.paths = Module._nodeModulePaths(path.dirname(candidate));
          mod._compile(compileToCjs(candidate), candidate);
          return mod.exports;
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const key of Object.keys(Module._cache)) {
      if (key.startsWith(`${SRC_DIR}${path.sep}`)) delete Module._cache[key];
    }
    const mod = new Module(vectorPath);
    mod.filename = vectorPath;
    mod.paths = Module._nodeModulePaths(path.dirname(vectorPath));
    mod._compile(mainCode, vectorPath);
    return mod.exports;
  } finally {
    Module._load = originalLoad;
  }
}

// 分片的分段键格式是 `${sessionId}\u0000${id}`（不是 `sessionId::messageId`）——
// 第一版按 messageId 拼键，结果分片里根本找不到这条，测试失败而代码没问题。
function segmentKeyOf(sessionId, id) {
  return `${sessionId}\u0000${id}`;
}

// 造一个「元数据说 8 维、分片里只有 4 维」的索引（模拟截断）。
function seedMismatch(dimInMeta, actualLen) {
  const segment = {
    id: 'id-1', messageId: 'm1', sessionId: 's1', role: 'user',
    at: 1700000000000, text: 'hello', signature: 'sig-1',
  };
  const segKey = segmentKeyOf('s1', 'id-1');
  const shard = vectorShardIndex(segKey);
  const packed = encodeVector(Array.from({ length: actualLen }, (_, i) => Math.fround(i / 10)));
  return {
    [`@easychat2_vector_index::c1`]: JSON.stringify([{ ...segment, dim: dimInMeta }]),
    [vectorShardKey('c1', shard)]: JSON.stringify({ [segKey]: packed }),
    segKey,
  };
}

test.beforeEach(() => { diagnostics.length = 0; });

test('维度不符：不得采用错误长度的向量（否则检索静默失忆）', async () => {
  const initial = seedMismatch(8, 4);
  const storage = makeStorage(initial);
  const vector = loadVector(storage);
  const status = await vector.readVectorIndexStatus('c1');
  assert.equal(status.status, 'ok');
  assert.equal(status.index.length, 1);
  // 核心：向量必须**没被取回**（保持空），而不是被填成 4 维。
  assert.deepEqual(status.index[0].vector, [], '维度不符时不得采用该向量');
  // dim 保持元数据声明的 8（不能被静默改写成 4）。
  assert.equal(status.index[0].dim, 8, 'dim 必须保持元数据声明值');
  const hits = diagnostics.filter(d => /vectorDimMismatch/.test(d.msg));
  assert.equal(hits.length, 1, '必须留一条维度不一致的诊断（此前完全静默）');
  assert.match(hits[0].ctx, /实际 4 维 != 元数据 8 维/, '诊断要说清两边各是多少维');
});

test('自愈：空向量会被重新嵌入判据认出来（不是死循环）', async () => {
  // indexMessages 的判据是「无向量 / 空向量 / signature 变化」。维度不符时我们留下
  // 空向量 ⇒ 恰好命中「空向量」这条 ⇒ 下一条消息落盘时它会被重新嵌入。
  // 这里直接断言该判据的形状（不引 vectorMemory 以免拖入网络栈）。
  const source = fs.readFileSync(path.join(SRC_DIR, 'vectorMemory', 'index.js'), 'utf8');
  assert.ok(
    /item\.vector\.length === 0/.test(source),
    'indexMessages 必须以「空向量」为重新嵌入判据之一（否则自愈路径不成立）'
  );
});

test('对照：维度一致时正常取回（护栏不能误伤正常路径）', async () => {
  const initial = seedMismatch(4, 4);
  const storage = makeStorage(initial);
  const vector = loadVector(storage);
  const status = await vector.readVectorIndexStatus('c1');
  assert.equal(status.index[0].vector.length, 4, '维度一致必须正常取回');
  assert.equal(diagnostics.filter(d => /vectorDimMismatch/.test(d.msg)).length, 0, '正常路径不该报');
});

test('对照：分片里没有这一条时保持空向量且不报维度问题', async () => {
  const segment = {
    id: 'id-1', messageId: 'm1', sessionId: 's1', role: 'user',
    at: 1700000000000, text: 'hello', signature: 'sig-1',
  };
  const shard = vectorShardIndex(segmentKeyOf('s1', 'id-1'));
  const storage = makeStorage({
    '@easychat2_vector_index::c1': JSON.stringify([{ ...segment, dim: 8 }]),
    // 分片存在但里面没有这个分段（正常：还没嵌入）
    [vectorShardKey('c1', shard)]: JSON.stringify({}),
  });
  const vector = loadVector(storage);
  const status = await vector.readVectorIndexStatus('c1');
  assert.deepEqual(status.index[0].vector, []);
  assert.equal(
    diagnostics.filter(d => /vectorDimMismatch/.test(d.msg)).length,
    0,
    '「还没嵌入」不是维度问题，不该误报'
  );
});