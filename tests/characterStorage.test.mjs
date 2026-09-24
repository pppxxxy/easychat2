import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import * as characterIdentity from '../src/context/characterIdentity.js';
import * as sessionLibrary from '../src/context/sessionLibrary.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/storage.js');
const sourceCode = fs.readFileSync(sourcePath, 'utf8');
const transformed = babel.transformSync(sourceCode, {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const files = new Map();
const failedGets = new Set();
const failedSets = new Set();
const sqliteValues = new Map();
let sqliteEnabled = false;

const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => {
    if (failedSets.has(key)) throw new Error(`write failed: ${key}`);
    store.set(key, value);
  },
  removeItem: async key => {
    store.delete(key);
  },
  multiSet: async pairs => {
    for (const [key, value] of pairs) {
      if (failedSets.has(key)) throw new Error(`write failed: ${key}`);
      store.set(key, value);
    }
  },
  multiRemove: async keys => {
    keys.forEach(key => store.delete(key));
  },
  getAllKeys: async () => [...store.keys()],
};

const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: sqliteEnabled }),
  makeDirectoryAsync: async () => {},
  writeAsStringAsync: async (uri, value) => {
    files.set(uri, value);
  },
  readAsStringAsync: async uri => {
    if (!files.has(uri)) throw new Error(`file missing: ${uri}`);
    return files.get(uri);
  },
  readDirectoryAsync: async directory => [...files.keys()]
    .filter(uri => uri.startsWith(directory))
    .map(uri => uri.slice(directory.length)),
  deleteAsync: async uri => {
    files.delete(uri);
  },
};

const SQLite = {
  openDatabase: () => ({
    execAsync: async queries => {
      const query = queries[0];
      const key = query.args[query.args.length - 1];
      const value = sqliteValues.get(key) || '';
      if (query.sql.includes('length(value)')) {
        return [{ rows: [{ total: value.length }] }];
      }
      const offset = Number(query.args[0]) - 1;
      const size = Number(query.args[1]);
      return [{ rows: [{ chunk: value.slice(offset, offset + size) }] }];
    },
    closeAsync: async () => {},
  }),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === 'expo-file-system') return FileSystem;
  if (request === 'expo-sqlite') return SQLite;
  if (request.endsWith('/presets') || request === './presets') {
    return { __esModule: true, default: [] };
  }
  if (request.endsWith('/imageGen/providers') || request === './imageGen/providers') {
    return { __esModule: true, isKnownImageProvider: () => true };
  }
  if (request.endsWith('/cardForge/forge') || request === './cardForge/forge') {
    return { __esModule: true, FORGE_FIELDS: [], FORGE_QUESTIONS: [] };
  }
  if (request.endsWith('/moments/moments') || request === './moments/moments') {
    return { __esModule: true, removeMomentsBySessionIds: async () => {} };
  }
  if (request.endsWith('/context/characterIdentity') || request === './context/characterIdentity') {
    return { __esModule: true, ...characterIdentity };
  }
  if (request.endsWith('/context/sessionLibrary') || request === './context/sessionLibrary') {
    return { __esModule: true, ...sessionLibrary };
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

function loadStorage() {
  store.clear();
  files.clear();
  failedGets.clear();
  failedSets.clear();
  sqliteValues.clear();
  sqliteEnabled = false;
  const filename = path.resolve('src/storage.test-runtime.cjs');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

const CHARACTERS_KEY = '@easychat2_characters';
const CHARACTER_INDEX_KEY = '@easychat2_character_index';
const CHARACTER_ITEM_PREFIX = '@easychat2_character_item';
const MIGRATION_KEY = '@easychat2_character_migration';

function seedDefaultItem() {
  store.set(`${CHARACTER_ITEM_PREFIX}::default`, JSON.stringify({
    id: 'default',
    builtin: true,
    name: 'EasyChat2 助手',
  }));
}

test('大角色卡使用文件描述符，保存后可以完整读回', async () => {
  const storage = loadStorage();
  const character = {
    id: 'large-card',
    name: '大卡',
    description: '角色描述'.repeat(180000),
  };
  await storage.saveCharacterLibrary([character]);
  const index = JSON.parse(store.get(CHARACTER_INDEX_KEY));
  assert.ok(index.includes('large-card'));
  const descriptor = JSON.parse(store.get(`${CHARACTER_ITEM_PREFIX}::large-card`));
  assert.equal(descriptor.storage, 'file');
  assert.ok(files.has(`file:///documents/characters/${descriptor.fileName}`));
  const restored = await storage.getCharacterLibrary();
  assert.equal(restored.find(item => item.id === 'large-card').description, character.description);
  assert.equal(storage.isCharacterLibraryWriteBlocked(), false);
});

test('默认索引是升级回归产物时，从仍可读的 legacy 整库恢复角色', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set(CHARACTERS_KEY, JSON.stringify([
    { id: 'default', builtin: true, name: '旧 EasyChat2 助手' },
    { id: 'legacy-card', name: '旧角色' },
  ]));
  const list = await storage.getCharacterLibrary();
  assert.deepEqual(list.map(item => item.id).sort(), ['default', 'legacy-card']);
  const index = JSON.parse(store.get(CHARACTER_INDEX_KEY));
  assert.deepEqual(index.sort(), ['default', 'legacy-card']);
  assert.equal(storage.isCharacterLibraryWriteBlocked(), false);
});

test('索引缺项且 legacy 可读时合并恢复，不删除失效引用', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default', 'missing-card']));
  store.set(CHARACTERS_KEY, JSON.stringify([
    { id: 'default', builtin: true, name: 'EasyChat2 助手' },
    { id: 'missing-card', name: '找回角色' },
  ]));
  const list = await storage.getCharacterLibrary();
  assert.ok(list.some(item => item.id === 'missing-card'));
  assert.ok(JSON.parse(store.get(CHARACTER_INDEX_KEY)).includes('missing-card'));
});

test('Android SQLite 分块读取可以救回超过 CursorWindow 的 legacy 值', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  const legacyValue = JSON.stringify([
    { id: 'default', builtin: true, name: 'EasyChat2 助手' },
    { id: 'sqlite-recovered', name: '分块找回角色' },
  ]);
  sqliteValues.set(CHARACTERS_KEY, legacyValue);
  sqliteEnabled = true;
  failedGets.add(CHARACTERS_KEY);
  const list = await storage.getCharacterLibrary();
  assert.ok(list.some(item => item.id === 'sqlite-recovered'));
  assert.equal(storage.isCharacterLibraryWriteBlocked(), false);
});

test('legacy 或角色条目读取失败时进入恢复阻断态，不写默认索引覆盖数据', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set(CHARACTERS_KEY, JSON.stringify([{ id: 'legacy-card', name: '不可读旧角色' }]));
  failedGets.add(CHARACTERS_KEY);
  const list = await storage.getCharacterLibrary();
  assert.deepEqual(list.map(item => item.id), ['default']);
  assert.equal(storage.isCharacterLibraryWriteBlocked(), true);
  assert.equal(store.get(CHARACTER_INDEX_KEY), JSON.stringify(['default']));
  await assert.rejects(() => storage.saveCharacterLibrary(list), /恢复中/);
});

test('健康索引首次读取会写入迁移标记，避免旧整库后续复活', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set(CHARACTERS_KEY, JSON.stringify([
    { id: 'default', builtin: true, name: 'EasyChat2 助手' },
  ]));
  await storage.getCharacterLibrary();
  assert.equal(JSON.parse(store.get(MIGRATION_KEY)).ids[0], 'default');
});

test('记忆总结设置独立保存并可读取', async () => {
  const storage = loadStorage();
  const saved = await storage.saveMemorySummarySettings({ enabled: true, threshold: 8 });
  assert.deepEqual(saved, { enabled: true, threshold: 8 });
  assert.deepEqual(await storage.getMemorySummarySettings(), { enabled: true, threshold: 8 });
});

test('新建会话可写入已选择的开场白消息', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-1', {
    text: '你好，小明',
    template: '你好，{{user}}',
  });
   assert.equal(created.greetingSelected, true);
   const messages = await storage.getMessagesBySession(created.id);
   assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'greeting');
   assert.equal(messages[0].text, '你好，小明');
   assert.equal(messages[0].greetingTemplate, '你好，{{user}}');
});

test('空会话可以记录已完成开场白选择', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-1');
  assert.equal(created.greetingSelected, false);
  const updated = await storage.setSessionGreetingSelected(created.id);
  assert.equal(updated.greetingSelected, true);
});

test('迁移标记存在时保留当前索引，不重新复活已删除角色', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set(MIGRATION_KEY, JSON.stringify({ version: 1, ids: ['default'] }));
  store.set(CHARACTERS_KEY, JSON.stringify([
    { id: 'default', builtin: true, name: 'EasyChat2 助手' },
    { id: 'deleted-card', name: '已删除角色' },
  ]));
  const list = await storage.getCharacterLibrary();
  assert.deepEqual(list.map(item => item.id), ['default']);
});
