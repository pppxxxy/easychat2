import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/storage.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => {
    store.set(key, value);
  },
  removeItem: async key => {
    store.delete(key);
  },
  multiSet: async pairs => {
    for (const [key, value] of pairs) store.set(key, value);
  },
  multiRemove: async keys => {
    for (const key of keys) store.delete(key);
  },
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

const SQLite = { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };

const STORAGE_DIR = path.resolve('src/storage');

// storage.js 会 require 拆出的 src/storage/*.js；这些模块是 ESM，若走 require(esm)
// 其内部依赖会绕过 Module._load 打桩。这里按需把它们转成 CJS 再加载。
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
  mod._compile(code, absPath);
  return mod.exports;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === 'expo-file-system') return FileSystem;
  if (request === 'expo-sqlite') return SQLite;
  if (request.endsWith('/presets') || request === './presets.js') {
    return { __esModule: true, default: [] };
  }
  if (request.endsWith('/imageGen/providers') || request === './imageGen/providers.js') {
    return { __esModule: true, isKnownImageProvider: () => true };
  }
  if (request.endsWith('/cardForge/forge') || request === './cardForge/forge.js') {
    return {
      __esModule: true,
      FORGE_FIELDS: ['description'],
      FORGE_QUESTIONS: [],
      MAX_PRESERVED_TEXT: 500000,
      MAX_PRESERVED_ITEMS: 2000,
    };
  }
  if (request.endsWith('/moments/moments') || request === './moments/moments.js') {
    return { __esModule: true, removeMomentsBySessionIds: async () => {} };
  }
  if (request.endsWith('/context/characterIdentity') || request === './context/characterIdentity.js') {
    return { __esModule: true };
  }
  if (request.endsWith('/context/sessionLibrary') || request === './context/sessionLibrary.js') {
    return { __esModule: true };
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

const filename = path.resolve('src/storage.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;

const {
  getProactiveSettings,
  saveProactiveSettings,
  makeProactiveSlotId,
  PROACTIVE_MODES,
} = runtimeModule.exports;

const KEY = '@easychat2_proactive_settings';

test.beforeEach(() => store.clear());

test('同一角色可保存多个时间槽', async () => {
  const saved = await saveProactiveSettings({
    apiConfigId: 'cfg-1',
    model: 'model-a',
    slots: [
      { slotId: 's1', roleId: 'role-a', hour: 8, minute: 0, mode: 'WORK' },
      { slotId: 's2', roleId: 'role-a', hour: 21, minute: 30, mode: 'EXACT' },
    ],
  });
  assert.equal(saved.slots.length, 2);
  assert.deepEqual(saved.slots.map(item => item.hour), [8, 21]);
  const loaded = await getProactiveSettings();
  assert.equal(loaded.slots.length, 2);
  assert.equal(loaded.apiConfigId, 'cfg-1');
  assert.equal(loaded.model, 'model-a');
  assert.equal(loaded.slots[1].mode, 'EXACT');
});

test('缺失字段回退默认值且非法值被纠正', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 99, minute: -3, mode: 'NOPE' },
      { roleId: '', hour: 9, minute: 10 },
    ],
  });
  // roleId 为空的槽被丢弃
  assert.equal(saved.slots.length, 1);
  const slot = saved.slots[0];
  assert.equal(slot.hour, 8);
  assert.equal(slot.minute, 0);
  assert.ok(PROACTIVE_MODES.includes(slot.mode));
  assert.equal(slot.mode, 'WORK');
  assert.equal(slot.enabled, true);
});

test('slotId 缺省时稳定派生，显式值被保留', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 7, minute: 5 },
      { slotId: 'keep-me', roleId: 'role-b', hour: 7, minute: 6 },
    ],
  });
  assert.equal(saved.slots[0].slotId, 'slot-0-role-a-7-5');
  assert.equal(saved.slots[1].slotId, 'keep-me');
});

test('损坏数据先备份再返回空设置，不静默覆盖', async () => {
  store.set(KEY, '{not-json');
  const loaded = await getProactiveSettings();
  assert.deepEqual(loaded.slots, []);
  assert.equal(store.get(`${KEY}__corrupt_backup`), '{not-json');
  // 备份存在时原值未被默认值覆盖
  assert.equal(store.get(KEY), '{not-json');
});

test('makeProactiveSlotId 生成的 id 唯一', () => {
  assert.notEqual(makeProactiveSlotId(), makeProactiveSlotId());
});

test('互动面板：折叠选择 API/模型/角色 + 权限状态勾叉问号', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  // 折叠选择器，避免一次性罗列大量 API/模型/角色
  assert.ok(panel.includes('CollapsibleSelect'));
  assert.ok(panel.includes('消息来源（API）'));
  assert.ok(panel.includes('具体模型'));
  assert.ok(panel.includes('选择角色'));
  // 权限状态：勾/叉/问号三态
  assert.ok(panel.includes('getPermissionStatus'));
  assert.ok(panel.includes("'checkmark-circle'"));
  assert.ok(panel.includes("'close-circle'"));
  assert.ok(panel.includes("'help-circle'"));
  assert.ok(panel.includes('permissionRow'));
});