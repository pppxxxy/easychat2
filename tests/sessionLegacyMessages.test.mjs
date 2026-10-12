// 旧版「按角色 id 分键」消息的读取与迁移取值测试（回归：读失败被静默当成「没有旧对话」）。
//
// 问题：readLegacyMessages 以前用 readJson(key, null)：读失败 → null → []，
// 而迁移循环看到 messages.length === 0 就 continue（既不迁移、也不删源键），
// 于是用户的旧对话变成一个既看不见也删不掉的孤儿；反过来若把「读不到」当成
// 「已迁完」，源键就会被 removeItem 误删（迁移路径会删源，见 migration.js:88-94）。
//
// 这个文件立的规矩与 sessionDeleteCleanup.test.mjs 一致：**加载真实现**
// （sessionList/mutations + sessionList/migration + sessionCore + io），
// 只把 AsyncStorage / FileSystem / i18n 三个边界换成内存替身；键名由生产代码决定
// （messagesKey / LEGACY_MESSAGES_KEY），测试只断言「读不到时是否明确失败、源键还在不在」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

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

const store = new Map();
// 「读会抛错」的键：AsyncStorage.getItem 直接抛（Android 上超 CursorWindow 上限、
// SAF/权限失败都是这个形态），readJsonStatus 据此判 corrupt。
const failedGets = new Set();
const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => { store.set(key, String(value)); },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { (Array.isArray(keys) ? keys : []).forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  // i18n 只用到 tActive（错误码）：返回键名，便于按 key 断言。
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  // 角色域与本次要验的键无关（迁移只取 DEFAULT_CHARACTER 判「更老的整键」回退）。
  if (request.endsWith('/characters.js') || request.endsWith('/characters/shared.js')) {
    return {
      __esModule: true,
      DEFAULT_CHARACTER: { id: 'default' },
      getCharacterLibrary: async () => [],
      saveCharacterLibrary: async () => {},
    };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const { readLegacyMessages } = loadModule(path.resolve('src/storage/sessionList/mutations.js'));
const { migrateLegacyMessages } = loadModule(path.resolve('src/storage/sessionList/migration.js'));
const { LEGACY_MESSAGES_KEY, SESSIONS_KEY, messagesKey, saveSessionsInternal } = loadModule(
  path.resolve('src/storage/sessionCore.js')
);

const READ_FAILED = /error\.storage\.legacyMessagesReadFailed/;
const MESSAGES = [{ id: 'm1', role: 'user', text: '旧消息', timestamp: 1 }];

test('旧版消息读取：读抛错时明确失败，不返回空数组，源键原样保留', async () => {
  store.clear();
  failedGets.clear();
  const key = messagesKey('char-a');
  store.set(key, JSON.stringify(MESSAGES));
  const before = store.get(key);

  failedGets.add(key);
  await assert.rejects(
    () => readLegacyMessages('char-a'),
    READ_FAILED,
    '读不到不得被当成「这个角色没有旧对话」'
  );
  assert.equal(store.get(key), before, '读失败不得改动源键');
  failedGets.delete(key);

  // 读得回来时行为不变（pending 条目仍被过滤）
  store.set(key, JSON.stringify([...MESSAGES, { id: 'p1', role: 'user', text: '半截', pending: true }]));
  assert.deepEqual((await readLegacyMessages('char-a')).map(item => item.id), ['m1']);
});

test('旧版消息读取：键不存在返回空数组——「没有」与「读不到」必须区分', async () => {
  store.clear();
  failedGets.clear();
  assert.deepEqual(await readLegacyMessages('char-none'), []);
});

test('旧版消息读取：默认角色回退到更老的整键；整键读不到时同样明确失败', async () => {
  store.clear();
  failedGets.clear();
  store.set(LEGACY_MESSAGES_KEY, JSON.stringify([{ id: 'legacy-1', role: 'user', text: '更老的消息', timestamp: 2 }]));
  assert.deepEqual((await readLegacyMessages('default')).map(item => item.id), ['legacy-1']);

  const before = store.get(LEGACY_MESSAGES_KEY);
  failedGets.add(LEGACY_MESSAGES_KEY);
  await assert.rejects(() => readLegacyMessages('default'), READ_FAILED, '整键读不到也要明确失败');
  assert.equal(store.get(LEGACY_MESSAGES_KEY), before, '读失败不得改动源键');
  failedGets.delete(LEGACY_MESSAGES_KEY);

  // 非默认角色不看整键：主键没有就是「没有旧对话」
  assert.deepEqual(await readLegacyMessages('char-b'), []);
});

test('迁移：源键读不到时跳过该角色（不迁移、也不删源键，下次启动还能重试）', async () => {
  store.clear();
  failedGets.clear();
  await saveSessionsInternal([]);
  const key = messagesKey('char-a');
  store.set(key, JSON.stringify(MESSAGES));
  const before = store.get(key);

  failedGets.add(key);
  const migrated = await migrateLegacyMessages([{ id: 'char-a' }]);
  assert.deepEqual(migrated, [], '读不到就不迁移');
  assert.equal(store.get(key), before, '没迁成就绝不能删源键（否则旧对话永久消失）');
  assert.deepEqual(JSON.parse(store.get(SESSIONS_KEY)), [], '不得凭空写入会话行');
  failedGets.delete(key);

  // 读得回来时照常迁移，并且迁完删源键
  const ok = await migrateLegacyMessages([{ id: 'char-a' }]);
  assert.equal(ok.length, 1);
  assert.equal(store.has(key), false, '迁移成功才删源键');
  assert.equal(JSON.parse(store.get(SESSIONS_KEY)).length, 1);
});
