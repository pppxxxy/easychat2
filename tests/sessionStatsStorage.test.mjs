// 本会话统计存储域：往返 / 分区 / 清空 / 分区上限（AsyncStorage + io 双重桩）。
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
const ioStub = {
  readJson: async key => {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  },
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
  readJsonStatus: async () => ({ status: 'missing' }),
  readJsonStatusWithSecrets: async () => ({ status: 'missing' }),
  setJsonWithSecrets: async () => {},
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

const sessionStats = loadSourceModule('src/storage/sessionStats.js');

test('统计存储：按会话分区往返，互不影响', async () => {
  store.clear();
  const empty = await sessionStats.getSessionStats('s1');
  assert.equal(empty.requests, 0, '没有记录返回空统计');

  await sessionStats.recordSessionRequest('s1', {
    configId: 'cfg-a', configLabel: 'A', model: 'm1', promptTokens: 100, completionTokens: 20,
    firstTokenMs: 300, generationMs: 3000, at: 10,
  });
  await sessionStats.recordSessionRequest('s1', {
    configId: 'cfg-b', configLabel: 'B', model: 'm2', promptTokens: 50, completionTokens: 10,
    firstTokenMs: 500, generationMs: 1000, at: 20,
  });
  const s1 = await sessionStats.getSessionStats('s1');
  assert.equal(s1.requests, 2);
  assert.equal(s1.promptTokens, 150);
  assert.deepEqual(Object.keys(s1.groups).sort(), ['cfg-a', 'cfg-b']);

  assert.equal((await sessionStats.getSessionStats('s2')).requests, 0, '会话之间互不影响');
  assert.equal((await sessionStats.getSessionStats('')).requests, 0, '空 id 返回空统计');
});

test('统计存储：清空只清该会话', async () => {
  store.clear();
  await sessionStats.recordSessionRequest('a', { configId: 'c', completionTokens: 5, generationMs: 100, at: 1 });
  await sessionStats.recordSessionRequest('b', { configId: 'c', completionTokens: 5, generationMs: 100, at: 2 });

  assert.equal(await sessionStats.clearSessionStats('a'), true);
  assert.equal((await sessionStats.getSessionStats('a')).requests, 0);
  assert.equal((await sessionStats.getSessionStats('b')).requests, 1, '另一个会话不受影响');
  assert.equal(await sessionStats.clearSessionStats('missing'), false, '没有记录时返回 false');
});

test('统计存储：会话数超上限按最后活动淘汰最旧的', async () => {
  store.clear();
  const seed = {};
  for (let i = 0; i < sessionStats.SESSION_STATS_SESSION_LIMIT + 5; i += 1) {
    seed[`s${i}`] = { version: 1, requests: 1, failedRequests: 0, promptTokens: 0, completionTokens: 1, firstTokenMsSum: 0, firstTokenSamples: 0, generationMsSum: 1, groups: {}, firstAt: i + 1, lastAt: i + 1 };
  }
  await AsyncStorage.setItem(sessionStats.SESSION_STATS_KEY, JSON.stringify(seed));

  await sessionStats.recordSessionRequest('newest', { configId: 'c', completionTokens: 1, generationMs: 1, at: 9999 });
  const raw = JSON.parse(store.get(sessionStats.SESSION_STATS_KEY));
  const keys = Object.keys(raw);
  assert.equal(keys.length, sessionStats.SESSION_STATS_SESSION_LIMIT, '分区数收敛到上限');
  assert.ok(keys.includes('newest'), '新写入的保留');
  assert.ok(!keys.includes('s0'), '最旧的被淘汰');
  assert.ok(keys.includes(`s${sessionStats.SESSION_STATS_SESSION_LIMIT + 4}`), '最新的旧数据保留');
});

test('统计存储：坏 JSON 不崩（当作没有记录）', async () => {
  store.clear();
  await AsyncStorage.setItem(sessionStats.SESSION_STATS_KEY, '{ not json');
  const stats = await sessionStats.getSessionStats('x');
  assert.equal(stats.requests, 0);
});
