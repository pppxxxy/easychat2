// 工作区设置：纯归一化 + 存储往返（AsyncStorage / io 双重桩）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  DEFAULT_WORKSPACE_MODE,
  isExternalWorkspaceRoot,
  normalizeAllowCommandExecution,
  normalizeAllowPythonExecution,
  normalizeWorkspaceMode,
  normalizeWorkspaceSettings,
  WORKSPACE_MODES,
} from '../src/workspace/settings.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const workspaceStoragePath = path.resolve('src/storage/workspace.js');
const transformed = babel.transformSync(fs.readFileSync(workspaceStoragePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: workspaceStoragePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
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
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === './io.js') return ioStub;
  if (request === '../workspace/settings.js') return { normalizeWorkspaceSettings };
  return originalLoad.call(this, request, parent, isMain);
};

function loadWorkspaceStorage() {
  const filename = workspaceStoragePath;
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

test('normalizeWorkspaceSettings 只认三模式，其余回默认', () => {
  assert.deepEqual(WORKSPACE_MODES, ['ask', 'read', 'write']);
  assert.equal(DEFAULT_WORKSPACE_MODE, 'ask');
  assert.equal(normalizeWorkspaceMode('read'), 'read');
  assert.equal(normalizeWorkspaceMode('write'), 'write');
  assert.equal(normalizeWorkspaceMode('bogus'), 'ask');
  assert.equal(normalizeWorkspaceMode(undefined), 'ask');
  // P1-11 起的默认字段（保留口径 = 历史常量；边界与夹取在 workspaceRetention.test.mjs）。
  const restDefaults = {
    location: { kind: 'app', uri: '', name: '' },
    allowCommandExecution: false,
    allowPythonExecution: false,
    allowLocalGit: false,
    assistantCharacterId: '',
    retention: { historyKeep: 200, rollbackKeep: 3, sessionEventsMaxKb: 512 },
  };
  assert.deepEqual(normalizeWorkspaceSettings({ mode: 'write' }), { mode: 'write', ...restDefaults });
  assert.deepEqual(normalizeWorkspaceSettings(null), { mode: 'ask', ...restDefaults });
  assert.deepEqual(normalizeWorkspaceSettings('nope'), { mode: 'ask', ...restDefaults });
  // 工作区角色：去首尾空白；非字符串噪声归一为空串。
  assert.equal(normalizeWorkspaceSettings({ assistantCharacterId: '  abc  ' }).assistantCharacterId, 'abc');
  assert.equal(normalizeWorkspaceSettings({ assistantCharacterId: 42 }).assistantCharacterId, '42');
  assert.equal(normalizeWorkspaceSettings({ assistantCharacterId: null }).assistantCharacterId, '');
});

test('命令执行开关只在可改模式下成立（其余模式一律归零）', () => {
  assert.equal(normalizeAllowCommandExecution(true, 'write'), true);
  assert.equal(normalizeAllowCommandExecution(true, 'read'), false);
  assert.equal(normalizeAllowCommandExecution(true, 'ask'), false);
  assert.equal(normalizeAllowCommandExecution('yes', 'write'), false);
  assert.equal(normalizeAllowCommandExecution(false, 'write'), false);
  // 归一化整体也遵守同一规则：模式回落到只读时，开关随之归零而不是留在存储里骗人
  const settings = normalizeWorkspaceSettings({ mode: 'read', allowCommandExecution: true });
  assert.equal(settings.allowCommandExecution, false);
});

// 两个执行开关（命令执行 / 模型运行 Python）必须**各自独立**：
// 开一个不能顺手打开另一个，关一个也不能影响另一个。安全开关最糟的形态就是
// 「点一下开了两个」——用户以为自己只允许了 shell，实际把能联网的 Python 也放开了。
test('两个执行开关互相独立：开一个不会带开另一个', async () => {
  store.clear();
  const { patchWorkspaceSettings } = loadWorkspaceStorage();

  // 只开命令执行 → Python 开关必须仍是关的
  const shellOnly = await patchWorkspaceSettings({ mode: 'write', allowCommandExecution: true });
  assert.equal(shellOnly.allowCommandExecution, true);
  assert.equal(shellOnly.allowPythonExecution, false, '开命令执行不得顺手打开 Python');

  // 只开 Python → 关掉命令执行也不能把 Python 带关
  const pythonOnly = await patchWorkspaceSettings({ allowCommandExecution: false, allowPythonExecution: true });
  assert.equal(pythonOnly.allowCommandExecution, false);
  assert.equal(pythonOnly.allowPythonExecution, true, '关命令执行不得带关 Python');

  // 两个都开，随后只关一个
  await patchWorkspaceSettings({ allowCommandExecution: true, allowPythonExecution: true });
  const shellOff = await patchWorkspaceSettings({ allowCommandExecution: false });
  assert.equal(shellOff.allowPythonExecution, true, '关一个不能影响另一个');

  // Python 开关与命令执行遵守同一条模式规则
  assert.equal(normalizeAllowPythonExecution(true, 'write'), true);
  assert.equal(normalizeAllowPythonExecution(true, 'read'), false);
  assert.equal(normalizeAllowPythonExecution(true, 'ask'), false);
  assert.equal(normalizeAllowPythonExecution('yes', 'write'), false);
  const readMode = normalizeWorkspaceSettings({ mode: 'read', allowPythonExecution: true });
  assert.equal(readMode.allowPythonExecution, false);
});

test('工作区根：非法 location 一律回落应用内默认', () => {
  const saf = normalizeWorkspaceSettings({
    mode: 'write',
    location: { kind: 'saf', uri: 'content://com.android.externalstorage.documents/tree/primary%3ADocs', name: 'Docs' },
  });
  assert.equal(saf.location.kind, 'saf');
  assert.equal(saf.location.name, 'Docs');
  assert.equal(isExternalWorkspaceRoot(saf), true);
  // 有 kind 没 uri / uri 是 file:// / 乱七八糟的东西都回默认，避免存下一个用不了的根
  assert.equal(normalizeWorkspaceSettings({ location: { kind: 'saf', uri: '' } }).location.kind, 'app');
  assert.equal(normalizeWorkspaceSettings({ location: { kind: 'saf', uri: 'file:///sdcard/x' } }).location.kind, 'app');
  assert.equal(normalizeWorkspaceSettings({ location: 'saf' }).location.kind, 'app');
  assert.equal(isExternalWorkspaceRoot({ mode: 'write' }), false);
  // 显示名截断到 80
  assert.equal(normalizeWorkspaceSettings({
    location: { kind: 'saf', uri: 'content://x', name: 'n'.repeat(200) },
  }).location.name.length, 80);
});

test('getWorkspaceSettings 默认 ask，save 后往返一致', async () => {
  store.clear();
  const { getWorkspaceSettings, saveWorkspaceSettings, WORKSPACE_KEY } = loadWorkspaceStorage();
  // P1-11 起设置里多了 retention（保留口径），默认值即历史常量（见 workspaceRetention.test.mjs）。
  const defaultSettings = {
    mode: 'ask',
    location: { kind: 'app', uri: '', name: '' },
    allowCommandExecution: false,
    allowPythonExecution: false,
    allowLocalGit: false,
    assistantCharacterId: '',
    retention: { historyKeep: 200, rollbackKeep: 3, sessionEventsMaxKb: 512 },
  };
  assert.deepEqual(await getWorkspaceSettings(), defaultSettings);
  const saved = await saveWorkspaceSettings({ mode: 'write' });
  assert.deepEqual(saved, { ...defaultSettings, mode: 'write' });
  assert.equal(JSON.parse(store.get(WORKSPACE_KEY)).mode, 'write');
  assert.deepEqual(await getWorkspaceSettings(), { ...defaultSettings, mode: 'write' });
});

test('损坏或非法值回落默认模式', async () => {
  const { getWorkspaceSettings } = loadWorkspaceStorage();
  const defaultSettings = {
    mode: 'ask',
    location: { kind: 'app', uri: '', name: '' },
    allowCommandExecution: false,
    allowPythonExecution: false,
    allowLocalGit: false,
    assistantCharacterId: '',
    retention: { historyKeep: 200, rollbackKeep: 3, sessionEventsMaxKb: 512 },
  };
  store.set('@easychat2_workspace', '{not json');
  assert.deepEqual(await getWorkspaceSettings(), defaultSettings);
  store.set('@easychat2_workspace', JSON.stringify({ mode: 'rm -rf' }));
  assert.deepEqual(await getWorkspaceSettings(), defaultSettings);
  // 保留口径写坏（0 / 负数 / 非数字）同样回落默认，不允许把上限配成 0。
  store.set('@easychat2_workspace', JSON.stringify({ retention: { historyKeep: 0, rollbackKeep: -3, sessionEventsMaxKb: 'x' } }));
  const fallback = await getWorkspaceSettings();
  assert.deepEqual(fallback.retention, { historyKeep: 10, rollbackKeep: 1, sessionEventsMaxKb: 512 });
});

test('patchWorkspaceSettings 局部更新：改模式不清掉文件夹与命令开关', async () => {
  store.clear();
  const { patchWorkspaceSettings, getWorkspaceSettings } = loadWorkspaceStorage();
  // 先落一个「外部文件夹 + 命令执行开启 + 工作区角色」的完整状态
  await patchWorkspaceSettings({
    mode: 'write',
    location: { kind: 'saf', uri: 'content://tree/primary%3ADocs', name: 'Docs' },
    allowCommandExecution: true,
    assistantCharacterId: 'assistant-1',
  });
  // 只改模式：其余字段必须原样保留（这正是整体 save 会踩的坑）
  const after = await patchWorkspaceSettings({ mode: 'read' });
  assert.equal(after.mode, 'read');
  assert.equal(after.location.kind, 'saf');
  assert.equal(after.location.name, 'Docs');
  assert.equal(after.assistantCharacterId, 'assistant-1', '改模式不得清掉工作区角色');
  // 命令执行随模式归零（只读模式下不成立），但文件夹不能丢
  assert.equal(after.allowCommandExecution, false);
  const persisted = await getWorkspaceSettings();
  assert.equal(persisted.location.uri, 'content://tree/primary%3ADocs');
  assert.equal(persisted.mode, 'read');
});

test('patchWorkspaceSettings 非法补丁被归一化挡住', async () => {
  store.clear();
  const { patchWorkspaceSettings } = loadWorkspaceStorage();
  await patchWorkspaceSettings({ mode: 'write', location: { kind: 'saf', uri: 'content://tree/a', name: 'A' } });
  const after = await patchWorkspaceSettings({ location: null, allowCommandExecution: 'yes' });
  assert.equal(after.location.kind, 'app');
  assert.equal(after.allowCommandExecution, false);
  assert.equal(after.mode, 'write');
});