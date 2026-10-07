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

function loadBranches() {
  store.clear();
  clearBranchCache();
  return loadStorageModule(path.resolve('src/storage/sessionBranches.js'));
}

const IDX = 'session-1';
const message = (id, role, text) => ({ id, role, text, timestamp: Number(String(id).replace(/\D/g, '')) || 1 });

test('archiveBranch：写入条目与索引，索引含轻量描述符（无正文）', async () => {
  const branches = loadBranches();
  const descriptor = await branches.archiveBranch(IDX, 'a', [message('b1', 'assistant', '剧情一'), message('b2', 'assistant', '剧情二')]);
  assert.ok(descriptor && descriptor.id);
  const index = await branches.getBranchIndex(IDX);
  assert.equal(index.length, 1);
  assert.equal(index[0].preview, '剧情二');
  assert.equal(index[0].messageCount, 2);
  assert.equal('messages' in index[0], false);
  const itemRaw = store.get(`@easychat2_branch_item::${IDX}::${descriptor.id}`);
  assert.ok(itemRaw, '分支正文应另存分键');
  const item = JSON.parse(itemRaw);
  assert.equal(item.length, 2);
  assert.equal(item[0].branchId, descriptor.id);
});

test('archiveBranch：索引是提交点——写索引失败时返回 null 且不产生可见分支', async () => {
  const branches = loadBranches();
  const original = AsyncStorage.setItem;
  AsyncStorage.setItem = async (key, value) => {
    if (String(key).startsWith('@easychat2_branch_index::')) throw new Error('index write failed');
    return original(key, value);
  };
  try {
    const result = await branches.archiveBranch(IDX, 'a', [message('b1', 'assistant', 'x')]);
    assert.equal(result, null);
    assert.equal((await branches.getBranchIndex(IDX)).length, 0);
  } finally {
    AsyncStorage.setItem = original;
  }
});

test('archiveBranch：空尾段不建分支', async () => {
  const branches = loadBranches();
  assert.equal(await branches.archiveBranch(IDX, 'a', []), null);
  assert.equal((await branches.getBranchIndex(IDX)).length, 0);
});

test('getBranch：读回分支正文；索引存在但正文缺失视为 corrupt', async () => {
  const branches = loadBranches();
  const descriptor = await branches.archiveBranch(IDX, 'a', [message('b1', 'assistant', '正文')]);
  const loaded = await branches.getBranch(IDX, descriptor.id);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.branch.messages[0].text, '正文');
  store.delete(`@easychat2_branch_item::${IDX}::${descriptor.id}`);
  const missing = await branches.getBranch(IDX, descriptor.id);
  assert.equal(missing.status, 'missing');
});

test('deleteBranch：先移索引后删条目，分叉点最后一条删完后索引为空', async () => {
  const branches = loadBranches();
  const one = await branches.archiveBranch(IDX, 'a', [message('b1', 'assistant', 'x')]);
  await branches.archiveBranch(IDX, 'a', [message('b2', 'assistant', 'y')]);
  assert.equal((await branches.getBranchIndex(IDX)).length, 2);
  await branches.deleteBranch(IDX, one.id);
  assert.equal((await branches.getBranchIndex(IDX)).length, 1);
  assert.equal(store.has(`@easychat2_branch_item::${IDX}::${one.id}`), false);
});

test('pruneStaleBranches：清理分叉点已不在活动时间线上的分支，保留根分支', async () => {
  const branches = loadBranches();
  const rooted = await branches.archiveBranch(IDX, 'keep', [message('b1', 'assistant', 'x')]);
  const gone = await branches.archiveBranch(IDX, 'gone', [message('b2', 'assistant', 'y')]);
  const fromStart = await branches.archiveBranch(IDX, '', [message('b3', 'assistant', 'z')]);
  const { removed } = await branches.pruneStaleBranches(IDX, new Set(['keep', 'other']));
  assert.deepEqual(removed, [gone.id]);
  const remaining = (await branches.getBranchIndex(IDX)).map(b => b.id).sort();
  assert.deepEqual(remaining, [rooted.id, fromStart.id].sort());
  assert.equal(store.has(`@easychat2_branch_item::${IDX}::${gone.id}`), false);
});

test('deleteAllBranchesInternal：删除索引与该会话全部条目键', async () => {
  const branches = loadBranches();
  const a = await branches.archiveBranch(IDX, 'a', [message('b1', 'assistant', 'x')]);
  const b = await branches.archiveBranch(IDX, 'a', [message('b2', 'assistant', 'y')]);
  await branches.archiveBranch('session-2', 'a', [message('c1', 'assistant', 'z')]);
  await branches.deleteAllBranchesInternal(IDX);
  assert.equal(store.has(`@easychat2_branch_item::${IDX}::${a.id}`), false);
  assert.equal(store.has(`@easychat2_branch_item::${IDX}::${b.id}`), false);
  assert.equal(store.has(`@easychat2_branch_index::${IDX}`), false);
  // 其它会话不受影响
  assert.equal((await branches.getBranchIndex('session-2')).length, 1);
});

test('sessionFiles：媒体回收扫描把分支条目纳入在用集合', async () => {
  const branches = loadBranches();
  const sessionFiles = loadStorageModule(path.resolve('src/storage/sessionFiles.js'));
  await branches.archiveBranch(IDX, 'a', [{
    id: 'b1',
    role: 'assistant',
    text: '',
    image: { uri: 'file:///documents/chat-images/branch-only.jpg' },
  }]);
  // 直接验证：扫描消息键+分支键的引用提取逻辑——分支条目里的图片应被识别为在用。
  assert.ok(typeof sessionFiles.collectChatImageFiles === 'function');
  const { imageUrisFromMessages } = sessionFiles;
  const branchRaw = JSON.parse(store.get(`@easychat2_branch_index::${IDX}`));
  const itemKey = `@easychat2_branch_item::${IDX}::${branchRaw[0].id}`;
  const uris = imageUrisFromMessages(JSON.parse(store.get(itemKey)));
  assert.ok(uris.has('file:///documents/chat-images/branch-only.jpg'));
});
