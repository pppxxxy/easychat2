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
const failedGets = new Set();
const failedSets = new Set();
const failedRemoves = new Set();

const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => {
    if (failedSets.has(key)) throw new Error(`write failed: ${key}`);
    store.set(key, value);
  },
  removeItem: async key => {
    if (failedRemoves.has(key)) throw new Error(`remove failed: ${key}`);
    store.delete(key);
  },
  getAllKeys: async () => [...store.keys()],
};

// localModels.js 只依赖 io.js 的读原语；这里打桩 io，避免拉起 secretStore/diagnostics。
const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  readJsonStatus: async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  // 设置键走保险箱读写；测试环境 SecureStore 不可用，此处透明转发为明文，
  // 断言仍可读取到原始 JSON。
  readJsonWithSecrets: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  setJsonWithSecrets: async (key, payload) => {
    await AsyncStorage.setItem(key, JSON.stringify(payload));
  },
  backupCorruptValue: async key => {
    const raw = store.get(key);
    if (raw) store.set(`${key}__corrupt_backup`, raw);
    return Boolean(raw);
  },
};

const storageModulePath = path.resolve('src/storage/localModels.js');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === './io.js' && parent && parent.filename === storageModulePath) return ioStub;
  return originalLoad.call(this, request, parent, isMain);
};

function loadModule() {
  const code = babel.transformSync(fs.readFileSync(storageModulePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: storageModulePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(storageModulePath);
  mod.filename = storageModulePath;
  mod.paths = Module._nodeModulePaths(path.dirname(storageModulePath));
  mod._compile(code, storageModulePath);
  return mod.exports;
}

const storage = loadModule();

const SETTINGS_KEY = '@easychat2_local_model';
const INDEX_KEY = '@easychat2_local_model_index';
const ITEM_PREFIX = '@easychat2_local_model_item';
const itemKey = id => `${ITEM_PREFIX}::${id}`;

function reset() {
  store.clear();
  failedGets.clear();
  failedSets.clear();
  failedRemoves.clear();
}

function readIndex() {
  return JSON.parse(store.get(INDEX_KEY));
}

test('saveLocalModelItem：写条目 + 写索引，索引只含轻量条目', async () => {
  reset();
  const saved = await storage.saveLocalModelItem({
    id: 'qwen-q4',
    name: 'Qwen Q4',
    quant: 'Q4_K_M',
    modelBytes: 2048,
    modelPath: 'file:///documents/local-models/qwen-q4.gguf',
    params: { contextSize: 4096 },
  });
  assert.ok(saved.createdAt > 0);
  assert.equal(saved.updatedAt, saved.createdAt);
  const item = await storage.getLocalModelItem('qwen-q4');
  assert.equal(item.params.contextSize, 4096);
  assert.equal(item.modelPath, 'file:///documents/local-models/qwen-q4.gguf');
  const index = readIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].id, 'qwen-q4');
  assert.equal(index[0].quant, 'Q4_K_M');
  assert.equal('modelPath' in index[0], false);
});

test('saveLocalModelItem：同 id 覆盖不产生重复索引项', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  await storage.saveLocalModelItem({ id: 'm1', name: 'B' });
  const index = readIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].name, 'B');
});

test('deleteLocalModelItem：级联删除条目、索引项并清空活动指针', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  await storage.saveLocalModelItem({ id: 'm2', name: 'B' });
  await storage.saveLocalModelSettings({ enabled: true, activeModelId: 'm1' });
  const remaining = await storage.deleteLocalModelItem('m1');
  assert.deepEqual(remaining.map(entry => entry.id), ['m2']);
  assert.equal(store.has(itemKey('m1')), false);
  const settings = await storage.getLocalModelSettings();
  assert.equal(settings.activeModelId, '');
  assert.equal(await storage.getActiveLocalModel(), null);
});

test('getLocalModelIndex：旧单模型设置迁移成条目并回填 activeModelId', async () => {
  reset();
  store.set(SETTINGS_KEY, JSON.stringify({
    enabled: true,
    modelId: 'legacy',
    modelName: 'Legacy',
    modelPath: 'file:///documents/local-models/legacy.gguf',
    modelBytes: 10,
    contextSize: 4096,
    updatedAt: 5,
  }));
  const index = await storage.getLocalModelIndex();
  assert.deepEqual(index.map(entry => entry.id), ['legacy']);
  const item = await storage.getLocalModelItem('legacy');
  assert.equal(item.params.contextSize, 4096);
  const settings = await storage.getLocalModelSettings();
  assert.equal(settings.activeModelId, 'legacy');
  assert.equal(settings.modelPath, 'file:///documents/local-models/legacy.gguf');
});

test('getLocalModelIndex：无旧模型时返回空且不写入条目', async () => {
  reset();
  assert.deepEqual(await storage.getLocalModelIndex(), []);
  assert.equal([...store.keys()].some(key => key.startsWith(`${ITEM_PREFIX}::`)), false);
});

test('getLocalModelIndex：索引损坏时备份并从条目键重建', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  store.set(INDEX_KEY, 'not-json');
  const index = await storage.getLocalModelIndex();
  assert.deepEqual(index.map(entry => entry.id), ['m1']);
  assert.equal(store.has(`${INDEX_KEY}__corrupt_backup`), true);
  assert.deepEqual(readIndex().map(entry => entry.id), ['m1']);
});

test('saveLocalModelItem：索引写失败时回滚已写入的条目', async () => {
  reset();
  failedSets.add(INDEX_KEY);
  await assert.rejects(
    () => storage.saveLocalModelItem({ id: 'm1', name: 'A' }),
    /write failed/
  );
  assert.equal(store.has(itemKey('m1')), false);
  assert.equal(store.has(INDEX_KEY), false);
});

test('getActiveLocalModel：无活动模型时返回 null', async () => {
  reset();
  assert.equal(await storage.getActiveLocalModel(), null);
});

test('活动模型指针：切换 activeModelId 后 getActiveLocalModel 指向新模型', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A' });
  await storage.saveLocalModelItem({ id: 'm2', name: 'B' });
  await storage.saveLocalModelSettings({ enabled: true, activeModelId: 'm1' });
  assert.equal((await storage.getActiveLocalModel()).id, 'm1');
  const current = await storage.getLocalModelSettings();
  await storage.saveLocalModelSettings({ ...current, activeModelId: 'm2' });
  assert.equal((await storage.getActiveLocalModel()).id, 'm2');
});

test('参数隔离：保存一个模型的参数不影响其他模型', async () => {
  reset();
  await storage.saveLocalModelItem({ id: 'm1', name: 'A', params: { contextSize: 4096, temperature: 0.7 } });
  await storage.saveLocalModelItem({ id: 'm2', name: 'B', params: { contextSize: 2048 } });
  const first = await storage.getLocalModelItem('m1');
  assert.equal(first.params.contextSize, 4096);
  assert.equal(first.params.temperature, 0.7);
  assert.equal((await storage.getLocalModelItem('m2')).params.contextSize, 2048);
  await storage.saveLocalModelItem({ ...first, params: { ...first.params, contextSize: 8192 } });
  assert.equal((await storage.getLocalModelItem('m1')).params.contextSize, 8192);
  assert.equal((await storage.getLocalModelItem('m2')).params.contextSize, 2048);
});

test('本地模型设置走保险箱读写：apiServer.apiKey 经 WithSecrets 入口不落裸 JSON', async () => {
  reset();
  const seen = [];
  const originalSet = ioStub.setJsonWithSecrets;
  ioStub.setJsonWithSecrets = async (key, payload) => {
    seen.push(key);
    await originalSet(key, payload);
  };
  try {
    await storage.saveLocalModelSettings({ apiServer: { enabled: true, apiKey: 'local-secret-123456' } });
    const saved = await storage.getLocalModelSettings();
    assert.equal(saved.apiServer.apiKey, 'local-secret-123456');
    assert.ok(seen.includes(SETTINGS_KEY), '设置键应经 setJsonWithSecrets 写入');
  } finally {
    ioStub.setJsonWithSecrets = originalSet;
  }
});
