// 对话分支存储测试（P1）。行为测试：加载真实现（sessionBranches + sessionCore +
// sessionFiles + io），在 AsyncStorage mock 上跑 archive/get/delete/prune 生命周期。
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

function loadStorageModule(absPath) {
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
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') return FileSystem;
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  // 密钥存储对分支读写是无关分支：直通原值，避免拉入 SecureStore 依赖树。
  if (request.endsWith('/secretStore.js') || request.endsWith('/secretStore')) {
    return { __esModule: true, hydrateSecrets: value => value, protectSecrets: value => value };
  }
  // i18n 只用到 tActive（抛错/提示文案）：返回键名即可，避免加载整棵词条树。
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  // sessionCore 只为 DEFAULT_CHARACTER 依赖角色 barrel；分支模块本身不用角色。
  if (request.endsWith('/characters.js') || request.endsWith('/characters')) {
    return { __esModule: true, DEFAULT_CHARACTER: { id: 'default' } };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (resolved.startsWith(`${STORAGE_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      return loadStorageModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

function clearBranchCache() {
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${STORAGE_DIR}${path.sep}`)) delete Module._cache[key];
  });
}

const createGroup = async (mod, id, extra = {}) => {
  const now = Date.now();
  return {
    id,
    type: 'group',
    characterId: '',
    members: ['c1', 'c2'],
    memberProfiles: {},
    groupMode: 'ensemble',
    avatarUri: '',
    bgUri: '',
    name: '读书会',
    preview: '',
    pinned: false,
    greetingSelected: true,
    createdAt: now,
    updatedAt: now,
    clonedFrom: '',
    summarizedUpTo: '',
    ...extra,
  };
};

function loadSessions() {
  store.clear();
  clearBranchCache();
  return loadStorageModule(path.resolve('src/storage/sessionList/mutations.js'));
}

test('setGroupMode：合议 ↔ 轮流双向切换并落盘', async () => {
  const sessions = loadSessions();
  // 先手工写一条群聊会话（startNewSession 会走角色校验，此处直接落盘更贴近「已有会话」场景）
  const group = await createGroup(sessions, 'g1');
  store.set('@easychat2_sessions', JSON.stringify([group]));

  const toTurn = await sessions.setGroupMode('g1', 'turn');
  assert.equal(toTurn.groupMode, 'turn');
  assert.equal(JSON.parse(store.get('@easychat2_sessions'))[0].groupMode, 'turn', '必须真的写盘');

  const back = await sessions.setGroupMode('g1', 'ensemble');
  assert.equal(back.groupMode, 'ensemble');
  assert.equal(JSON.parse(store.get('@easychat2_sessions'))[0].groupMode, 'ensemble');
});

test('setGroupMode：非法值不写（避免把会话写进未知分支）', async () => {
  const sessions = loadSessions();
  const group = await createGroup(sessions, 'g1');
  store.set('@easychat2_sessions', JSON.stringify([group]));

  assert.equal(await sessions.setGroupMode('g1', 'round-robin'), null, '未知模式应拒绝');
  assert.equal(await sessions.setGroupMode('g1', ''), null);
  assert.equal(await sessions.setGroupMode('g1', null), null);
  assert.equal(JSON.parse(store.get('@easychat2_sessions'))[0].groupMode, 'ensemble', '拒绝后不得改动');
});

test('setGroupMode：单聊会话不受影响（发言模式只对群聊有意义）', async () => {
  const sessions = loadSessions();
  const single = {
    id: 's1',
    type: 'single',
    characterId: 'c1',
    members: [],
    name: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.set('@easychat2_sessions', JSON.stringify([single]));
  const result = await sessions.setGroupMode('s1', 'turn');
  // 单聊的 groupMode 在 sessionLibrary 归一化里就是空串；关键断言是「没被改成 turn」。
  assert.notEqual(result && result.groupMode, 'turn', '单聊不应被写入 turn');
  assert.notEqual(JSON.parse(store.get('@easychat2_sessions'))[0].groupMode, 'turn');
});

test('setGroupMode：同值不写盘（避免无意义的 updatedAt 变化）', async () => {
  const sessions = loadSessions();
  const group = await createGroup(sessions, 'g1', { updatedAt: 1000 });
  store.set('@easychat2_sessions', JSON.stringify([group]));
  const same = await sessions.setGroupMode('g1', 'ensemble');
  assert.equal(same.updatedAt, 1000, '同值时不应刷新 updatedAt');
});


// ---- 群聊成员增删（setGroupMembers）----

test('setGroupMembers：增删成员并落盘，顺序按传入顺序', async () => {
  const sessions = loadSessions();
  const group = await createGroup(sessions, 'g1', { members: ['c1', 'c2'] });
  store.set('@easychat2_sessions', JSON.stringify([group]));

  const added = await sessions.setGroupMembers('g1', ['c2', 'c1', 'c3']);
  assert.deepEqual(added.members, ['c2', 'c1', 'c3'], '顺序跟随传入，便于用户自行排序');
  assert.deepEqual(JSON.parse(store.get('@easychat2_sessions'))[0].members, ['c2', 'c1', 'c3']);

  const removed = await sessions.setGroupMembers('g1', ['c1', 'c2']);
  assert.deepEqual(removed.members, ['c1', 'c2']);
});

test('setGroupMembers：人数越界直接拒绝（2–8，与创建时同一份常量）', async () => {
  const sessions = loadSessions();
  const group = await createGroup(sessions, 'g1');
  store.set('@easychat2_sessions', JSON.stringify([group]));

  assert.equal(await sessions.setGroupMembers('g1', []), null, '0 人不是群聊');
  assert.equal(await sessions.setGroupMembers('g1', ['c1']), null, '1 人不是群聊');
  const nine = Array.from({ length: 9 }, (_, i) => `c${i + 1}`);
  assert.equal(await sessions.setGroupMembers('g1', nine), null, '超过上限应拒绝');
  // 拒绝后不得改动。
  assert.deepEqual(JSON.parse(store.get('@easychat2_sessions'))[0].members, ['c1', 'c2']);
  // 边界内两个值都可用。
  assert.ok(await sessions.setGroupMembers('g1', ['c1', 'c2']));
  assert.ok(await sessions.setGroupMembers('g1', Array.from({ length: 8 }, (_, i) => `n${i + 1}`)));
});

test('setGroupMembers：重复 id 去重（同一角色不能占两个发言位）', async () => {
  const sessions = loadSessions();
  const group = await createGroup(sessions, 'g1');
  store.set('@easychat2_sessions', JSON.stringify([group]));

  const result = await sessions.setGroupMembers('g1', ['c1', 'c1', 'c2', 'c2', 'c3']);
  assert.deepEqual(result.members, ['c1', 'c2', 'c3']);
  // 去重后只剩 3 个仍在范围外？仍在 [2,8] 内，所以应成功。
  assert.equal(result.members.length, 3);
});

test('setGroupMembers：移除成员时一并删除它的 memberProfiles（否则留下幽灵简介）', async () => {
  const sessions = loadSessions();
  const group = await createGroup(sessions, 'g1', {
    members: ['c1', 'c2', 'c3'],
    memberProfiles: { c1: '甲', c2: '乙', c3: '丙' },
  });
  store.set('@easychat2_sessions', JSON.stringify([group]));

  const result = await sessions.setGroupMembers('g1', ['c1', 'c2']);
  assert.deepEqual(result.members, ['c1', 'c2']);
  assert.deepEqual(Object.keys(result.memberProfiles).sort(), ['c1', 'c2'], '被移除成员的简介必须清掉');
  const persisted = JSON.parse(store.get('@easychat2_sessions'))[0];
  assert.deepEqual(Object.keys(persisted.memberProfiles).sort(), ['c1', 'c2']);
});

test('setGroupMembers：同值不写盘；单聊不受影响', async () => {
  const sessions = loadSessions();
  const group = await createGroup(sessions, 'g1', { members: ['c1', 'c2'], updatedAt: 1000 });
  const single = {
    id: 's1', type: 'single', characterId: 'c1', members: [], name: '',
    createdAt: 1, updatedAt: 1,
  };
  store.set('@easychat2_sessions', JSON.stringify([group, single]));

  const same = await sessions.setGroupMembers('g1', ['c1', 'c2']);
  assert.equal(same.updatedAt, 1000, '同值不应刷新 updatedAt');

  const onSingle = await sessions.setGroupMembers('s1', ['c1', 'c2']);
  assert.notEqual(onSingle && onSingle.type, 'group');
  assert.deepEqual(JSON.parse(store.get('@easychat2_sessions'))[1].members, [], '单聊成员不应被写入');
});
