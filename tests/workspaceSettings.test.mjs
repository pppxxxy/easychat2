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
  assert.deepEqual(normalizeWorkspaceSettings({ mode: 'write' }), {
    mode: 'write',
    location: { kind: 'app', uri: '', name: '' },
    allowCommandExecution: false,
  });
  assert.deepEqual(normalizeWorkspaceSettings(null), {
    mode: 'ask',
    location: { kind: 'app', uri: '', name: '' },
    allowCommandExecution: false,
  });
  assert.deepEqual(normalizeWorkspaceSettings('nope'), {
    mode: 'ask',
    location: { kind: 'app', uri: '', name: '' },
    allowCommandExecution: false,
  });
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
  const defaultSettings = { mode: 'ask', location: { kind: 'app', uri: '', name: '' }, allowCommandExecution: false };
  assert.deepEqual(await getWorkspaceSettings(), defaultSettings);
  const saved = await saveWorkspaceSettings({ mode: 'write' });
  assert.deepEqual(saved, { ...defaultSettings, mode: 'write' });
  assert.equal(JSON.parse(store.get(WORKSPACE_KEY)).mode, 'write');
  assert.deepEqual(await getWorkspaceSettings(), { ...defaultSettings, mode: 'write' });
});

test('损坏或非法值回落默认模式', async () => {
  const { getWorkspaceSettings } = loadWorkspaceStorage();
  const defaultSettings = { mode: 'ask', location: { kind: 'app', uri: '', name: '' }, allowCommandExecution: false };
  store.set('@easychat2_workspace', '{not json');
  assert.deepEqual(await getWorkspaceSettings(), defaultSettings);
  store.set('@easychat2_workspace', JSON.stringify({ mode: 'rm -rf' }));
  assert.deepEqual(await getWorkspaceSettings(), defaultSettings);
});

test('patchWorkspaceSettings 局部更新：改模式不清掉文件夹与命令开关', async () => {
  store.clear();
  const { patchWorkspaceSettings, getWorkspaceSettings } = loadWorkspaceStorage();
  // 先落一个「外部文件夹 + 命令执行开启」的完整状态
  await patchWorkspaceSettings({
    mode: 'write',
    location: { kind: 'saf', uri: 'content://tree/primary%3ADocs', name: 'Docs' },
    allowCommandExecution: true,
  });
  // 只改模式：其余字段必须原样保留（这正是整体 save 会踩的坑）
  const after = await patchWorkspaceSettings({ mode: 'read' });
  assert.equal(after.mode, 'read');
  assert.equal(after.location.kind, 'saf');
  assert.equal(after.location.name, 'Docs');
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