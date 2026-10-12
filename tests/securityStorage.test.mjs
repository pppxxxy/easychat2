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
  assert.equal(settings.status, mod.SECURITY_STATUS.MISSING, '键不存在 = missing（「没有锁」是事实）');
  assert.equal(settings.appLock.enabled, false);
  assert.equal(settings.appLock.relockOnBackground, true);
  assert.deepEqual(settings.characterLocks, {});
});

test('读取状态三态：ok / missing / unknown 必须能区分开', async () => {
  const mod = loadSecurity();
  // missing：全新安装
  assert.equal((await mod.getSecuritySettings()).status, mod.SECURITY_STATUS.MISSING);
  // ok：结构完好
  await mod.saveAppLockSettings({ enabled: true });
  const ok = await mod.getSecuritySettings();
  assert.equal(ok.status, mod.SECURITY_STATUS.OK);
  assert.equal(ok.appLock.enabled, true);
  // unknown：结构损坏。**关键**：不能退化成 ok/missing —— 那正是「损坏 = 未加锁」的 fail-open。
  store.set(KEY, '{not json');
  const broken = await mod.getSecuritySettings();
  assert.equal(broken.status, mod.SECURITY_STATUS.UNKNOWN);
  assert.notEqual(broken.status, mod.SECURITY_STATUS.OK);
  assert.notEqual(broken.status, mod.SECURITY_STATUS.MISSING);
});

// 第四态：**合法 JSON 但形状不是预期对象**。readJsonStatus 只保证 JSON.parse 成功
// （status === 'ok'），**不保证值是我们约定的对象**——null / 字符串 / 数字 / 数组都会
// 以 'ok' 返回。上面那个用例喂的是 '{not json'（**非法** JSON ⇒ 走 corrupt 分支），
// 恰好绕开了这条路径：形状不合法时旧实现只筛 `typeof === 'object'`（漏掉数组），
// 却把 'ok' 无条件翻译成 SECURITY_STATUS.OK ⇒ requireUnlock: false ⇒ **锁静默失效**，
// 且 characterLocks = {} ⇒ 角色锁名单一并消失。所以这里逐个喂「合法但形状不对」的值。
test('第四态：合法 JSON 但形状不是对象，必须归入 unknown 而不是 ok', async () => {
  const mod = loadSecurity();
  // 形状合法的对照组在前（防过度修正）：正常对象仍必须是 OK。
  store.set(KEY, JSON.stringify({ appLock: { enabled: true }, characterLocks: { 'char-1': true } }));
  const good = await mod.getSecuritySettings();
  assert.equal(good.status, mod.SECURITY_STATUS.OK, '形状合法时仍必须是 OK');
  assert.equal(good.appLock.enabled, true);

  const samples = ['null', '[]', '123', '"str"'];
  for (const sample of samples) {
    const m = loadSecurity();
    // 先写入一份「看起来锁着」的正常配置，再把它替换成形状不对的合法 JSON，
    // 这样如果状态被折叠成 OK，下面就会读到一个「未加锁」的默认值 —— 正是 fail-open。
    store.set(KEY, JSON.stringify({ appLock: { enabled: true }, characterLocks: { 'char-1': true } }));
    await m.getSecuritySettings();
    store.set(KEY, sample);
    const settings = await m.getSecuritySettings();
    assert.equal(settings.status, m.SECURITY_STATUS.UNKNOWN, `${sample}：合法 JSON 但形状不对 ⇒ unknown`);
    assert.notEqual(settings.status, m.SECURITY_STATUS.OK, `${sample}：绝不能折叠成 ok`);
    assert.notEqual(settings.status, m.SECURITY_STATUS.MISSING, `${sample}：也绝不能折叠成 missing`);
    // 状态必须是 fail-closed 的：未知 ⇒ 要求解锁，绝不静默放行。
    const policy = m.resolveAppLockPolicy(settings.status, settings.appLock);
    assert.equal(policy.unknown, true, `${sample}：UI 要能看出状态未知`);
    assert.equal(policy.requireUnlock, true, `${sample}：未知必须要求解锁（否则就是锁静默失效）`);
    assert.equal(policy.relockOnBackground, true, `${sample}：未知时按最保守处理`);
    // 与既有 corrupt 分支的处置保持一致（不引入第三种形状）。
    assert.deepEqual(settings.characterLocks, {}, `${sample}：characterLocks 与 corrupt 分支同形`);
    assert.equal(settings.appLock.enabled, false, `${sample}：读路径给 UI 的默认值不变`);
    assert.ok(store.has(`${KEY}__corrupt_backup`), `${sample}：形状不对的原始值已备份`);
    assert.equal(store.get(KEY), sample, `${sample}：原值未被默认值覆盖`);
  }

  // 三态不被压平：missing 仍然是 missing。
  const fresh = loadSecurity();
  const missing = await fresh.getSecuritySettings();
  assert.equal(missing.status, fresh.SECURITY_STATUS.MISSING, 'missing 仍返回 MISSING');
  assert.deepEqual(missing.characterLocks, {});
});

test('resolveAppLockPolicy：未知态按最保守处理（要求验证，绝不放行）', async () => {
  const mod = loadSecurity();
  // 未知 ⇒ 即使默认值是「未加锁」，也必须要求验证。
  const unknown = mod.resolveAppLockPolicy(mod.SECURITY_STATUS.UNKNOWN, { enabled: false });
  assert.equal(unknown.unknown, true, 'UI 要能看出是「状态未知」');
  assert.equal(unknown.requireUnlock, true, '未知态必须要求解锁，不能静默放行');
  // 未知 ⇒ 自动重新上锁的默认也保持开启（往严的一侧倒）。
  assert.equal(unknown.relockOnBackground, true);
  // 正常态不受影响：真的没开锁就不该平白拦人。
  assert.equal(mod.resolveAppLockPolicy(mod.SECURITY_STATUS.OK, { enabled: false }).requireUnlock, false);
  assert.equal(mod.resolveAppLockPolicy(mod.SECURITY_STATUS.MISSING, { enabled: false }).requireUnlock, false);
  assert.equal(mod.resolveAppLockPolicy(mod.SECURITY_STATUS.OK, { enabled: true }).requireUnlock, true);
  // 显式关掉自动重新上锁时仍然尊重用户设置（未知态除外）。
  assert.equal(
    mod.resolveAppLockPolicy(mod.SECURITY_STATUS.OK, { enabled: true, relockOnBackground: false }).relockOnBackground,
    false
  );
  assert.equal(
    mod.resolveAppLockPolicy(mod.SECURITY_STATUS.UNKNOWN, { enabled: true, relockOnBackground: false }).relockOnBackground,
    true,
    '未知态按最保守处理'
  );
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
  // 三态：损坏必须是 unknown，不能被折叠成「默认 = 未加锁」。
  assert.equal(settings.status, mod.SECURITY_STATUS.UNKNOWN);
  assert.deepEqual(settings.characterLocks, {});
  assert.equal(settings.appLock.enabled, false, '读路径给 UI 的默认值不变');
  assert.ok(store.has(`${KEY}__corrupt_backup`), '损坏值已备份');
  assert.equal(store.get(KEY), '{not json', '原值未被默认值覆盖');
});

test('setCharacterLocks：多选批量共用同一个密码，非法输入整体拒绝', async () => {
  const mod = loadSecurity();
  const count = await mod.setCharacterLocks(['a', 'b', 'c'], '2468');
  assert.equal(count, 3);
  assert.deepEqual(await mod.getCharacterLocks(), { a: true, b: true, c: true });
  // 三个角色都能用同一个密码通过校验（批量密码就是「写多份同一个」）
  for (const id of ['a', 'b', 'c']) {
    assert.equal(await mod.verifyCharacterPasscode(id, '2468'), true, `${id} 应可用同一密码解锁`);
  }
  assert.equal(JSON.stringify(JSON.parse(store.get(KEY))).includes('2468'), false, '名单里不出现明文密码');
  // 非法密码 / 空名单：一个都不写
  assert.equal(await mod.setCharacterLocks(['d'], '12'), 0, '过短密码整体拒绝');
  assert.equal(await mod.setCharacterLocks([], '2468'), 0, '空名单不做任何事');
  assert.equal(await mod.isCharacterLocked('d'), false);
});

test('密码提示：normalizeLockHint 去空白限长，写读清除闭环', async () => {
  const mod = loadSecurity();
  assert.equal(mod.normalizeLockHint('  我的生日  '), '我的生日');
  assert.equal(mod.normalizeLockHint(null), '');
  assert.equal(mod.normalizeLockHint('x'.repeat(200)).length, mod.LOCK_HINT_MAX_LENGTH);
  await mod.setCharacterLock('char-1', '2468');
  assert.equal(await mod.setCharacterLockHint('char-1', '  我常用的那串数字  '), '我常用的那串数字');
  assert.equal(await mod.getCharacterLockHint('char-1'), '我常用的那串数字');
  // 提示落安全存储，不进 AsyncStorage 名单
  assert.equal(JSON.stringify(JSON.parse(store.get(KEY))).includes('数字'), false);
  // 空串 = 清除
  await mod.setCharacterLockHint('char-1', '   ');
  assert.equal(await mod.getCharacterLockHint('char-1'), '');
});

test('批量上锁的提示语义：填了统一覆盖，留空（undefined）不动原有提示', async () => {
  const mod = loadSecurity();
  await mod.setCharacterLock('a', '1111');
  await mod.setCharacterLockHint('a', '旧的提示');
  // 留空：未传 hint 时不该动已有提示（用户没写就别删他的备忘）
  await mod.setCharacterLocks(['a', 'b'], '2468', undefined);
  assert.equal(await mod.getCharacterLockHint('a'), '旧的提示');
  assert.equal(await mod.getCharacterLockHint('b'), '');
  // 填了：这批角色统一覆盖
  await mod.setCharacterLocks(['a', 'b'], '2468', '新提示');
  assert.equal(await mod.getCharacterLockHint('a'), '新提示');
  assert.equal(await mod.getCharacterLockHint('b'), '新提示');
  // 提交空串（用户清空输入框）：统一清除这批提示
  await mod.setCharacterLocks(['a', 'b'], '2468', '');
  assert.equal(await mod.getCharacterLockHint('a'), '');
  assert.equal(await mod.getCharacterLockHint('b'), '');
});

test('清理链路：移除锁与角色删除都会带走密码提示', async () => {
  const mod = loadSecurity();
  const lifecycle = loadModule(path.resolve('src/storage/characterLifecycle.js'));
  await mod.setCharacterLock('gone', '2468');
  await mod.setCharacterLockHint('gone', '写给自己的备忘');
  await lifecycle.runCharacterCleanup(['gone']);
  assert.equal(await mod.isCharacterLocked('gone'), false);
  assert.equal(await mod.getCharacterLockHint('gone'), '', '角色删除后提示一并清除');

  await mod.setCharacterLock('unlock-me', '2468');
  await mod.setCharacterLockHint('unlock-me', '备忘');
  assert.equal(await mod.removeCharacterLock('unlock-me'), true);
  assert.equal(await mod.getCharacterLockHint('unlock-me'), '', '解锁后不留孤儿提示');
});
