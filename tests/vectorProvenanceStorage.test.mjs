// 向量索引的溯源字段往返：普通记忆标记来源类型，AI 合并记忆保住合并前的快照。
// 这条不能只靠源码断言——快照丢了证据链就断了，必须真的写盘再读回来验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
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
  backupCorruptValue: async () => {},
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

test('向量索引：普通记忆标记为 message，合并记忆保住合并来源快照', async () => {
  store.clear();
  await vector.saveVectorIndex('char-1', [
    { id: 'seg-1', sessionId: 's1', messageId: 'm1', text: '用户：我喜欢猫', vector: [1, 0], signature: 'sig' },
    {
      id: 'merged-1',
      sessionId: 's2',
      text: '用户对猫的喜好从喜欢变成了讨厌',
      vector: [0, 1],
      signature: 'sig',
      origin: 'merged',
      mergedFrom: [
        { id: 'seg-a', sessionId: 's1', messageId: 'm1', text: '用户：我喜欢猫', at: 10 },
        { id: 'seg-b', sessionId: 's2', messageId: 'm9', text: '用户：我讨厌猫', at: 20 },
      ],
    },
  ]);

  const index = await vector.getVectorIndex('char-1');
  const plain = index.find(item => item.id === 'seg-1');
  const merged = index.find(item => item.id === 'merged-1');

  assert.equal(plain.origin, 'message', '普通记忆的来源类型是消息');
  assert.deepEqual(plain.mergedFrom, [], '普通记忆没有合并来源');

  assert.equal(merged.origin, 'merged');
  assert.deepEqual(
    merged.mergedFrom.map(item => item.text),
    ['用户：我喜欢猫', '用户：我讨厌猫'],
    '合并来源快照必须完整保住，否则合并后证据链就断了'
  );
  assert.deepEqual(merged.mergedFrom.map(item => item.sessionId), ['s1', 's2']);
  assert.equal(merged.mergedFrom[1].messageId, 'm9', '快照保留原始消息 id，仍可回到原消息');
});

test('向量索引：合并来源里缺 id 的脏快照被丢弃，不落空壳条目', async () => {
  store.clear();
  await vector.saveVectorIndex('char-2', [{
    id: 'merged-2',
    sessionId: 's1',
    text: '合并记忆',
    vector: [1],
    signature: 'sig',
    origin: 'merged',
    mergedFrom: [
      { sessionId: 's1', text: '没有 id 的脏数据' },
      { id: 'ok', sessionId: 's1', text: '有效快照', at: 5 },
      null,
    ],
  }]);
  const [item] = await vector.getVectorIndex('char-2');
  assert.equal(item.mergedFrom.length, 1);
  assert.equal(item.mergedFrom[0].id, 'ok');
});

test('向量索引：历史数据没有溯源字段时按普通记忆归一，不出现 undefined', async () => {
  store.clear();
  await vector.saveVectorIndex('char-3', [
    { id: 'legacy', sessionId: 's1', messageId: 'm1', text: '旧索引条目', vector: [1] },
  ]);
  const [item] = await vector.getVectorIndex('char-3');
  assert.equal(item.origin, 'message');
  assert.deepEqual(item.mergedFrom, []);
});
