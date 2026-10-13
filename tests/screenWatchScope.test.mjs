// SW1：看屏幕线程的 scope 分类（线程分「聊天角色」与「工作区助手」两类）。
//
// 核心风险：续用判据若不看 scope，工作区看屏幕会接走聊天角色的线程——两个场景的
// 上下文串在一起（用户在工作区下命令，却看到聊天角色的截图对话）。这里把「隔离」
// 钉成**真行为**测试（注入 AsyncStorage 与 io 桩，沿用 screenWatchThreads.test.mjs 机制）；
// 旧数据兼容（无 scope 字段 → chat）同样钉住。

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
const corruptBackups = [];

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  multiSet: async entries => { entries.forEach(([key, value]) => store.set(key, value)); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

const ioStub = {
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
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
      settle() { return single.catch(() => {}); },
    };
  },
  CORRUPT_BACKUP_SUFFIX: '__corrupt_backup',
  backupCorruptValue: async key => { corruptBackups.push(key); },
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

const threads = loadSourceModule('src/screenWatch/threads.js');
const buckets = loadSourceModule('src/memory/memoryBuckets.js');

const KEY = '@easychat2_screen_watch_threads';
const T0 = 1_700_000_000_000;

test('normalizeThreadScope：合法值原样，其余一律回落 chat（旧数据不丢）', () => {
  assert.equal(threads.normalizeThreadScope('workspace'), 'workspace');
  assert.equal(threads.normalizeThreadScope('chat'), 'chat');
  for (const bad of [undefined, null, '', 'WORKSPACE', 'other', 0, {}, []]) {
    assert.equal(threads.normalizeThreadScope(bad), 'chat', `${JSON.stringify(bad)} 应回落 chat`);
  }
  assert.deepEqual([...threads.THREAD_SCOPES], ['chat', 'workspace']);
});

test('normalizeThread：旧数据（无 scope 字段）归 chat，不丢线程', () => {
  const legacy = threads.normalizeThread({
    id: 't1', characterId: 'c1', characterName: '小樱', createdAt: T0, updatedAt: T0, entries: [],
  });
  assert.equal(legacy.scope, 'chat', '无字段 = 聊天类（历史数据）');
  assert.equal(threads.normalizeThread({ id: 't2', scope: 'workspace', characterId: 'w1' }).scope, 'workspace');
  assert.equal(threads.normalizeThread({ id: 't3', scope: 'nope', characterId: 'c1' }).scope, 'chat');
});

test('续用隔离：同一角色在 chat 与 workspace 各有一条独立活跃线程', async () => {
  store.clear();
  // 先建聊天线程
  const chatFirst = await threads.getOrCreateActiveThread('c1', '小樱', T0);
  assert.equal(chatFirst.created, true);
  assert.equal(chatFirst.thread.scope, 'chat', '缺省 scope = chat（向后兼容）');

  // 同一 characterId、同一时刻，但 scope=workspace → 必须是**另一条**线程
  const wsFirst = await threads.getOrCreateActiveThread('c1', '小樱', T0, 'workspace');
  assert.equal(wsFirst.created, true, '工作区线程不得复用聊天线程');
  assert.notEqual(wsFirst.thread.id, chatFirst.thread.id, '两条线程 id 不同');
  assert.equal(wsFirst.thread.scope, 'workspace');

  // 各自续用自己那条（5 分钟后）
  const chatAgain = await threads.getOrCreateActiveThread('c1', '小樱', T0 + 5 * 60 * 1000);
  assert.equal(chatAgain.created, false);
  assert.equal(chatAgain.thread.id, chatFirst.thread.id, '聊天侧续用聊天线程');
  const wsAgain = await threads.getOrCreateActiveThread('c1', '小樱', T0 + 5 * 60 * 1000, 'workspace');
  assert.equal(wsAgain.created, false);
  assert.equal(wsAgain.thread.id, wsFirst.thread.id, '工作区侧续用工作区线程');

  // 列表里两条都在，scope 各自正确
  const all = await threads.getScreenWatchThreads();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(t => t.scope).sort(), ['chat', 'workspace']);
});

test('scope 隔离不因空闲超时而串：超时后各自新建，仍不交叉', async () => {
  store.clear();
  const chat1 = await threads.getOrCreateActiveThread('c1', '小樱', T0);
  const ws1 = await threads.getOrCreateActiveThread('c1', '小樱', T0, 'workspace');
  const later = T0 + threads.THREAD_IDLE_MS + 1;
  const chat2 = await threads.getOrCreateActiveThread('c1', '小樱', later);
  const ws2 = await threads.getOrCreateActiveThread('c1', '小樱', later, 'workspace');
  assert.equal(chat2.created, true, '聊天线程超时后新建');
  assert.equal(ws2.created, true, '工作区线程超时后新建');
  assert.notEqual(chat2.thread.id, chat1.thread.id);
  assert.notEqual(ws2.thread.id, ws1.thread.id);
  assert.notEqual(chat2.thread.id, ws2.thread.id, '新建的聊天线程不得等于工作区线程');
  assert.equal(chat2.thread.scope, 'chat');
  assert.equal(ws2.thread.scope, 'workspace');
});

test('groupScreenThreadsByScope：按 scope 分两组，组内保持原顺序，未知归 chat', () => {
  const list = [
    { id: 'a', scope: 'workspace' },
    { id: 'b', scope: 'chat' },
    { id: 'c', scope: 'workspace' },
    { id: 'd' },
    { id: 'e', scope: 'bogus' },
  ];
  const { chat, workspace } = buckets.groupScreenThreadsByScope(list);
  assert.deepEqual(workspace.map(t => t.id), ['a', 'c'], '工作区组保持原顺序');
  assert.deepEqual(chat.map(t => t.id), ['b', 'd', 'e'], '聊天组含旧数据与未知值');
  assert.deepEqual(
    buckets.groupScreenThreadsByScope(null),
    { chat: [], workspace: [], chatScope: 'chat', workspaceScope: 'workspace' }
  );
});

test('旧数据兼容：磁盘上无 scope 的历史线程读回后归 chat（不被丢弃）', async () => {
  store.clear();
  store.set(KEY, JSON.stringify([
    { id: 'legacy-1', characterId: 'c1', characterName: '小樱', createdAt: T0, updatedAt: T0, entries: [{ id: 'e1', role: 'user', text: '旧记录', at: T0 }] },
  ]));
  const list = await threads.getScreenWatchThreads();
  assert.equal(list.length, 1, '历史线程必须保留');
  assert.equal(list[0].scope, 'chat', '历史线程归聊天类');
  const { chat, workspace } = buckets.groupScreenThreadsByScope(list);
  assert.equal(chat.length, 1);
  assert.equal(workspace.length, 0);
});

test('追加条目不影响 scope：工作区线程追加后仍是 workspace', async () => {
  store.clear();
  const ws = await threads.getOrCreateActiveThread('c1', '工作助手', T0, 'workspace');
  await threads.appendThreadEntry(ws.thread.id, { id: 'e1', role: 'user', text: '看看这个', at: T0 + 1 });
  const list = await threads.getScreenWatchThreads();
  const target = list.find(t => t.id === ws.thread.id);
  assert.equal(target.scope, 'workspace', '追加条目不得把 scope 洗掉');
  assert.equal(target.entries.length, 1);
});
