import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

// createMutationQueue 是 io.js 导出的纯工厂：各存储域用它统一串行化写入。
// io.js 顶层 import 原生/存储依赖，这里按既有约定用 Babel 转 CJS + 打桩加载。

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/storage/io.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const originalLoad = Module._load;
const ioStore = new Map();
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') {
    return {
      getItem: async key => (ioStore.has(key) ? ioStore.get(key) : null),
      setItem: async (key, value) => { ioStore.set(key, value); },
      removeItem: async key => { ioStore.delete(key); },
      getAllKeys: async () => [...ioStore.keys()],
    };
  }
  if (request === 'expo-file-system/legacy') return {};
  if (request.endsWith('/secretStore.js') || request === '../secretStore.js') {
    return { protectSecrets: async (_k, p) => p, hydrateSecrets: async (_k, p) => p };
  }
  if (request.endsWith('/diagnostics.js') || request === '../diagnostics.js') {
    return { recordDiagnostic: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadIo() {
  const mod = new Module(sourcePath);
  mod.filename = sourcePath;
  mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  mod._compile(transformed, sourcePath);
  return mod.exports;
}

const io = loadIo();

test('createMutationQueue：单队列严格串行，先入先出', async () => {
  const queue = io.createMutationQueue();
  const order = [];
  const first = queue.enqueue(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    order.push('first');
    return 1;
  });
  const second = queue.enqueue(async () => {
    order.push('second');
    return 2;
  });
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['first', 'second']);
});

test('createMutationQueue：前一个失败不阻塞后续任务', async () => {
  const queue = io.createMutationQueue();
  const first = queue.enqueue(async () => {
    throw new Error('boom');
  });
  const second = queue.enqueue(async () => 'ok');
  await assert.rejects(first, /boom/);
  assert.equal(await second, 'ok');
});

test('createMutationQueue：按 key 分桶，不同 key 互不阻塞', async () => {
  const queue = io.createMutationQueue();
  const order = [];
  let releaseA;
  const gateA = new Promise(resolve => { releaseA = resolve; });
  const a = queue.enqueue(async () => {
    await gateA;
    order.push('a');
    return 'a';
  }, 'bucket-a');
  const b = queue.enqueue(async () => {
    order.push('b');
    return 'b';
  }, 'bucket-b');
  // b 的桶与 a 不同，应立即完成，不必等 a 放行
  assert.equal(await b, 'b');
  assert.deepEqual(order, ['b']);
  releaseA();
  assert.equal(await a, 'a');
  assert.deepEqual(order, ['b', 'a']);
});

test('createMutationQueue：同 key 串行（后一个等前一个）', async () => {
  const queue = io.createMutationQueue();
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = queue.enqueue(async () => { await gate; order.push(1); }, 'k');
  const second = queue.enqueue(async () => { order.push(2); }, 'k');
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  await first;
  await second;
  assert.deepEqual(order, [1, 2]);
});

test('createMutationQueue：settle 等待全部挂起写入落定', async () => {
  const queue = io.createMutationQueue();
  let done = false;
  queue.enqueue(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    done = true;
  });
  queue.enqueue(async () => {}, 'another');
  await queue.settle();
  assert.equal(done, true);
});

test('createMutationQueue：无 key 走默认单队列，settle 容错已失败任务', async () => {
  const queue = io.createMutationQueue();
  // key 传空串/未传都进同一默认队列
  const first = queue.enqueue(async () => { throw new Error('fail'); }, '');
  const second = queue.enqueue(async () => 'after');
  await assert.rejects(first, /fail/);
  assert.equal(await second, 'after');
  // settle 不应因挂起任务失败而 reject
  await assert.doesNotReject(() => queue.settle());
});

test('io：含密钥读写包装与 SQLite 兜底在无原生环境下安全降级', async () => {
  // setJsonWithSecrets/readJsonWithSecrets 走 protect/hydrate（这里桩为透明）
  await io.setJsonWithSecrets('@easychat2_test_secret', { apiKey: 'plain' });
  const value = await io.readJsonWithSecrets('@easychat2_test_secret', null);
  assert.deepEqual(value, { apiKey: 'plain' });
  const status = await io.readJsonStatusWithSecrets('@easychat2_missing_key');
  assert.equal(status.status, 'missing');
  // expo-sqlite 不可用时 readLargeAsyncStorageValue 返回 null（不抛）
  assert.equal(await io.readLargeAsyncStorageValue('@easychat2_any'), null);
});
