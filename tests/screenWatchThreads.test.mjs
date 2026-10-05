// 看屏幕对话线程测试：注入 AsyncStorage 与 io 桩（沿用 musicPlaylists.test.mjs 机制）。
// 核心契约：同角色 + 未超空闲阈值 = 同一场对话（连续截图不各说各话）。

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
    const buckets = new Map();
    return {
      enqueue(task, key = '') {
        const bucket = String(key || '');
        const tail = bucket ? (buckets.get(bucket) || Promise.resolve()) : single;
        const next = tail.then(task, task);
        if (bucket) buckets.set(bucket, next.catch(() => {}));
        else single = next.catch(() => {});
        return next;
      },
      settle() {
        const tails = [single, ...buckets.values()];
        return Promise.all(tails.map(tail => tail.catch(() => {}))).then(() => undefined);
      },
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
const overlayEvents = loadSourceModule('src/screenWatch/overlayEvents.js');

const KEY = '@easychat2_screen_watch_threads';
const T0 = 1_700_000_000_000;

test('连续截图归入同一场对话：同角色未超空闲阈值即续用', async () => {
  store.clear();
  const first = await threads.getOrCreateActiveThread('c1', '小樱', T0);
  assert.equal(first.created, true);
  assert.deepEqual(first.thread.entries, []);

  // 第二次截图（5 分钟后）——仍是同一场
  const second = await threads.getOrCreateActiveThread('c1', '小樱', T0 + 5 * 60 * 1000);
  assert.equal(second.created, false);
  assert.equal(second.thread.id, first.thread.id);

  // 期间追加两条（模拟 用户说话 + 角色回复）
  await threads.appendThreadEntry(second.thread.id, {
    id: 'e1', role: threads.THREAD_ROLE_USER, text: '看这个', at: T0 + 5 * 60 * 1000,
  });
  const after = await threads.appendThreadEntry(second.thread.id, {
    id: 'e2', role: threads.THREAD_ROLE_CHARACTER, text: '这是终端窗口', at: T0 + 5 * 60 * 1000 + 1,
  });
  assert.deepEqual(after.entries.map(entry => entry.id), ['e1', 'e2']);
  // role 直接沿用聊天命名，可原样作为 historyMessages
  assert.deepEqual(after.entries.map(entry => entry.role), ['user', 'assistant']);
});

test('超过空闲阈值或换角色则开新对话', async () => {
  store.clear();
  const first = await threads.getOrCreateActiveThread('c1', '小樱', T0);
  const later = await threads.getOrCreateActiveThread('c1', '小樱', T0 + threads.THREAD_IDLE_MS + 1);
  assert.equal(later.created, true);
  assert.notEqual(later.thread.id, first.thread.id);

  const other = await threads.getOrCreateActiveThread('c2', '阿岚', T0);
  assert.equal(other.created, true);
  assert.notEqual(other.thread.id, later.thread.id);

  const list = await threads.getScreenWatchThreads();
  assert.equal(list.length, 3);
});

test('线程条目不重复落库、无效条目被丢弃；删除只动目标线程', async () => {
  store.clear();
  const { thread } = await threads.getOrCreateActiveThread('c1', '小樱', T0);
  await threads.appendThreadEntry(thread.id, { id: 'dup', role: 'user', text: '一', at: T0 });
  await threads.appendThreadEntry(thread.id, { id: 'dup', role: 'user', text: '重复 id', at: T0 });
  await threads.appendThreadEntry(thread.id, { id: '', role: 'user', text: '无 id', at: T0 });
  const loaded = (await threads.getScreenWatchThreads()).find(item => item.id === thread.id);
  assert.deepEqual(loaded.entries.map(entry => entry.text), ['一'], '重复 id 与无 id 条目被丢弃');

  const { removed, list } = await threads.deleteScreenWatchThread(thread.id);
  assert.equal(removed.id, thread.id);
  assert.deepEqual(list, []);

  store.set(KEY, '{ not json');
  await assert.rejects(() => threads.getScreenWatchThreads(), /read-failed/);
  assert.ok(corruptBackups.includes(KEY), '损坏值应被备份');
});

test('采集失败事件解析：reason 缺省按 unknown', () => {
  assert.equal(overlayEvents.OVERLAY_EVENT_CAPTURE_FAILED, 'ScreenOverlay:onCaptureFailed');
  assert.deepEqual(overlayEvents.parseCaptureFailedEvent({ reason: 'no-projection' }), { reason: 'no-projection' });
  assert.deepEqual(overlayEvents.parseCaptureFailedEvent(null), { reason: 'unknown' });
  assert.deepEqual(overlayEvents.parseCaptureFailedEvent({}), { reason: 'unknown' });
});
