// 阅读器设置（翻页方式）测试：注入 AsyncStorage 与 io 桩（沿用 musicPlaylists.test.mjs 机制），
// 验证三档合法值、非法值回退、读写往返与读取失败不抛。

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
  multiSet: async entries => { entries.forEach(([key, value]) => store.set(key, value)); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
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
  createMutationQueue: () => {
    let single = Promise.resolve();
    return {
      enqueue(task) { const next = single.then(task, task); single = next.catch(() => {}); return next; },
      settle() { return single.catch(() => {}); },
    };
  },
  CORRUPT_BACKUP_SUFFIX: '__corrupt_backup',
  backupCorruptValue: async () => {},
};

const moduleCache = new Map();

function loadSourceModule(relativePath) {
  const sourcePath = path.resolve(relativePath);
  if (moduleCache.has(sourcePath)) return moduleCache.get(sourcePath);

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
    if (request.startsWith('.') && parent && parent.filename) {
      const base = path.resolve(path.dirname(parent.filename), request);
      const candidate = fs.existsSync(base) ? base : `${base}.js`;
      if (fs.existsSync(candidate)) return loadSourceModule(candidate);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const runtime = new Module(sourcePath);
    runtime.filename = sourcePath;
    runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    runtime._compile(transformed, sourcePath);
    moduleCache.set(sourcePath, runtime.exports);
    return runtime.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const settings = loadSourceModule('src/books/readerSettings.js');
const KEY = '@easychat2_book_reader';

test('阅读器设置：非法/缺省值一律回退 tap', () => {
  assert.equal(settings.normalizeBookReaderSettings(null).pageTurn, 'tap');
  assert.equal(settings.normalizeBookReaderSettings({}).pageTurn, 'tap');
  assert.equal(settings.normalizeBookReaderSettings({ pageTurn: 'nope' }).pageTurn, 'tap');
  assert.equal(settings.normalizeBookReaderSettings({ pageTurn: 'slide' }).pageTurn, 'slide');
  assert.equal(settings.normalizeBookReaderSettings({ pageTurn: 'curl' }).pageTurn, 'curl');
  assert.deepEqual(settings.PAGE_TURN_MODES, ['tap', 'slide', 'curl', 'fade']);
  // 四档都要能往返（旧值 'curl' 仍然有效——改名只动文案，没动 key）
  assert.equal(settings.normalizeBookReaderSettings({ pageTurn: 'fade' }).pageTurn, 'fade');
});

test('阅读器设置：首次读取（无键）返回默认，写入后往返一致', async () => {
  store.clear();
  assert.equal((await settings.getBookReaderSettings()).pageTurn, 'tap');

  const saved = await settings.saveBookReaderSettings({ pageTurn: 'curl' });
  assert.equal(saved.pageTurn, 'curl');
  assert.equal((await settings.getBookReaderSettings()).pageTurn, 'curl');

  // 再存别的模式：patch 语义（读旧值合并），不是整体覆盖
  await settings.saveBookReaderSettings({ pageTurn: 'slide' });
  assert.equal((await settings.getBookReaderSettings()).pageTurn, 'slide');
});

test('阅读器设置：存储损坏时读取回退默认而不抛错（阅读不被设置读失败阻断）', async () => {
  store.clear();
  store.set(KEY, '{ not json');
  const loaded = await settings.getBookReaderSettings();
  assert.equal(loaded.pageTurn, 'tap');

  const saved = await settings.saveBookReaderSettings({ pageTurn: 'curl' });
  assert.equal(saved.pageTurn, 'curl');
  assert.equal((await settings.getBookReaderSettings()).pageTurn, 'curl');
});
