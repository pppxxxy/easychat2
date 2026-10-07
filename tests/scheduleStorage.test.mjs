// 角色作息存储测试（P1）。加载真实现（storage/schedule.js + io + characterLifecycle），
// 在 AsyncStorage mock 上验证读写/清理/损坏兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const STORAGE_DIR = path.resolve('src/storage');
const CHAT_DIR = path.resolve('src/chat');
const store = new Map();

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

function loadModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/', EncodingType: {}, getInfoAsync: async () => ({ exists: false }) };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request.endsWith('/secretStore.js') || request.endsWith('/secretStore')) {
    return { __esModule: true, hydrateSecrets: value => value, protectSecrets: value => value };
  }
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if ((resolved.startsWith(`${STORAGE_DIR}${path.sep}`) || resolved.startsWith(`${CHAT_DIR}${path.sep}`))
      && fs.existsSync(resolved)) {
      return loadModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

function clearCache() {
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${STORAGE_DIR}${path.sep}`) || key.startsWith(`${CHAT_DIR}${path.sep}`)) {
      delete Module._cache[key];
    }
  });
}

function loadSchedule() {
  store.clear();
  clearCache();
  return loadModule(path.resolve('src/storage/schedule.js'));
}

test('saveCharacterSchedule / getCharacterSchedule：按角色持久化', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('c1', { enabled: true, wake: '06:30', workStart: '09:00', workEnd: '18:00', sleep: '23:30' });
  const got = await mod.getCharacterSchedule('c1');
  assert.equal(got.enabled, true);
  assert.equal(got.wake, '06:30');
  assert.equal(await mod.getCharacterSchedule('nope'), null);
});

test('saveCharacterSchedule：非法时间归一为默认', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('c2', { enabled: true, wake: '99:99' });
  const got = await mod.getCharacterSchedule('c2');
  assert.equal(got.wake, '07:00');
});

test('getAllCharacterSchedules：返回全部角色作息', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('a', { enabled: true });
  await mod.saveCharacterSchedule('b', { enabled: false });
  const all = await mod.getAllCharacterSchedules();
  assert.deepEqual(Object.keys(all).sort(), ['a', 'b']);
});

test('deleteCharacterSchedule：删除单个条目', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('a', { enabled: true });
  assert.equal(await mod.deleteCharacterSchedule('a'), true);
  assert.equal(await mod.getCharacterSchedule('a'), null);
  assert.equal(await mod.deleteCharacterSchedule('a'), false);
});

test('角色删除钩子：清理对应作息', async () => {
  const mod = loadSchedule();
  const lifecycle = loadModule(path.resolve('src/storage/characterLifecycle.js'));
  await mod.saveCharacterSchedule('keep', { enabled: true });
  await mod.saveCharacterSchedule('gone', { enabled: true });
  await lifecycle.runCharacterCleanup(['gone']);
  assert.equal(await mod.getCharacterSchedule('gone'), null);
  assert.ok(await mod.getCharacterSchedule('keep'), '未删除的角色保留');
});

test('损坏存储：备份原始值后按空处理', async () => {
  const mod = loadSchedule();
  store.set('@easychat2_character_schedules', '{not json');
  const all = await mod.getAllCharacterSchedules();
  assert.deepEqual(all, {});
  assert.ok(store.has('@easychat2_character_schedules__corrupt_backup'), '损坏值已备份');
});
