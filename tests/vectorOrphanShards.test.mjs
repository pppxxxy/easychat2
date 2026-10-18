// M3：孤儿向量分片的发现与清理（隐私残留）。
//
// 问题（审核助手指出，已核实属实）：
//   向量分片键 `@easychat2_vector_shard::<角色>::<片号>` 此前**不在任何扫描范围内**：
//     · 快速导出按前缀白名单挑键（dataBackup.js 的 QUICK_EXPORT_PREFIXES），分片不在其中；
//     · 向量对账只扫 `@easychat2_vector_index::` 元数据键，分片完全不在视野内。
//   后果：「清空向量记忆 / 删角色」若中途失败（或历史版本 `.catch(() => {})` 吞错），
//   分片会永久留在盘上。用户以为记忆已删干净，而整份 embedding（可还原语义）仍在。
//
// 本文件钉四件事：
//   ① parseVectorShardKey 的逆运算正确，且**认不出的键不猜**（猜错会误删别人的分片）；
//   ② listOrphanVectorShards 只报「元数据不存在」的角色的分片；
//   ③ purgeOrphanVectorShards 真的删掉，且删除失败要报出来；
//   ④ clearVectorIndex 的顺序是「先删分片、后删元数据」（失败时不留内容）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  VECTOR_SHARD_COUNT,
  VECTOR_SHARD_PREFIX,
  parseVectorShardKey,
  vectorShardKey,
} from '../src/storage/vectorCodec.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const PRESET_ENV = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');
const vectorPath = path.join(SRC_DIR, 'storage', 'vector.js');

// ---- ① 纯函数：分片键的逆运算 ----

test('parseVectorShardKey：与 vectorShardKey 互逆', () => {
  for (const characterId of ['c1', 'default', 'char-with-dash', '角色id']) {
    for (const shard of [0, 7, VECTOR_SHARD_COUNT - 1]) {
      const key = vectorShardKey(characterId, shard);
      assert.deepEqual(parseVectorShardKey(key), { characterId, shard });
    }
  }
});

test('parseVectorShardKey：认不出的键一律返回 null（绝不猜片号）', () => {
  assert.equal(parseVectorShardKey(''), null);
  assert.equal(parseVectorShardKey(null), null);
  assert.equal(parseVectorShardKey('@easychat2_vector_index::c1'), null, '元数据键不是分片键');
  assert.equal(parseVectorShardKey(`${VECTOR_SHARD_PREFIX}::c1`), null, '缺片号');
  assert.equal(parseVectorShardKey(`${VECTOR_SHARD_PREFIX}::::0`), null, '缺角色 id');
  assert.equal(parseVectorShardKey(`${VECTOR_SHARD_PREFIX}::c1::abc`), null, '片号非数字');
  assert.equal(parseVectorShardKey(`${VECTOR_SHARD_PREFIX}::c1::${VECTOR_SHARD_COUNT}`), null, '片号越界');
  assert.equal(parseVectorShardKey(`${VECTOR_SHARD_PREFIX}::c1::-1`), null, '负片号');
});

test('parseVectorShardKey：角色 id 含 :: 时从右侧切分（不误判）', () => {
  const key = `${VECTOR_SHARD_PREFIX}::weird::id::5`;
  assert.deepEqual(parseVectorShardKey(key), { characterId: 'weird::id', shard: 5 });
});

// ---- ②③④ 走真 vector.js（打桩 AsyncStorage） ----

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const failRemove = new Set();
  return {
    map,
    failRemove,
    async getItem(key) { return map.has(key) ? map.get(key) : null; },
    async setItem(key, value) { map.set(key, String(value)); },
    async removeItem(key) {
      if (failRemove.has(key)) throw new Error(`remove failed: ${key}`);
      map.delete(key);
    },
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
  const mainCode = compileToCjs(vectorPath); // 必须在装桩前转译（babel 会 require 自身依赖）
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') {
      return { __esModule: true, default: storage };
    }
    if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js') {
      return { __esModule: true, recordDiagnostic: () => {} };
    }
    // io.js 顶层 import 了 expo-file-system/legacy（大值兜底用），必须给个桩。
    if (request === 'expo-file-system/legacy' || request === 'expo-file-system') {
      return {
        __esModule: true,
        documentDirectory: 'file:///doc/',
        getInfoAsync: async () => ({ exists: false }),
      };
    }
    if (request === 'expo-sqlite') {
      return { __esModule: true, openDatabaseSync: () => null };
    }
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

function metaKey(characterId) {
  return `@easychat2_vector_index::${characterId}`;
}

test('listOrphanVectorShards：元数据不存在的角色的分片才是孤儿', async () => {
  const storage = makeStorage();
  // 角色 alive：有元数据 → 分片不是孤儿
  storage.map.set(metaKey('alive'), JSON.stringify([{ sessionId: 's1', messageId: 'm1', dim: 4 }]));
  storage.map.set(vectorShardKey('alive', 0), JSON.stringify({ 's1::m1': 'AAAA' }));
  // 角色 ghost：没有元数据 → 分片是孤儿
  storage.map.set(vectorShardKey('ghost', 0), JSON.stringify({ 's2::m2': 'BBBB' }));
  storage.map.set(vectorShardKey('ghost', 3), JSON.stringify({ 's2::m3': 'CCCC' }));

  const vector = loadVector(storage);
  const result = await vector.listOrphanVectorShards();
  assert.equal(result.scanned, 3, '应扫到 3 个分片键');
  assert.equal(result.orphans.length, 2, '只有 ghost 的两片是孤儿');
  assert.ok(result.orphans.every(key => key.includes('ghost')));
  assert.ok(!result.orphans.some(key => key.includes('alive')));
});

test('listOrphanVectorShards：元数据损坏时**不**当孤儿（否则读坏=向量全丢）', async () => {
  const storage = makeStorage();
  storage.map.set(metaKey('broken'), '{not valid json');
  storage.map.set(vectorShardKey('broken', 1), JSON.stringify({ 's::m': 'AAAA' }));
  const vector = loadVector(storage);
  const result = await vector.listOrphanVectorShards();
  assert.deepEqual(result.orphans, [], '元数据损坏必须保守当作「存在」，绝不误删');
});

test('listOrphanVectorShards：形状不符的键单独报出，不当孤儿删', async () => {
  const storage = makeStorage();
  storage.map.set(`${VECTOR_SHARD_PREFIX}::broken-shape`, 'x');
  const vector = loadVector(storage);
  const result = await vector.listOrphanVectorShards();
  assert.deepEqual(result.orphans, []);
  assert.equal(result.unknownKeys.length, 1, '认不出的键要单独可见，不能静默消失');
});

test('purgeOrphanVectorShards：真的删掉孤儿分片', async () => {
  const storage = makeStorage();
  storage.map.set(vectorShardKey('ghost', 0), JSON.stringify({ a: 'AAAA' }));
  storage.map.set(vectorShardKey('ghost', 1), JSON.stringify({ b: 'BBBB' }));
  storage.map.set(metaKey('alive'), JSON.stringify([]));
  storage.map.set(vectorShardKey('alive', 0), JSON.stringify({ c: 'CCCC' }));

  const vector = loadVector(storage);
  const result = await vector.purgeOrphanVectorShards();
  assert.equal(result.removed, 2);
  assert.equal(result.failed, 0);
  // 孤儿没了，有主的还在
  assert.equal(storage.map.has(vectorShardKey('ghost', 0)), false);
  assert.equal(storage.map.has(vectorShardKey('ghost', 1)), false);
  assert.equal(storage.map.has(vectorShardKey('alive', 0)), true, '有主的分片绝不能被删');
});

test('purgeOrphanVectorShards：删除失败要报出来（不静默成功）', async () => {
  const storage = makeStorage();
  const ghostKey = vectorShardKey('ghost', 0);
  storage.map.set(ghostKey, JSON.stringify({ a: 'AAAA' }));
  storage.failRemove.add(ghostKey);
  const vector = loadVector(storage);
  const result = await vector.purgeOrphanVectorShards();
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 1, '失败必须计入 failed，而不是假装删掉了');
  assert.equal(storage.map.has(ghostKey), true, '删失败时数据仍在（如实反映）');
});

test('clearVectorIndex：先删分片、后删元数据（失败时不留内容）', async () => {
  const storage = makeStorage();
  storage.map.set(metaKey('c1'), JSON.stringify([]));
  const shardKey = vectorShardKey('c1', 0);
  storage.map.set(shardKey, JSON.stringify({ a: 'AAAA' }));
  // 让分片删除失败：此时元数据**必须还在**（否则分片成孤儿，内容永久残留）
  storage.failRemove.add(shardKey);

  const vector = loadVector(storage);
  await assert.rejects(() => vector.clearVectorIndex('c1'), /vectorShardClearFailed/);
  assert.equal(storage.map.has(shardKey), true, '分片没删掉');
  assert.equal(
    storage.map.has(metaKey('c1')),
    true,
    '元数据必须还在——先删元数据会让分片变成永久孤儿（旧实现的缺陷）'
  );
});

test('clearVectorIndex：全部删成功后元数据与分片都不在', async () => {
  const storage = makeStorage();
  storage.map.set(metaKey('c2'), JSON.stringify([]));
  for (const shard of [0, 5, 31]) {
    storage.map.set(vectorShardKey('c2', shard), JSON.stringify({ x: 'AAAA' }));
  }
  const vector = loadVector(storage);
  await vector.clearVectorIndex('c2');
  assert.equal(storage.map.has(metaKey('c2')), false);
  assert.equal(storage.map.has(vectorShardKey('c2', 0)), false);
  assert.equal(storage.map.has(vectorShardKey('c2', 5)), false);
  assert.equal(storage.map.has(vectorShardKey('c2', 31)), false);
});

test('接线：对账流程会调用孤儿分片清理', () => {
  const source = fs.readFileSync(
    path.join(SRC_DIR, 'storage', 'sessionList', 'vectorReconcile.js'),
    'utf8'
  );
  assert.ok(source.includes('purgeOrphanVectorShards'), '对账必须接上孤儿清理（否则分片永不被扫）');
  assert.ok(
    /report\.orphanShardsRemoved/.test(source),
    '清理结果要进 report，便于诊断与测试观察'
  );
  // 清理失败不得把整次对账判成失败（对账本身已经完成）。
  assert.ok(/catch[\s\S]{0,200}orphanShardsFailed/.test(source), '孤儿清理失败要单独兜住');
});
