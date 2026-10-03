// 工作区设置：纯归一化 + 存储往返（AsyncStorage / io 双重桩）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  DEFAULT_WORKSPACE_MODE,
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
  assert.deepEqual(normalizeWorkspaceSettings({ mode: 'write' }), { mode: 'write' });
  assert.deepEqual(normalizeWorkspaceSettings(null), { mode: 'ask' });
  assert.deepEqual(normalizeWorkspaceSettings('nope'), { mode: 'ask' });
});

test('getWorkspaceSettings 默认 ask，save 后往返一致', async () => {
  store.clear();
  const { getWorkspaceSettings, saveWorkspaceSettings, WORKSPACE_KEY } = loadWorkspaceStorage();
  assert.deepEqual(await getWorkspaceSettings(), { mode: 'ask' });
  const saved = await saveWorkspaceSettings({ mode: 'write' });
  assert.deepEqual(saved, { mode: 'write' });
  assert.equal(JSON.parse(store.get(WORKSPACE_KEY)).mode, 'write');
  assert.deepEqual(await getWorkspaceSettings(), { mode: 'write' });
});

test('损坏或非法值回落默认模式', async () => {
  const { getWorkspaceSettings } = loadWorkspaceStorage();
  store.set('@easychat2_workspace', '{not json');
  assert.deepEqual(await getWorkspaceSettings(), { mode: 'ask' });
  store.set('@easychat2_workspace', JSON.stringify({ mode: 'rm -rf' }));
  assert.deepEqual(await getWorkspaceSettings(), { mode: 'ask' });
});