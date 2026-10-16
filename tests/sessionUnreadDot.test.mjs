// 记忆页未读小红点（lastReadAt 时间戳口径）的行为测试。
//
// 加载**真实现**（mutations + sessionCore + sessionLibrary + memoryBuckets），只把
// AsyncStorage / FileSystem / i18n 等原生与边界依赖换成替身；种子数据也用真的写入函数
// （saveSessionsInternal）铺进去——这样键格式与归一化口径都由生产代码决定，测试不会
// 因为两边各写一份而假绿。风格对齐 tests/sessionDeleteCleanup.test.mjs。

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
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
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
  if (request === 'expo-sqlite') {
    return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  }
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (request.endsWith('/characters.js') || request.endsWith('/characters')) {
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

const sessionLibrary = loadModule(path.join(SRC_DIR, 'context', 'sessionLibrary.js'));
const memoryBuckets = loadModule(path.join(SRC_DIR, 'memory', 'memoryBuckets.js'));
const mutations = loadModule(path.join(SRC_DIR, 'storage', 'sessionList', 'mutations.js'));
const core = loadModule(path.join(SRC_DIR, 'storage', 'sessionCore.js'));
const { SESSIONS_KEY } = core;

const { hasSessionUnread } = memoryBuckets;
const { normalizeSession, applySessionLastRead } = sessionLibrary;
const { markSessionRead } = mutations;

function storedSession(id) {
  const raw = store.get(SESSIONS_KEY);
  const list = raw ? JSON.parse(raw) : [];
  return list.find(item => item.id === id);
}

test.beforeEach(() => { store.clear(); });

// ---- 归一化：旧数据迁移 ------------------------------------------------

test('未读：旧条目缺 lastReadAt 时回填 updatedAt（升级后不全体冒红点）', () => {
  const old = normalizeSession({ id: 's1', characterId: 'c1', updatedAt: 5000 });
  assert.equal(old.lastReadAt, 5000, '缺字段必须补成 updatedAt，而不是 0');
  assert.equal(hasSessionUnread(old), false, '历史消息不算未读，升级后必须是干净的');
});

test('未读：旧条目即使 createdAt 很大也不受影响，只看 updatedAt', () => {
  const old = normalizeSession({ id: 's1', createdAt: 999999, updatedAt: 10 });
  assert.equal(old.lastReadAt, 10);
  assert.equal(hasSessionUnread(old), false);
});

test('未读：lastReadAt 为 0/负数/非数字/NaN 一律回填 updatedAt', () => {
  for (const bad of [0, -1, 'abc', null, undefined, NaN, {}]) {
    const session = normalizeSession({ id: 's1', updatedAt: 7777, lastReadAt: bad });
    assert.equal(session.lastReadAt, 7777, `lastReadAt=${String(bad)} 应回填 updatedAt`);
    assert.equal(hasSessionUnread(session), false);
  }
});

test('未读：合法 lastReadAt 原样保留，不被 updatedAt 覆盖', () => {
  const session = normalizeSession({ id: 's1', updatedAt: 9000, lastReadAt: 100 });
  assert.equal(session.lastReadAt, 100, '已读位置更早 ⇒ 应保持未读');
  assert.equal(hasSessionUnread(session), true);
});

// ---- hasSessionUnread 三态 --------------------------------------------

test('未读三态：updatedAt > lastReadAt 亮；相等不亮；读完（lastReadAt 更大）不亮', () => {
  assert.equal(hasSessionUnread({ updatedAt: 200, lastReadAt: 100 }), true, '有新消息 → 亮');
  assert.equal(hasSessionUnread({ updatedAt: 100, lastReadAt: 100 }), false, '相等即已读 → 不亮');
  assert.equal(hasSessionUnread({ updatedAt: 100, lastReadAt: 200 }), false, '已读位置更晚 → 不亮');
});

test('未读：空/非法输入一律不亮，不抛错', () => {
  for (const bad of [null, undefined, 0, '', 'x', [], { updatedAt: 0, lastReadAt: 0 }]) {
    assert.equal(hasSessionUnread(bad), false);
  }
});

test('未读：updatedAt 缺失或为 0 的会话不亮（空会话不该冒红点）', () => {
  assert.equal(hasSessionUnread({ id: 's1' }), false);
  assert.equal(hasSessionUnread({ id: 's1', updatedAt: 0, lastReadAt: 0 }), false);
});

// ---- applySessionLastRead（窄写判据）----------------------------------

test('窄写：只改 lastReadAt，不碰 preview/updatedAt/pinned 与其它字段', () => {
  const before = {
    id: 's1', preview: '你好', updatedAt: 100, pinned: true,
    name: 'n', clonedFrom: 'x', modelKind: 'local', lastReadAt: 50,
  };
  const after = applySessionLastRead(before, 300);
  assert.equal(after.lastReadAt, 300);
  assert.equal(after.preview, '你好', '不得碰 preview');
  assert.equal(after.updatedAt, 100, '不得碰 updatedAt');
  assert.equal(after.pinned, true, '不得碰 pinned');
  assert.equal(after.name, 'n');
  assert.equal(after.clonedFrom, 'x');
  assert.equal(after.modelKind, 'local');
  assert.equal(before.lastReadAt, 50, '不得就地修改入参');
});

test('窄写：只前进不后退——更早的时间戳返回 null（调用方据此跳过写盘）', () => {
  assert.equal(applySessionLastRead({ id: 's1', lastReadAt: 500 }, 400), null);
  assert.equal(applySessionLastRead({ id: 's1', lastReadAt: 500 }, 500), null, '相等也无变化');
  assert.ok(applySessionLastRead({ id: 's1', lastReadAt: 500 }, 501));
});

test('窄写：非法时间戳/非法会话返回 null，不产生垃圾写', () => {
  for (const bad of [0, -5, NaN, 'abc', null]) {
    assert.equal(applySessionLastRead({ id: 's1', lastReadAt: 1 }, bad), null, `at=${String(bad)}`);
  }
  assert.equal(applySessionLastRead(null, 100), null);
});

test('窄写：省略时间戳 = 取当前时刻（undefined 走默认值，不是「无效」）', () => {
  const updated = applySessionLastRead({ id: 's1', lastReadAt: 1 });
  assert.ok(updated && updated.lastReadAt > 1, '省略 at 应落到 Date.now()，供 markSessionRead 调用');
});

// ---- markSessionRead 落盘（真实现 + 真存储）----------------------------

test('落盘：markSessionRead 后 lastReadAt 真的写进磁盘 JSON（不是只活在内存）', async () => {
  await core.saveSessionsInternal([{ id: 's1', characterId: 'c1', updatedAt: 100 }]);
  await markSessionRead('s1', 400);
  const onDisk = storedSession('s1');
  assert.equal(onDisk.lastReadAt, 400, '必须落盘，否则冷启动后红点行为与本次会话不一致');
  assert.equal(onDisk.updatedAt, 100, '窄写不得改 updatedAt');
});

test('落盘：markSessionRead 不碰 preview/updatedAt/pinned（真实现）', async () => {
  await core.saveSessionsInternal([{
    id: 's1', characterId: 'c1', preview: '原预览', updatedAt: 100, pinned: true,
  }]);
  await markSessionRead('s1', 400);
  const onDisk = storedSession('s1');
  assert.equal(onDisk.preview, '原预览', '窄写不得改 preview');
  assert.equal(onDisk.updatedAt, 100, '窄写不得改 updatedAt');
  assert.equal(onDisk.pinned, true, '窄写不得改 pinned');
});

test('落盘：消息推进 updatedAt → 重新亮；再 markSessionRead → 灭', async () => {
  await core.saveSessionsInternal([{ id: 's1', characterId: 'c1', updatedAt: 100 }]);
  await markSessionRead('s1', 200);
  assert.equal(hasSessionUnread((await core.getSessions()).find(s => s.id === 's1')), false);

  // 新消息落盘：updatedAt 前进（真实现就是 saveMessagesBySessionInternal 里写 Date.now()）
  await core.saveSessionsInternal((await core.getSessions()).map(s => (
    s.id === 's1' ? { ...s, preview: '新消息', updatedAt: 9000 } : s
  )));
  assert.equal(hasSessionUnread((await core.getSessions()).find(s => s.id === 's1')), true,
    '有新消息且未读位置落后 → 必须重新亮');

  await markSessionRead('s1', 9001);
  assert.equal(hasSessionUnread((await core.getSessions()).find(s => s.id === 's1')), false);
});

test('落盘：省略时间戳时在任务执行时取当前时间（保证「看的时候晚于写入」）', async () => {
  const past = Date.now() - 60000;
  await core.saveSessionsInternal([{ id: 's1', characterId: 'c1', updatedAt: past }]);
  await markSessionRead('s1');
  const onDisk = storedSession('s1');
  assert.ok(onDisk.lastReadAt > past, '执行时刻必须晚于旧 updatedAt，红点才会灭');
  assert.equal(hasSessionUnread(onDisk), false);
});

test('落盘：会话不存在时安静返回 null，不新建会话、不写盘', async () => {
  await core.saveSessionsInternal([{ id: 's1', characterId: 'c1', updatedAt: 100 }]);
  const result = await markSessionRead('missing', 500);
  assert.equal(result, null);
  assert.equal(JSON.parse(store.get(SESSIONS_KEY)).length, 1, '不得凭空多出会话');
});

test('落盘：损坏的会话列表下 markSessionRead 抛错且不覆盖盘上数据（读改写必须中止）', async () => {
  store.set(SESSIONS_KEY, '{不是合法 JSON');
  const corrupted = store.get(SESSIONS_KEY);
  await assert.rejects(
    () => markSessionRead('s1', 500),
    '读改写必须中止：损坏列表上不得静默继续，更不得拿空列表覆盖'
  );
  assert.equal(store.get(SESSIONS_KEY), corrupted, '读不出时绝不能拿空列表整表覆盖');
});

test('落盘：只前进不后退——更早的时间戳不会把已读位置往回拨', async () => {
  await core.saveSessionsInternal([{ id: 's1', characterId: 'c1', updatedAt: 100 }]);
  await markSessionRead('s1', 5000);
  await markSessionRead('s1', 300);
  const onDisk = storedSession('s1');
  assert.equal(onDisk.lastReadAt, 5000, '乱序/并发调用不得把已读位置往回拨（否则红点复亮）');
});

// ---- 归一化白名单：modelKind/modelName 的既存缺陷回归 -------------------

test('白名单回归：modelKind/modelName/lastReadAt 都必须落盘（曾经只活在内存里）', async () => {
  await core.saveSessionsInternal([{ id: 's1', characterId: 'c1', updatedAt: 100 }]);
  await mutations.markSessionModel('s1', { modelKind: 'local', modelName: 'Qwen3-4B' });
  const onDisk = storedSession('s1');
  assert.equal(onDisk.modelKind, 'local', '本地标记必须落盘（否则冷启动后「本地」badge/chip 消失）');
  assert.equal(onDisk.modelName, 'Qwen3-4B');
  // 冷启动：只从磁盘读回
  delete Module._cache[path.join(SRC_DIR, 'storage', 'sessionCore.js')];
  const coreReloaded = loadModule(path.join(SRC_DIR, 'storage', 'sessionCore.js'));
  const afterRestart = (await coreReloaded.getSessions()).find(s => s.id === 's1');
  assert.equal(afterRestart.modelKind, 'local', '冷启动后仍要在（回归 markSessionModel 静默丢字段）');
  assert.equal(memoryBuckets.hasLocalSessions([afterRestart]), true);
});

// ---- 归一化：agentMode 等既有字段不回归 --------------------------------

test('回归：既有字段归一化行为不变（agentMode/type/pinned/clonedFrom）', () => {
  const session = normalizeSession({
    id: 's1', agentMode: 'write', pinned: true, clonedFrom: 'src', type: 'group', updatedAt: 5,
  });
  assert.equal(session.agentMode, 'write');
  assert.equal(session.pinned, true);
  assert.equal(session.clonedFrom, 'src');
  assert.equal(session.type, 'group');
  assert.equal(session.lastReadAt, 5);
});
