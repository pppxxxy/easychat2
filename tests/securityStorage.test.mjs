// 隐私安全存储测试：加载真实现（storage/security.js + io + characterLifecycle），
// 在 AsyncStorage mock 与内存版 SecureStore mock 上验证读写/校验/清理/损坏兜底。
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
const store = new Map();

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

// 内存版安全存储 mock：模拟 secretStore 的三个通用读写。
const secureValues = new Map();
const secretStoreMock = {
  __esModule: true,
  writeSecureValue: async (id, value) => { secureValues.set(String(id), String(value)); },
  readSecureValue: async id => (secureValues.has(String(id)) ? secureValues.get(String(id)) : ''),
  removeSecureValue: async id => { secureValues.delete(String(id)); },
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
  if (request.endsWith('/secretStore.js') || request.endsWith('/secretStore')) return secretStoreMock;
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (resolved.startsWith(`${STORAGE_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      return loadModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

function clearCache() {
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${STORAGE_DIR}${path.sep}`)) delete Module._cache[key];
  });
}

function loadSecurity() {
  store.clear();
  secureValues.clear();
  clearCache();
  return loadModule(path.resolve('src/storage/security.js'));
}

const KEY = '@easychat2_security';

test('normalizePin / isValidPin：只留数字并限长', () => {
  const mod = loadSecurity();
  assert.equal(mod.normalizePin('12a3b4'), '1234');
  assert.equal(mod.normalizePin('1234567890'), '12345678');
  assert.equal(mod.normalizePin(null), '');
  assert.equal(mod.isValidPin('123'), false, '低于下限无效');
  assert.equal(mod.isValidPin('1234'), true);
  assert.equal(mod.isValidPin('12345678'), true);
  assert.equal(mod.isValidPin('abcd'), false);
});

test('默认设置：应用锁关闭，离开后重新上锁默认开启', async () => {
  const mod = loadSecurity();
  const settings = await mod.getSecuritySettings();
  assert.equal(settings.appLock.enabled, false);
  assert.equal(settings.appLock.relockOnBackground, true);
  assert.deepEqual(settings.characterLocks, {});
});

test('saveAppLockSettings：局部更新不丢另一字段', async () => {
  const mod = loadSecurity();
  await mod.saveAppLockSettings({ enabled: true });
  let appLock = await mod.getAppLockSettings();
  assert.equal(appLock.enabled, true);
  assert.equal(appLock.relockOnBackground, true, '局部更新不该把 relock 归回默认');
  appLock = await mod.saveAppLockSettings({ relockOnBackground: false });
  assert.equal(appLock.enabled, true, '只改 relock 时 enabled 保留');
  assert.equal(appLock.relockOnBackground, false);
  const stored = JSON.parse(store.get(KEY));
  assert.equal(stored.appLock.enabled, true);
  assert.equal(stored.appLock.relockOnBackground, false);
});

test('setCharacterLock：密码落安全存储，名单落 AsyncStorage', async () => {
  const mod = loadSecurity();
  const ok = await mod.setCharacterLock('char-1', '2468');
  assert.equal(ok, true);
  assert.equal(await mod.isCharacterLocked('char-1'), true);
  assert.deepEqual(await mod.getCharacterLocks(), { 'char-1': true });
  // 密码本体不进 AsyncStorage 名单值
  assert.equal(JSON.stringify(JSON.parse(store.get(KEY))).includes('2468'), false);
  // 非法密码被拒
  assert.equal(await mod.setCharacterLock('char-2', '12'), false);
  assert.equal(await mod.isCharacterLocked('char-2'), false);
});

test('verifyCharacterPasscode：正确通过、错误拒绝、未上锁拒绝', async () => {
  const mod = loadSecurity();
  await mod.setCharacterLock('char-1', '2468');
  assert.equal(await mod.verifyCharacterPasscode('char-1', '2468'), true);
  assert.equal(await mod.verifyCharacterPasscode('char-1', '1357'), false);
  assert.equal(await mod.verifyCharacterPasscode('char-1', '24680'), false, '长度不同应拒绝');
  assert.equal(await mod.verifyCharacterPasscode('unknown', '2468'), false);
});

test('removeCharacterLock：删名单并清密码', async () => {
  const mod = loadSecurity();
  await mod.setCharacterLock('char-1', '2468');
  assert.equal(await mod.removeCharacterLock('char-1'), true);
  assert.equal(await mod.isCharacterLocked('char-1'), false);
  assert.equal(await mod.verifyCharacterPasscode('char-1', '2468'), false, '密码已清');
  assert.equal(await mod.removeCharacterLock('char-1'), false, '重复移除返回 false');
});

test('角色删除钩子：清理对应锁与密码', async () => {
  const mod = loadSecurity();
  const lifecycle = loadModule(path.resolve('src/storage/characterLifecycle.js'));
  await mod.setCharacterLock('keep', '1111');
  await mod.setCharacterLock('gone', '2222');
  await lifecycle.runCharacterCleanup(['gone']);
  assert.equal(await mod.isCharacterLocked('gone'), false);
  assert.equal(await mod.isCharacterLocked('keep'), true, '未删除的角色保留');
});

test('subscribes：保存后通知订阅者，退订后不再通知', async () => {
  const mod = loadSecurity();
  let calls = 0;
  const unsubscribe = mod.subscribeSecuritySettings(() => { calls += 1; });
  await mod.saveAppLockSettings({ enabled: true });
  assert.equal(calls, 1);
  unsubscribe();
  await mod.saveAppLockSettings({ enabled: false });
  assert.equal(calls, 1, '退订后不再通知');
});

test('损坏存储：备份原始值后按默认处理，不静默覆盖', async () => {
  const mod = loadSecurity();
  store.set(KEY, '{not json');
  const settings = await mod.getSecuritySettings();
  assert.deepEqual(settings.characterLocks, {});
  assert.equal(settings.appLock.enabled, false);
  assert.ok(store.has(`${KEY}__corrupt_backup`), '损坏值已备份');
  assert.equal(store.get(KEY), '{not json', '原值未被默认值覆盖');
});
