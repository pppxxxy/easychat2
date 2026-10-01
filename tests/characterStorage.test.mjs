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
const failedRemoves = new Set();
const failedDeletes = new Set();
const sqliteValues = new Map();
let setCalls = 0;
let vectorSetCalls = 0;
let sqliteEnabled = false;

const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => {
    if (failedSets.has(key)) throw new Error(`write failed: ${key}`);
    setCalls += 1;
    if (String(key).startsWith('@easychat2_vector_index::')) vectorSetCalls += 1;
    store.set(key, value);
  },
  removeItem: async key => {
    if (failedRemoves.has(key)) throw new Error(`remove failed: ${key}`);
    store.delete(key);
  },
  multiSet: async pairs => {
    for (const [key, value] of pairs) {
      if (failedSets.has(key)) throw new Error(`write failed: ${key}`);
      store.set(key, value);
    }
  },
  multiRemove: async keys => {
    for (const key of keys) {
      if (failedRemoves.has(key)) throw new Error(`remove failed: ${key}`);
      store.delete(key);
    }
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
    if (failedDeletes.has(uri)) throw new Error(`delete failed: ${uri}`);
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

const STORAGE_DIR = path.resolve('src/storage');

// storage.js 会 require 拆出的 src/storage/*.js；这些模块是 ESM，若走 require(esm)
// 其内部依赖会绕过 Module._load 打桩。这里按需把它们转成 CJS 再加载，使打桩对所有
// 存储子模块生效。
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
  // 写入 Module._cache：让多个子模块 import 同一个 sessionCore 时拿到同一实例，
  // 匹配真实 ESM 的模块单例语义。否则模块级共享状态（deletedSessionIds /
  // protectedChatImageUris / 各类队列）会被复制成多份，跨模块写入互不可见。
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
    return { __esModule: true, ...characterIdentity };
  }
  if (request.endsWith('/context/sessionLibrary') || request === './context/sessionLibrary.js') {
    return { __esModule: true, ...sessionLibrary };
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

function loadStorage() {
  store.clear();
  files.clear();
  failedGets.clear();
  failedSets.clear();
  failedRemoves.clear();
  failedDeletes.clear();
  sqliteValues.clear();
  sqliteEnabled = false;
  setCalls = 0;
  vectorSetCalls = 0;
  // 清掉上一轮缓存的存储子模块：模块级状态（队列/Set/Map）必须每轮从零开始，
  // 否则跨用例泄漏。子模块之间仍共享同一实例（见 loadStorageModule 的缓存写入）。
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${STORAGE_DIR}${path.sep}`)) delete Module._cache[key];
  });
  const filename = path.resolve('src/storage.js');
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

test('whenSessionMutationsSettled 会等待会话写入排空', async () => {
  const storage = loadStorage();
  const order = [];
  // 入队一个慢写入：settle 钩子必须等它完成
  const pending = storage.saveSessions([]).then(() => order.push('save'));
  const settled = storage.whenSessionMutationsSettled().then(() => order.push('settled'));
  await Promise.all([pending, settled]);
  assert.deepEqual(order, ['save', 'settled']);
});

test('appendProactiveMessage：无指定会话时新建并写入，返回 created=true', async () => {
  const storage = loadStorage();
  const result = await storage.appendProactiveMessage('role-x', {
    id: 'proactive-1',
    text: '早上好呀',
    createdAt: 1234,
  });
  assert.ok(result.sessionId, '应返回目标会话 id');
  assert.equal(result.created, true, '新建时应标记 created');
  const sessions = await storage.getSessions();
  const target = sessions.find(item => item.id === result.sessionId);
  assert.equal(target.characterId, 'role-x');
  const messages = await storage.getMessagesBySession(result.sessionId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].text, '早上好呀');
  assert.equal(messages[0].proactive, true);
});

test('appendProactiveMessage：同 id 幂等，重复写入不产生重复消息', async () => {
  const storage = loadStorage();
  const first = await storage.appendProactiveMessage('role-y', {
    id: 'proactive-dup',
    text: '在吗',
  });
  const again = await storage.appendProactiveMessage('role-y', {
    id: 'proactive-dup',
    text: '在吗',
  });
  assert.equal(again.sessionId, first.sessionId, '应复用同一会话');
  const messages = await storage.getMessagesBySession(first.sessionId);
  assert.equal(messages.length, 1, '同 id 不应重复');
});

test('appendProactiveMessage：指定衔接的历史对话则写入该会话，不新建', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', JSON.stringify([
    { id: 'existing-single', type: 'single', characterId: 'role-z', updatedAt: 10 },
  ]));
  const result = await storage.appendProactiveMessage('role-z', {
    id: 'p-1',
    text: '嘿',
    sessionTargetId: 'existing-single',
  });
  assert.equal(result.sessionId, 'existing-single');
  assert.equal(result.created, false, '指定命中时不应新建');
  const sessions = await storage.getSessions();
  assert.equal(sessions.length, 1, '不应新建会话');
});

test('appendProactiveMessage：指定的历史对话已被删除则回退新建', async () => {
  const storage = loadStorage();
  const result = await storage.appendProactiveMessage('role-w', {
    id: 'p-2',
    text: '在吗',
    sessionTargetId: 'deleted-session',
  });
  assert.equal(result.created, true, '目标已删除应新建');
  const sessions = await storage.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, result.sessionId);
  assert.notEqual(result.sessionId, 'deleted-session');
});

test('appendProactiveMessage：指定的会话属于别的角色则不误用，回退新建', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', JSON.stringify([
    { id: 'other-role-session', type: 'single', characterId: 'someone-else', updatedAt: 10 },
  ]));
  const result = await storage.appendProactiveMessage('role-v', {
    id: 'p-3',
    text: '嘿',
    sessionTargetId: 'other-role-session',
  });
  assert.equal(result.created, true, '不属于该角色的会话不应复用');
  assert.notEqual(result.sessionId, 'other-role-session');
});

test('空白人设读取时不覆写为默认值', async () => {
  // UI 保存角色编辑后人设可能为空串；normalizeCharacter 扩展源字段
  // 后会把 '' 覆盖到默认卡文案上，存储层不能再覆写回去。
  const storage = loadStorage();
  store.clear();
  const character = {
    id: 'blank-persona',
    name: '空人设角色',
    systemPrompt: '',
    systemPromptComposed: '',
  };
  await storage.saveCharacterLibrary([character]);
  const restored = await storage.getCharacterLibrary();
  const item = restored.find(entry => entry.id === 'blank-persona');
  assert.equal(item.systemPrompt, '');
  assert.equal(item.systemPromptComposed, '');
  // 同时确保身份判定不受空人设影响（不是默认卡）
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

test('重复会话 id 保留首条而不是重命名，避免孤立消息键', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', JSON.stringify([
    { id: 'dup-session', type: 'single', characterId: 'c1', updatedAt: 2 },
    { id: 'dup-session', type: 'single', characterId: 'c2', updatedAt: 1 },
  ]));
  store.set('@easychat2_messages::dup-session', JSON.stringify([
    { id: 'm1', role: 'user', text: '还在' },
  ]));
  const sessions = await storage.getSessions();
  assert.deepEqual(sessions.map(item => item.id), ['dup-session']);
  const messages = await storage.getMessagesBySession('dup-session');
  assert.equal(messages.length, 1);
});

test('多个 builtin 标记只会保留 default 一个，避免身份二义', async () => {
  const storage = loadStorage();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default', 'impostor']));
  store.set(`${CHARACTER_ITEM_PREFIX}::default`, JSON.stringify({
    id: 'default',
    builtin: true,
    name: 'EasyChat2 助手',
  }));
  store.set(`${CHARACTER_ITEM_PREFIX}::impostor`, JSON.stringify({
    id: 'impostor',
    builtin: true,
    name: '冒名初始卡',
  }));
  const list = await storage.getCharacterLibrary();
  assert.deepEqual(
    list.filter(item => item.builtin === true).map(item => item.id),
    ['default']
  );
  assert.equal(list.find(item => item.id === 'impostor').builtin, false);
  assert.deepEqual(JSON.parse(store.get(CHARACTER_INDEX_KEY)).sort(), ['default', 'impostor']);
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

test('默认角色带内置教学开场白（获取 API / 导入角色卡 / 开始聊天）', async () => {
  const storage = loadStorage();
  const builtin = storage.DEFAULT_CHARACTER;
  assert.ok(builtin.firstMes.trim().length > 0, '默认角色应有开场白');
  assert.ok(builtin.firstMes.includes('设置'), '开场白应引导填写 API 设置');
  assert.ok(builtin.firstMes.includes('角色'), '开场白应引导导入角色卡');
});

test('存量默认角色首启动播种教学开场白，且仅播种一次', async () => {
  const storage = loadStorage();
  // 存量数据：默认角色 firstMes 为空（会覆盖 DEFAULT_CHARACTER 的新默认值）
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set(MIGRATION_KEY, JSON.stringify({ version: 1, ids: ['default'] }));
  const list = await storage.getCharacterLibrary();
  const seeded = list.find(item => item.id === 'default');
  assert.equal(seeded.firstMes, storage.DEFAULT_CHARACTER.firstMes, '应播种教学开场白');
  // 播种后落盘标记
  assert.equal(store.get('@easychat2_default_greeting_seed'), '1');
});

test('用户清空默认角色开场白后不再被播种填回', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set(MIGRATION_KEY, JSON.stringify({ version: 1, ids: ['default'] }));
  // 标记已置位（此前已播种过），用户主动清空 firstMes
  store.set('@easychat2_default_greeting_seed', '1');
  store.set(`${CHARACTER_ITEM_PREFIX}::default`, JSON.stringify({
    id: 'default',
    builtin: true,
    name: 'EasyChat2 助手',
    firstMes: '',
  }));
  const list = await storage.getCharacterLibrary();
  const item = list.find(entry => entry.id === 'default');
  assert.equal(item.firstMes, '', '标记已置位后不得再填回');
});

test('用户自设的默认角色开场白不被内置文案覆盖', async () => {
  const storage = loadStorage();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set(MIGRATION_KEY, JSON.stringify({ version: 1, ids: ['default'] }));
  store.set(`${CHARACTER_ITEM_PREFIX}::default`, JSON.stringify({
    id: 'default',
    builtin: true,
    name: 'EasyChat2 助手',
    firstMes: '这是我自己写的开场白',
  }));
  const list = await storage.getCharacterLibrary();
  assert.equal(list.find(item => item.id === 'default').firstMes, '这是我自己写的开场白');
});

test('表情包元数据迁移到索引与分片键并保持串行写入', async () => {
  const storage = loadStorage();
  store.set('@easychat2_stickers', JSON.stringify([
    { id: 'sticker-a', name: '开心', uri: 'file:///stickers/a.jpg', createdAt: 1 },
    { id: 'sticker-b', name: '生气', uri: 'file:///stickers/b.jpg', createdAt: 2 },
  ]));

  assert.deepEqual((await storage.getStickers()).map(item => item.id), ['sticker-b', 'sticker-a']);
  assert.deepEqual(JSON.parse(store.get('@easychat2_sticker_index')), ['sticker-b', 'sticker-a']);
  assert.equal(store.has('@easychat2_stickers'), false);
  assert.equal(JSON.parse(store.get('@easychat2_sticker_item::sticker-a')).name, '开心');

  await Promise.all([
    storage.saveSticker({ id: 'sticker-c', name: '惊讶', uri: 'file:///stickers/c.jpg', createdAt: 3 }),
    storage.saveSticker({ id: 'sticker-d', name: '思考', uri: 'file:///stickers/d.jpg', createdAt: 4 }),
  ]);
  const ids = (await storage.getStickers()).map(item => item.id);
  assert.deepEqual(ids, ['sticker-d', 'sticker-c', 'sticker-b', 'sticker-a']);
  assert.equal(JSON.parse(store.get('@easychat2_sticker_item::sticker-c')).name, '惊讶');
});

test('表情包批量删除与重排（保序、原位替换）', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sticker_index', JSON.stringify(['a', 'b', 'c']));
  for (const id of ['a', 'b', 'c']) {
    store.set(`@easychat2_sticker_item::${id}`, JSON.stringify({
      id, name: id, uri: `file:///stickers/${id}.jpg`, createdAt: 1,
    }));
  }

  // 重排：按给定顺序，未列出者按原相对顺序补齐
  await storage.reorderStickers(['c', 'a']);
  assert.deepEqual((await storage.getStickers()).map(item => item.id), ['c', 'a', 'b']);

  // 已存在项原位替换，不因 createdAt 变化被重排
  await storage.saveSticker({ id: 'a', name: 'A', uri: 'file:///stickers/a.jpg', createdAt: 999 });
  assert.deepEqual((await storage.getStickers()).map(item => item.id), ['c', 'a', 'b']);
  assert.equal(JSON.parse(store.get('@easychat2_sticker_item::a')).name, 'A');

  // 批量删除：返回 remaining/removed，索引与分片键同步清理
  const result = await storage.deleteStickers(['a', 'c']);
  assert.deepEqual(result.remaining.map(item => item.id), ['b']);
  assert.deepEqual(result.removed.map(item => item.id).sort(), ['a', 'c']);
  assert.deepEqual(JSON.parse(store.get('@easychat2_sticker_index')), ['b']);
  assert.equal(store.has('@easychat2_sticker_item::a'), false);
  assert.equal(store.has('@easychat2_sticker_item::c'), false);
});

test('索引已部分写入时继续合并旧表情包记录', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sticker_index', JSON.stringify(['sticker-a']));
  store.set('@easychat2_sticker_item::sticker-a', JSON.stringify({
    id: 'sticker-a', name: '开心', uri: 'file:///stickers/a.jpg', createdAt: 1,
  }));
  store.set('@easychat2_stickers', JSON.stringify([
    { id: 'sticker-a', name: '开心', uri: 'file:///stickers/a.jpg', createdAt: 1 },
    { id: 'sticker-b', name: '生气', uri: 'file:///stickers/b.jpg', createdAt: 2 },
  ]));

  const stickers = await storage.getStickers();
  assert.deepEqual(stickers.map(item => item.id).sort(), ['sticker-a', 'sticker-b']);
  assert.equal(store.has('@easychat2_stickers'), false);
});

test('损坏的旧表情包键只备份不迁移覆盖', async () => {
  const storage = loadStorage();
  store.set('@easychat2_stickers', JSON.stringify([{ id: 'broken' }]));
  assert.deepEqual(await storage.getStickers(), []);
  assert.equal(store.has('@easychat2_stickers'), true);
  assert.equal(store.has('@easychat2_stickers__corrupt_backup'), true);
});

test('角色库与 activeId 部分提交失败时恢复磁盘角色库', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  store.set('@easychat2_active_character', JSON.stringify('default'));
  failedSets.add('@easychat2_active_character');
  await assert.rejects(
    () => storage.saveCharacterState([
      { id: 'default', builtin: true, name: '新默认' },
      { id: 'new-card', name: '新角色' },
    ], 'new-card'),
    /write failed/,
  );
  failedSets.delete('@easychat2_active_character');
  const list = await storage.getCharacterLibrary();
  assert.equal(list.some(item => item.id === 'new-card'), false);
  assert.equal(list[0].name, 'EasyChat2 助手');
});

test('删除会话只清理对应会话的向量片段', async () => {
  const storage = loadStorage();
  const characterId = 'character-vector-delete';
  const first = await storage.startNewSession(characterId);
  const second = await storage.startNewSession(characterId);
  await storage.saveVectorIndex(characterId, [
    { id: 'first', sessionId: first.id, text: '甲', vector: [1] },
    { id: 'second', sessionId: second.id, text: '乙', vector: [2] },
  ]);
  await storage.deleteSession(first.id);
  const index = await storage.getVectorIndex(characterId);
  assert.deepEqual(index.map(item => item.id), ['second']);
});

test('输入草稿按会话分键读写且删除会话时一并清理', async () => {
  const storage = loadStorage();
  const first = await storage.startNewSession('character-draft');
  const second = await storage.startNewSession('character-draft');
  await storage.saveSessionDraft(first.id, '还没发出去的字');
  await storage.saveSessionDraft(second.id, '另一个会话的草稿');
  assert.equal(await storage.getSessionDraft(first.id), '还没发出去的字');
  assert.equal(await storage.getSessionDraft(second.id), '另一个会话的草稿');
  // 空字符串等价于清除，避免留下空键
  await storage.clearSessionDraft(first.id);
  assert.equal(await storage.getSessionDraft(first.id), '');
  assert.equal(store.has(`@easychat2_session_draft::${first.id}`), false);
  // 删除会话要连草稿一起清掉，避免孤儿键
  await storage.saveSessionDraft(second.id, '又要删了');
  await storage.deleteSession(second.id);
  assert.equal(store.has(`@easychat2_session_draft::${second.id}`), false);
  assert.equal(await storage.getSessionDraft(second.id), '');
});

test('启动清理未引用的聊天图片和表情包文件', async () => {
  const storage = loadStorage();
  const chatUri = 'file:///documents/chat-images/orphan.jpg';
  const keptChatUri = 'file:///documents/chat-images/kept.jpg';
  const stickerUri = 'file:///documents/stickers/orphan.jpg';
  const keptStickerUri = 'file:///documents/stickers/kept.jpg';
  files.set(chatUri, 'chat');
  files.set(keptChatUri, 'chat');
  files.set(stickerUri, 'sticker');
  files.set(keptStickerUri, 'sticker');
  store.set('@easychat2_messages::kept', JSON.stringify([{ image: { uri: keptChatUri } }]));
  store.set('@easychat2_sticker_index', JSON.stringify(['kept-sticker']));
  store.set('@easychat2_sticker_item::kept-sticker', JSON.stringify({
    id: 'kept-sticker',
    name: '保留',
    uri: keptStickerUri,
  }));

  assert.equal(await storage.collectOrphanImageFiles(), true);
  assert.equal(files.has(chatUri), false);
  assert.equal(files.has(keptChatUri), true);
  assert.equal(files.has(stickerUri), false);
  assert.equal(files.has(keptStickerUri), true);
});

test('启动清理未引用的头像背景文件并保留角色引用', async () => {
  const storage = loadStorage();
  const kept = 'file:///documents/avatars/kept.jpg';
  const orphan = 'file:///documents/avatars/orphan.jpg';
  files.set(kept, 'avatar');
  files.set(orphan, 'avatar');
  store.set('@easychat2_sticker_index', '[]');
  await storage.saveCharacterLibrary([{ id: 'character-avatar', name: '头像角色', avatarUri: kept }]);
  assert.equal(await storage.collectOrphanImageFiles(), true);
  assert.equal(files.has(kept), true);
  assert.equal(files.has(orphan), false);
});

test('用户资料损坏时头像回收整体跳过并保留备份', async () => {
  const storage = loadStorage();
  const uri = 'file:///documents/avatars/user-corrupt.jpg';
  files.set(uri, 'avatar');
  store.set('@easychat2_user_profile', '{broken-profile');
  assert.equal(await storage.collectAvatarImageFiles(), false);
  assert.equal(files.has(uri), true);
  assert.equal(store.get('@easychat2_user_profile__corrupt_backup'), '{broken-profile');
});

test('存在引用源损坏备份键时头像回收整体跳过', async () => {
  const storage = loadStorage();
  const uri = 'file:///documents/avatars/backup-guard.jpg';
  files.set(uri, 'avatar');
  store.set('@easychat2_sessions__corrupt_backup', '[]');
  assert.equal(await storage.collectAvatarImageFiles(), false);
  assert.equal(files.has(uri), true);
});

test('会话存储队列阻止删除后的迟到消息写回', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-queue');
  await Promise.all([
    storage.saveMessagesBySession(created.id, [{ id: 'm1', role: 'user', text: '迟到消息' }]),
    storage.deleteSession(created.id),
  ]);
  assert.deepEqual(await storage.getMessagesBySession(created.id), []);

  const second = await storage.startNewSession('character-queue-2');
  await storage.deleteSession(second.id);
  const result = await storage.saveMessagesBySession(second.id, [{ id: 'm2', role: 'user', text: '不应写入' }]);
  assert.deepEqual(result, []);
  assert.deepEqual(await storage.getMessagesBySession(second.id), []);
});

test('群聊 activeId 写失败时回滚会话列表和活动指针', async () => {
  const storage = loadStorage();
  const existing = await storage.startNewSession('character-group-rollback');
  failedSets.add('@easychat2_active_session');
  await assert.rejects(
    () => storage.createGroupSession(['c1', 'c2'], '回滚群聊'),
    /write failed/,
  );
  failedSets.delete('@easychat2_active_session');
  const sessions = await storage.getSessions();
  assert.deepEqual(sessions.map(session => session.id), [existing.id]);
  assert.equal(await storage.getActiveSessionId(), existing.id);
});

test('删除当前群聊后切到剩余会话，不再创建无角色单聊', async () => {
  const storage = loadStorage();
  const single = await storage.startNewSession('character-a');
  const group = await storage.createGroupSession(['c1', 'c2'], '测试群');
  const result = await storage.deleteSession(group.id);
  assert.equal(result.activeSessionId, single.id);
  assert.equal(result.created, null);
  const sessions = await storage.getSessions();
  assert.equal(sessions.some(session => session.id === group.id), false);
  assert.equal(await storage.getActiveSessionId(), single.id);
});

test('删除消息体失败后恢复会话仍可继续写入新消息', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-restore');
  await storage.saveMessagesBySession(created.id, [
    { id: 'm1', role: 'user', text: '旧消息' },
  ], 'character-restore');
  failedRemoves.add(`@easychat2_messages::${created.id}`);
  await storage.deleteSession(created.id);
  failedRemoves.clear();

  const orphans = await storage.findOrphanSessions();
  assert.ok(orphans.some(item => item.sessionId === created.id));
  await storage.restoreSession(created.id, 'character-restore');

  const saved = await storage.saveMessagesBySession(created.id, [
    { id: 'm2', role: 'user', text: '恢复后的新消息' },
  ], 'character-restore');
  assert.equal(saved.length, 1);
  const messages = await storage.getMessagesBySession(created.id);
  assert.equal(messages.some(item => item.id === 'm2'), true);
});

test('会话摘要和边界在同一队列提交，重置后旧版本不能写回', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-summary');
  await storage.saveMessagesBySession(created.id, [
    { id: 'summary-user', role: 'user', text: '记住约定' },
    { id: 'summary-assistant', role: 'assistant', text: '好的' },
  ]);
  const revision = storage.getSessionSummaryRevision(created.id);
  await storage.appendSessionSummary(created.id, {
    summary: '- 新的约定',
    keywords: ['约定'],
    boundary: 'summary-assistant',
    createdAt: 1,
  }, revision);
  let sessions = await storage.getSessions();
  assert.equal(sessions.find(item => item.id === created.id).summarizedUpTo, 'summary-assistant');

  const staleRevision = storage.getSessionSummaryRevision(created.id);
  await storage.resetSessionSummaries(created.id);
  await assert.rejects(
    () => storage.appendSessionSummary(created.id, {
      summary: '- 过期摘要',
      keywords: ['过期'],
      boundary: 'summary-assistant',
      createdAt: 2,
    }, staleRevision),
    /会话摘要已重置/
  );
  assert.deepEqual(await storage.getSessionSummaries(created.id), []);
  sessions = await storage.getSessions();
  assert.equal(sessions.find(item => item.id === created.id).summarizedUpTo, '');
});

test('重置摘要删除失败时回滚边界且摘要内容保留', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-summary-rollback');
  await storage.saveMessagesBySession(created.id, [
    { id: 'rollback-user', role: 'user', text: '记住约定' },
    { id: 'rollback-assistant', role: 'assistant', text: '好的' },
  ]);
  const revision = storage.getSessionSummaryRevision(created.id);
  await storage.appendSessionSummary(created.id, {
    summary: '- 新的约定',
    keywords: ['约定'],
    boundary: 'rollback-assistant',
    createdAt: 1,
  }, revision);
  failedRemoves.add(`@easychat2_session_summaries::${created.id}`);
  await assert.rejects(() => storage.resetSessionSummaries(created.id), /remove failed/);
  failedRemoves.clear();
  const sessions = await storage.getSessions();
  assert.equal(sessions.find(item => item.id === created.id).summarizedUpTo, 'rollback-assistant');
  assert.equal((await storage.getSessionSummaries(created.id)).length, 1);
});

test('失效摘要保留幸存条目并推进到新边界', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-summary-invalidate');
  await storage.saveMessagesBySession(created.id, [
    { id: 'inv-1', role: 'user', text: '一' },
    { id: 'inv-2', role: 'assistant', text: '二' },
    { id: 'inv-3', role: 'user', text: '三' },
    { id: 'inv-4', role: 'assistant', text: '四' },
  ]);
  let revision = storage.getSessionSummaryRevision(created.id);
  await storage.appendSessionSummary(created.id, {
    summary: '- 第一段',
    keywords: ['一'],
    boundary: 'inv-2',
    createdAt: 1,
  }, revision);
  revision = storage.getSessionSummaryRevision(created.id);
  await storage.appendSessionSummary(created.id, {
    summary: '- 第二段',
    keywords: ['二'],
    boundary: 'inv-4',
    createdAt: 2,
  }, revision);
  await storage.invalidateSessionSummaries(created.id, [
    { summary: '- 第一段', keywords: ['一'], boundary: 'inv-2', createdAt: 1 },
  ], 'inv-2');
  const summaries = await storage.getSessionSummaries(created.id);
  assert.deepEqual(summaries.map(item => item.boundary), ['inv-2']);
  const sessions = await storage.getSessions();
  assert.equal(sessions.find(item => item.id === created.id).summarizedUpTo, 'inv-2');
});

test('向量索引按会话清理时保留其他会话片段', async () => {
  const storage = loadStorage();
  await storage.saveVectorIndex('character-vector', [
    { id: 'session-a-1', sessionId: 'session-a', text: '甲会话', vector: [1] },
    { id: 'session-b-1', sessionId: 'session-b', text: '乙会话', vector: [2] },
    { id: 'legacy-1', text: '旧索引', vector: [3] },
  ]);
  await storage.removeVectorIndexForSession('character-vector', 'session-a');
  const index = await storage.getVectorIndex('character-vector');
  assert.deepEqual(index.map(item => item.id), ['session-b-1', 'legacy-1']);
  assert.equal(index.find(item => item.id === 'session-b-1').sessionId, 'session-b');
});

test('大消息键读取失败时通过 SQLite 分块完成图片回收扫描', async () => {
  const storage = loadStorage();
  const uri = 'file:///documents/chat-images/large-message.jpg';
  files.set(uri, 'image');
  const key = '@easychat2_messages::large-message';
  sqliteValues.set(key, JSON.stringify([{ role: 'assistant', text: 'x'.repeat(2100000) }]));
  sqliteEnabled = true;
  failedGets.add(key);

  await storage.collectChatImageFiles();
  assert.equal(files.has(uri), false);
});

test('聊天图片回收保留其他会话和待发送附件的引用', async () => {
  const storage = loadStorage();
  const first = 'file:///documents/chat-images/first.jpg';
  const second = 'file:///documents/chat-images/second.jpg';
  const draft = 'file:///documents/chat-images/draft.jpg';
  files.set(first, 'first');
  files.set(second, 'second');
  files.set(draft, 'draft');
  store.set('@easychat2_messages::first', JSON.stringify([{ image: { uri: first } }]));
  store.set('@easychat2_messages::second', JSON.stringify([{ image: { uri: second } }]));

  storage.setProtectedChatImageUris([draft]);
  await storage.collectChatImageFiles();
  assert.equal(files.has(first), true);
  assert.equal(files.has(second), true);
  assert.equal(files.has(draft), true);

  store.delete('@easychat2_messages::first');
  await storage.collectChatImageFiles();
  assert.equal(files.has(first), false);
  assert.equal(files.has(second), true);
  assert.equal(files.has(draft), true);
  storage.setProtectedChatImageUris([]);
});

test('语音文件回收：保留被引用与待发送的语音，删除孤儿', async () => {
  const storage = loadStorage();
  const kept = 'file:///documents/voice/kept.m4a';
  const orphan = 'file:///documents/voice/orphan.m4a';
  const draft = 'file:///documents/voice/draft.m4a';
  files.set(kept, 'kept');
  files.set(orphan, 'orphan');
  files.set(draft, 'draft');
  // voice 消息用 audio.uri 引用
  store.set('@easychat2_messages::s1', JSON.stringify([
    { id: 'v1', role: 'user', kind: 'voice', audio: { uri: kept, durationMs: 1000 } },
  ]));
  // 待发送语音（已落盘、消息尚未落盘）应被保护，不会被首次回收删除
  storage.setProtectedVoiceUris([draft]);

  await storage.collectVoiceFiles();
  assert.equal(files.has(kept), true, '被引用的语音应保留');
  assert.equal(files.has(orphan), false, '孤儿语音应删除');
  assert.equal(files.has(draft), true, '待发送语音应保留');

  storage.setProtectedVoiceUris([]);
  // 引用消息被删后，语音应被回收
  store.delete('@easychat2_messages::s1');
  await storage.collectVoiceFiles();
  assert.equal(files.has(kept), false, '取消引用后应回收');
  assert.equal(files.has(draft), false, '取消保护后应回收');
});

test('语音文件回收：消息键损坏时保守返回不删除', async () => {
  const storage = loadStorage();
  const voice = 'file:///documents/voice/safe.m4a';
  files.set(voice, 'safe');
  store.set('@easychat2_messages::broken', '{not json');
  await storage.collectVoiceFiles();
  assert.equal(files.has(voice), true, '读取失败时不得误删');
});

test('删除会话会同时回收语音文件', async () => {
  const storage = loadStorage();
  const created = await storage.startNewSession('character-1');
  const voice = 'file:///documents/voice/bye.m4a';
  files.set(voice, 'bye');
  await storage.saveMessagesBySession(created.id, [
    { id: 'v1', role: 'user', kind: 'voice', audio: { uri: voice }, timestamp: 1 },
  ], 'character-1');
  await storage.deleteSession(created.id);
  assert.equal(files.has(voice), false, '删除会话后语音应被回收');
});

test('动态记录损坏时删除关联动态拒绝写回', async () => {
  const storage = loadStorage();
  const raw = '{broken-json';
  store.set('@easychat2_moments', raw);
  await assert.rejects(
    () => storage.deleteMomentsBySessionIds(['session-corrupt']),
    /动态记录读取失败/
  );
  assert.equal(store.get('@easychat2_moments'), raw);
  assert.equal(store.get('@easychat2_moments__corrupt_backup'), raw);
});

test('动态增量更新串行合并并避免旧快照覆盖', async () => {
  const storage = loadStorage();
  await storage.saveMoments([{ id: 'base', text: '基础', createdAt: 1 }]);
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const first = storage.updateMoments(async list => {
    started();
    await new Promise(resolve => { release = resolve; });
    return [...list, { id: 'first', text: '先开始', createdAt: 2 }];
  });
  await startedPromise;
  const second = storage.updateMoments(list => [
    ...list,
    { id: 'second', text: '后开始', createdAt: 3 },
  ]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    (await storage.getMoments()).map(item => item.id),
    ['second', 'first', 'base']
  );
});

test('向量索引更新与删除串行，旧快照不会复活会话片段', async () => {
  const storage = loadStorage();
  await storage.saveVectorIndex('character-atomic', [
    { id: 'keep-1', sessionId: 'session-keep', messageId: 'keep-1', text: '保留', vector: [1] },
  ]);
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const stale = storage.updateVectorIndex('character-atomic', async current => {
    started();
    await new Promise(resolve => { release = resolve; });
    return [...current, { id: 'late-1', sessionId: 'session-remove', messageId: 'late-1', text: '迟到', vector: [2] }];
  });
  await startedPromise;
  const removed = storage.removeVectorIndexForSession('character-atomic', 'session-remove');
  release();
  await Promise.all([stale, removed]);
  assert.deepEqual(
    (await storage.getVectorIndex('character-atomic')).map(item => item.id),
    ['keep-1']
  );
});

test('批量清理多个会话只写回一次向量索引', async () => {
  const storage = loadStorage();
  await storage.saveVectorIndex('character-batch', [
    { id: 'a', sessionId: 'session-a', messageId: 'a', text: '甲', vector: [1] },
    { id: 'b', sessionId: 'session-b', messageId: 'b', text: '乙', vector: [2] },
    { id: 'c', sessionId: 'session-c', messageId: 'c', text: '丙', vector: [3] },
  ]);
  setCalls = 0;
  await storage.removeVectorIndexForSessions('character-batch', ['session-a', 'session-b', 'session-c']);
  assert.equal(setCalls, 1);
  assert.deepEqual(await storage.getVectorIndex('character-batch'), []);
});

test('向量清理失败会记录开发警告且不阻断会话删除', async () => {
  const storage = loadStorage();
  const session = await storage.startNewSession('character-cleanup-failure');
  await storage.saveVectorIndex('character-cleanup-failure', [
    { id: 'cleanup', sessionId: session.id, messageId: 'm1', text: '待清理', vector: [1] },
  ]);
  failedSets.add('@easychat2_vector_index::character-cleanup-failure');
  const previousDev = globalThis.__DEV__;
  const previousWarn = console.warn;
  let warned = false;
  globalThis.__DEV__ = true;
  console.warn = () => { warned = true; };
  try {
    await storage.deleteSession(session.id);
    assert.equal(warned, true);
    assert.equal((await storage.getSessions()).some(item => item.id === session.id), false);
  } finally {
    globalThis.__DEV__ = previousDev;
    console.warn = previousWarn;
  }
});

test('批量删除会话清理同角色全部目标向量', async () => {
  const storage = loadStorage();
  const characterId = 'character-batch-delete';
  const first = await storage.startNewSession(characterId);
  const second = await storage.startNewSession(characterId);
  await storage.saveVectorIndex(characterId, [
    { id: 'first', sessionId: first.id, messageId: 'm1', text: '甲', vector: [1] },
    { id: 'second', sessionId: second.id, messageId: 'm2', text: '乙', vector: [2] },
  ]);
  vectorSetCalls = 0;
  await storage.deleteSessions([first.id, second.id]);
  assert.equal(vectorSetCalls, 1);
  assert.deepEqual(await storage.getVectorIndex(characterId), []);
});

test('批量删除当前会话时同步持久化活动会话指针', async () => {
  const storage = loadStorage();
  const first = await storage.startNewSession('character-batch-active');
  const second = await storage.startNewSession('character-batch-active');
  await storage.setActiveSessionId(first.id);
  const result = await storage.deleteSessions([first.id]);
  assert.equal(result.activeSessionId, second.id);
  assert.equal(await storage.getActiveSessionId(), second.id);
});

test('向量保存入口执行增量合并，不覆盖其他会话片段', async () => {
  const storage = loadStorage();
  await storage.saveVectorIndex('character-upsert', [
    { id: 'first', sessionId: 'session-a', messageId: 'm1', text: '甲', vector: [1] },
  ]);
  await storage.saveVectorIndex('character-upsert', [
    { id: 'second', sessionId: 'session-b', messageId: 'm2', text: '乙', vector: [2] },
  ]);
  assert.deepEqual(
    (await storage.getVectorIndex('character-upsert')).map(item => item.id),
    ['first', 'second']
  );
});

test('按消息删除只清理目标消息的向量片段', async () => {
  const storage = loadStorage();
  await storage.saveVectorIndex('character-message-delete', [
    { id: 'a-1', sessionId: 'session-a', messageId: 'message-a', text: '甲', vector: [1] },
    { id: 'b-1', sessionId: 'session-a', messageId: 'message-b', text: '乙', vector: [2] },
    { id: 'c-1', sessionId: 'session-b', messageId: 'message-a', text: '丙', vector: [3] },
  ]);
  await storage.removeVectorIndexForMessage('character-message-delete', 'session-a', 'message-a');
  assert.deepEqual(
    (await storage.getVectorIndex('character-message-delete')).map(item => item.id),
    ['b-1', 'c-1']
  );
});

test('角色完整删除清理向量，仅删角色保留历史向量', async () => {
  const storage = loadStorage();
  const first = { id: 'character-delete-1', name: '一号' };
  const second = { id: 'character-delete-2', name: '二号' };
  await storage.saveCharacterLibrary([first, second]);
  await storage.saveVectorIndex(first.id, [
    { id: 'first-vector', sessionId: 'session-first', messageId: 'm1', text: '一号记忆', vector: [1] },
  ]);
  await storage.saveVectorIndex(second.id, [
    { id: 'second-vector', sessionId: 'session-second', messageId: 'm2', text: '二号记忆', vector: [2] },
  ]);

  await storage.saveCharacterState([second], second.id, first.id, [first.id]);
  assert.equal(store.has('@easychat2_vector_index::character-delete-1'), false);
  assert.equal((await storage.getVectorIndex(second.id)).length, 1);

  await storage.saveVectorIndex(first.id, [
    { id: 'first-vector-restored', sessionId: 'session-first', messageId: 'm1', text: '一号记忆', vector: [1] },
  ]);
  await storage.saveCharacterState([second], second.id, first.id, []);
  assert.equal((await storage.getVectorIndex(first.id)).length, 1);
});

test('向量对账清理群聊和已删除会话，保留合法旧条目', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', JSON.stringify([
    { id: 'session-valid', characterId: 'character-a', type: 'single', preview: '有效' },
    { id: 'session-group', type: 'group', members: ['a', 'b'], preview: '群聊' },
  ]));
  store.set('@easychat2_vector_index::character-a', JSON.stringify([
    { id: 'valid', sessionId: 'session-valid', messageId: 'm1', text: '保留', vector: [1] },
    { id: 'group', sessionId: 'session-group', messageId: 'm2', text: '群聊', vector: [2] },
    { id: 'missing', sessionId: 'session-missing', messageId: 'm3', text: '孤儿', vector: [3] },
    { id: 'legacy', messageId: 'm4', text: '旧角色记忆', vector: [4] },
  ]));

  const report = await storage.reconcileVectorIndexes();
  assert.equal(report.removed, 2);
  assert.equal(report.legacyRetained, 1);
  assert.deepEqual(
    (await storage.getVectorIndex('character-a')).map(item => item.id),
    ['valid', 'legacy']
  );
});

test('会话列表损坏时向量对账拒绝改写索引', async () => {
  const storage = loadStorage();
  const raw = '{broken-sessions';
  store.set('@easychat2_sessions', raw);
  store.set('@easychat2_vector_index::character-a', JSON.stringify([
    { id: 'legacy', messageId: 'm1', text: '保留', vector: [1] },
  ]));
  const vectorRaw = store.get('@easychat2_vector_index::character-a');
  await assert.rejects(() => storage.reconcileVectorIndexes(), /会话列表读取失败/);
  assert.equal(store.get('@easychat2_vector_index::character-a'), vectorRaw);
});

test('损坏数据备份失败会记录开发警告', async () => {
  const storage = loadStorage();
  const key = '@easychat2_messages::backup-failed';
  store.set(key, '{broken');
  failedSets.add(key);
  const previousDev = globalThis.__DEV__;
  const previousWarn = console.warn;
  let warned = false;
  globalThis.__DEV__ = true;
  console.warn = () => { warned = true; };
  try {
    const result = await storage.getMessagesBySessionStatus('backup-failed');
    assert.equal(result.status, 'corrupt');
    assert.equal(warned, true);
  } finally {
    globalThis.__DEV__ = previousDev;
    console.warn = previousWarn;
  }
});

test('会话列表损坏时公开保存入口拒绝覆盖', async () => {
  const storage = loadStorage();
  const raw = '{broken-session-list';
  store.set('@easychat2_sessions', raw);
  await assert.rejects(
    () => storage.saveSessions([{ id: 'new-session', characterId: 'character-a' }]),
    /会话记录读取失败/
  );
  assert.equal(store.get('@easychat2_sessions'), raw);
  assert.equal(store.get('@easychat2_sessions__corrupt_backup'), raw);
});

test('消息体合法 JSON 非数组时标记损坏并拒绝保存', async () => {
  const storage = loadStorage();
  const key = '@easychat2_messages::wrong-shape';
  const raw = JSON.stringify({ messages: [] });
  store.set(key, raw);
  const status = await storage.getMessagesBySessionStatus('wrong-shape');
  assert.equal(status.status, 'corrupt');
  assert.equal(store.get(`${key}__corrupt_backup`), raw);
  await assert.rejects(
    () => storage.saveMessagesBySession('wrong-shape', [{ id: 'm1', role: 'user', text: '覆盖' }]),
    /聊天记录读取失败/
  );
  assert.equal(store.get(key), raw);
});

test('孤儿会话扫描隔离备份键并跳过单个读取失败', async () => {
  const storage = loadStorage();
  await storage.saveCharacterLibrary([{ id: 'legacy-character', name: '旧角色' }]);
  const known = await storage.startNewSession('character-known');
  await storage.saveMessagesBySession(known.id, [
    { id: 'known-1', role: 'user', text: '已知', timestamp: 1 },
  ]);
  store.set('@easychat2_messages::orphan-good', JSON.stringify([
    { id: 'orphan-1', role: 'user', text: '孤儿', timestamp: 2 },
  ]));
  store.set('@easychat2_messages::orphan-bad', JSON.stringify([
    { id: 'orphan-2', role: 'user', text: '坏孤儿', timestamp: 3 },
  ]));
  store.set('@easychat2_messages::orphan-backup__corrupt_backup', '[]');
  store.set('@easychat2_messages::legacy-character', JSON.stringify([
    { id: 'legacy-1', role: 'user', text: '旧角色键', timestamp: 4 },
  ]));
  failedGets.add('@easychat2_messages::orphan-bad');
  const result = await storage.findOrphanSessions();
  assert.deepEqual(result.map(item => item.sessionId), ['orphan-good']);
});

test('恢复会话接入最后摘要边界', async () => {
  const storage = loadStorage();
  store.set('@easychat2_messages::restore-boundary', JSON.stringify([
    { id: 'restore-1', role: 'user', text: '第一段', timestamp: 1 },
    { id: 'restore-2', role: 'assistant', text: '第二段', timestamp: 2 },
  ]));
  store.set('@easychat2_session_summaries::restore-boundary', JSON.stringify([
    { summary: '- 已总结', keywords: [], boundary: 'restore-2', createdAt: 1 },
  ]));
  const restored = await storage.restoreSession('restore-boundary', 'character-a');
  assert.equal(restored.summarizedUpTo, 'restore-2');
  assert.equal((await storage.getSessions())[0].summarizedUpTo, 'restore-2');
});

test('恢复会话遇到损坏摘要时拒绝写入会话行', async () => {
  const storage = loadStorage();
  store.set('@easychat2_messages::restore-corrupt-summary', JSON.stringify([
    { id: 'restore-1', role: 'user', text: '内容', timestamp: 1 },
  ]));
  store.set('@easychat2_session_summaries::restore-corrupt-summary', '{broken');
  await assert.rejects(
    () => storage.restoreSession('restore-corrupt-summary', 'character-a'),
    /记忆摘要读取失败/
  );
  assert.deepEqual(await storage.getSessions(), []);
});

test('新建开场白会话在 activeId 写失败时回滚会话和消息体', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions__corrupt_backup', 'existing-corrupt-backup');
  failedSets.add('@easychat2_active_session');
  await assert.rejects(
    () => storage.startNewSession('character-opening', { text: '你好', template: '你好' }),
    /write failed/,
  );
  failedSets.delete('@easychat2_active_session');
  assert.deepEqual(await storage.getSessions(), []);
  assert.equal(store.get('@easychat2_sessions__corrupt_backup'), 'existing-corrupt-backup');
  assert.equal(store.get('@easychat2_sessions__rollback_backup'), undefined);
  const messageKeys = [...store.keys()].filter(key => key.startsWith('@easychat2_messages::'));
  assert.deepEqual(messageKeys, []);
});

test('会话列表损坏时启动读取会用回滚备份恢复', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', '{broken-json');
  store.set('@easychat2_sessions__rollback_backup', JSON.stringify([
    { id: 'backup-session', type: 'single', characterId: 'c1', updatedAt: 1 },
  ]));
  const sessions = await storage.getSessions();
  assert.deepEqual(sessions.map(item => item.id), ['backup-session']);
  assert.equal(store.get('@easychat2_sessions__rollback_backup'), undefined);
  assert.ok(store.get('@easychat2_sessions__corrupt_backup'));
  assert.deepEqual(JSON.parse(store.get('@easychat2_sessions')).map(item => item.id), ['backup-session']);
});

test('活动会话行缺失时消息保存自愈并保留摘要边界', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', '[]');
  store.set('@easychat2_active_session', JSON.stringify('heal-session'));
  store.set('@easychat2_session_summaries::heal-session', JSON.stringify([
    { summary: '- 已总结', keywords: [], boundary: 'heal-2', createdAt: 1 },
  ]));
  await storage.saveMessagesBySession('heal-session', [
    { id: 'heal-1', role: 'user', text: '一', timestamp: 1 },
    { id: 'heal-2', role: 'assistant', text: '二', timestamp: 2 },
  ], 'character-heal');
  const sessions = await storage.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'heal-session');
  assert.equal(sessions[0].summarizedUpTo, 'heal-2');
});

test('制卡草稿损坏时状态接口备份并拒绝覆盖', async () => {
  const storage = loadStorage();
  const raw = '{broken-forge';
  store.set('@easychat2_card_forge', raw);
  const status = await storage.getCardForgeStatus();
  assert.equal(status.status, 'corrupt');
  assert.equal(store.get('@easychat2_card_forge__corrupt_backup'), raw);
  await assert.rejects(
    () => storage.saveCardForge({ draft: { name: '覆盖' } }),
    /制卡草稿读取失败/
  );
  assert.equal(store.get('@easychat2_card_forge'), raw);
});

test('制卡草稿持久化保留角色预设，关闭重开后不丢失', async () => {
  const storage = loadStorage();
  await storage.saveCardForge({
    step: 0,
    answers: {},
    transcript: [],
    draft: {
      presets: Array.from({ length: 60 }, (_, index) => ({
        id: `preset-${index}`,
        name: `预设${index}`,
        description: '说明',
        prompt: `提示${index}`,
        enabled: true,
      })),
    },
  });
  const state = await storage.getCardForge();
  assert.equal(state.draft.presets.length, 60);
  assert.equal(state.draft.presets[0].id, 'preset-0');
  assert.equal(state.draft.presets[0].prompt, '提示0');
});

test('制卡草稿连续保存按调用顺序落盘', async () => {
  const storage = loadStorage();
  await Promise.all([
    storage.saveCardForge({ draft: { description: 'first' } }),
    storage.saveCardForge({ draft: { description: 'second' } }),
  ]);
  const state = await storage.getCardForge();
  assert.equal(state.draft.description, 'second');
});

test('制卡清空以索引删除为提交点，载荷清理失败不恢复旧草稿', async () => {
  const storage = loadStorage();
  await storage.saveCardForge({
    step: 0,
    answers: {},
    transcript: [],
    draft: { description: '大'.repeat(600000) },
  });
  const descriptor = JSON.parse(store.get('@easychat2_card_forge'));
  assert.equal(descriptor.storage, 'file');
  failedDeletes.add(`file:///cache/card-forge/${descriptor.fileName}`);
  await storage.clearCardForge();
  assert.equal(store.get('@easychat2_card_forge'), undefined);
  failedDeletes.clear();
});

test('大型制卡草稿写入文件载荷并可完整读回', async () => {
  const storage = loadStorage();
  const description = '长'.repeat(500000);
  await storage.saveCardForge({
    step: 0,
    answers: {},
    transcript: [],
    draft: { description },
  });
  const descriptor = JSON.parse(store.get('@easychat2_card_forge'));
  assert.equal(descriptor.storage, 'file');
  assert.ok(descriptor.fileName);
  const state = await storage.getCardForge();
  assert.equal(state.draft.description.length, description.length);
});

test('克隆遇到损坏消息体时拒绝创建空会话', async () => {
  const storage = loadStorage();
  const source = await storage.startNewSession('character-clone-corrupt');
  store.set(`@easychat2_messages::${source.id}`, '{broken');
  await assert.rejects(() => storage.cloneSession(source.id), /聊天记录读取失败/);
  assert.equal((await storage.getSessions()).length, 1);
});

test('克隆会话元数据写入失败时清理已写入的克隆消息体', async () => {
  const storage = loadStorage();
  const source = await storage.startNewSession('character-clone-failure');
  await storage.saveMessagesBySession(source.id, [
    { id: 'source-message', role: 'user', text: '原文' },
  ], 'character-clone-failure');
  failedSets.add('@easychat2_sessions');
  await assert.rejects(() => storage.cloneSession(source.id));
  failedSets.delete('@easychat2_sessions');
  const messageKeys = [...store.keys()].filter(key => key.startsWith('@easychat2_messages::'));
  assert.deepEqual(messageKeys, [`@easychat2_messages::${source.id}`]);
});

test('孤儿会话扫描通过 SQLite 分块恢复大消息键', async () => {
  const storage = loadStorage();
  await storage.saveCharacterLibrary([{ id: 'legacy-card', name: '旧角色' }]);
  const key = '@easychat2_messages::orphan-large';
  const raw = JSON.stringify([{ id: 'large-message', role: 'user', text: '大消息', timestamp: 1 }]);
  store.set(key, raw);
  failedGets.add(key);
  sqliteValues.set(key, raw);
  sqliteEnabled = true;
  const result = await storage.findOrphanSessions();
  assert.ok(result.some(item => item.sessionId === 'orphan-large'));
});

test('消息搜索遇到大消息键时继续返回其它会话结果', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', JSON.stringify([
    { id: 'search-large', type: 'single', characterId: 'c1', updatedAt: 2 },
    { id: 'search-small', type: 'single', characterId: 'c2', updatedAt: 1 },
  ]));
  const largeKey = '@easychat2_messages::search-large';
  const smallKey = '@easychat2_messages::search-small';
  const largeRaw = JSON.stringify([{ id: 'large-message', role: 'user', text: '大消息命中' }]);
  store.set(largeKey, largeRaw);
  store.set(smallKey, JSON.stringify([{ id: 'small-message', role: 'user', text: '小消息命中' }]));
  failedGets.add(largeKey);
  sqliteValues.set(largeKey, largeRaw);
  sqliteEnabled = true;
  const results = await storage.searchMessages('命中');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(item => item.messageId).sort(), ['large-message', 'small-message']);
});

test('消息搜索在取消后拒绝继续读取消息体', async () => {
  const storage = loadStorage();
  store.set('@easychat2_sessions', JSON.stringify([
    { id: 'search-abort', type: 'single', characterId: 'c1', updatedAt: 1 },
  ]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => storage.searchMessages('命中', { signal: controller.signal }),
    error => error && error.name === 'AbortError'
  );
});

test('角色库阻断时跳过头像清理，动态头像引用也会保留', async () => {
  const storage = loadStorage();
  seedDefaultItem();
  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default', 'broken-card']));
  const blockedAvatar = 'file:///documents/avatars/blocked.jpg';
  const momentAvatar = 'file:///documents/avatars/moment.jpg';
  files.set(blockedAvatar, 'blocked');
  files.set(momentAvatar, 'moment');
  store.set('@easychat2_moments', JSON.stringify([{
    id: 'moment-1',
    characterId: 'default',
    avatarUri: momentAvatar,
    text: '动态',
  }]));
  const result = await storage.collectOrphanImageFiles();
  assert.equal(result, false);
  assert.equal(files.has(blockedAvatar), true);
  assert.equal(files.has(momentAvatar), true);

  store.set(CHARACTER_INDEX_KEY, JSON.stringify(['default']));
  await storage.collectAvatarImageFiles();
  assert.equal(files.has(momentAvatar), true);
});

test('TTS 设置损坏时先备份再抛错，不回落默认值覆盖', async () => {
  const storage = loadStorage();
  const raw = '{broken-tts';
  store.set('@easychat2_tts', raw);
  await assert.rejects(() => storage.getTtsSettings(), /语音播报设置读取失败/);
  assert.equal(store.get('@easychat2_tts__corrupt_backup'), raw);
  assert.equal(store.get('@easychat2_tts'), raw);
});

test('角色编辑草稿：写入、读即取走与清理', async () => {
  const storage = loadStorage();
  store.clear();
  const formState = { name: '草稿角色', systemPrompt: '未保存的提示', worldInfo: [] };
  await storage.saveCharacterEditDraft('draft-char', formState, 'sig-1');
  const key = '@easychat2_character_edit_draft::draft-char';
  assert.ok(store.has(key));
  // 读即取走：第一次返回草稿并删除
  const draft = await storage.takeCharacterEditDraft('draft-char');
  assert.equal(draft.formState.name, '草稿角色');
  assert.equal(draft.characterSignature, 'sig-1');
  assert.equal(store.has(key), false);
  // 第二次读不到
  assert.equal(await storage.takeCharacterEditDraft('draft-char'), null);
});

test('角色编辑草稿：无 id 与损坏数据按无草稿处理', async () => {
  const storage = loadStorage();
  store.clear();
  assert.equal(await storage.takeCharacterEditDraft(''), null);
  await assert.rejects(() => storage.saveCharacterEditDraft('', {}), /缺少角色 id/);
  // 损坏数据不炸、按无草稿处理并清理键
  const key = '@easychat2_character_edit_draft::broken-char';
  store.set(key, '{broken-draft');
  assert.equal(await storage.takeCharacterEditDraft('broken-char'), null);
  assert.equal(store.has(key), false);
  // clear 对不存在的键静默成功
  await storage.clearCharacterEditDraft('missing-char');
});

test('免责声明按版本确认：条款更新后存量用户需重新确认', async () => {
  const storage = loadStorage();
  store.clear();
  assert.equal(await storage.isDisclaimerAcknowledged(), false);
  // 旧版确认值（'true'）在版本 bump 后视为未确认——新条款对全部用户生效
  store.set('@easychat2_disclaimer_ack', 'true');
  assert.equal(await storage.isDisclaimerAcknowledged(), false);
  await storage.acknowledgeDisclaimer();
  assert.equal(await storage.isDisclaimerAcknowledged(), true);
  assert.equal(store.get('@easychat2_disclaimer_ack'), String(storage.DISCLAIMER_VERSION));
});

test('向量记忆多配置：旧单配置对象迁移为第一条并保留启用状态', async () => {
  const storage = loadStorage();
  store.clear();
  // 旧结构：单配置对象，含 enabled 与地址密钥
  store.set('@easychat2_vector_memory', JSON.stringify({
    enabled: true,
    baseUrl: 'https://legacy.example/v1',
    apiKey: 'sk-legacy',
    model: 'legacy-embed',
    topK: 8,
    maxChars: 512,
  }));
  const payload = await storage.getVectorMemorySettings();
  assert.equal(payload.enabled, true);
  assert.equal(payload.configs.length, 1);
  assert.equal(payload.configs[0].id, 'default');
  assert.equal(payload.configs[0].baseUrl, 'https://legacy.example/v1');
  assert.equal(payload.configs[0].topK, 8);
  assert.equal(payload.activeId, 'default');
  // 兼容旧调用：getVectorMemoryConfig 返回激活配置并带 enabled
  const active = await storage.getVectorMemoryConfig();
  assert.equal(active.enabled, true);
  assert.equal(active.baseUrl, 'https://legacy.example/v1');
});

test('向量记忆多配置：保存多条后按 activeId 取用且旧配置键不再被覆盖', async () => {
  const storage = loadStorage();
  store.clear();
  const a = storage.createVectorConfig({ name: 'A', baseUrl: 'https://a.example/v1', model: 'ma' });
  const b = storage.createVectorConfig({ name: 'B', baseUrl: 'https://b.example/v1', model: 'mb' });
  await storage.saveVectorMemorySettings({ enabled: false, configs: [a, b], activeId: b.id });
  const payload = await storage.getVectorMemorySettings();
  assert.equal(payload.configs.length, 2);
  assert.equal(payload.activeId, b.id);
  const active = await storage.getVectorMemoryConfig();
  assert.equal(active.id, b.id);
  assert.equal(active.baseUrl, 'https://b.example/v1');
  // 旧调用 saveVectorMemoryConfig 只更新同 id 项，不丢另一条
  await storage.saveVectorMemoryConfig({ ...b, enabled: true, topK: 9 });
  const after = await storage.getVectorMemorySettings();
  assert.equal(after.configs.length, 2);
  assert.equal(after.enabled, true);
  assert.equal(after.configs.find(item => item.id === b.id).topK, 9);
  assert.equal(after.configs.find(item => item.id === a.id).model, 'ma');
});

test('向量记忆多配置：空 payload 兜底一条默认配置', async () => {
  const storage = loadStorage();
  store.clear();
  const payload = await storage.getVectorMemorySettings();
  assert.equal(payload.configs.length, 1);
  assert.equal(payload.enabled, false);
  assert.equal(payload.activeId, payload.configs[0].id);
});

test('TTS 设置：旧 enabled 迁移为 autoBroadcast，手动播报不再依赖开关', async () => {
  const storage = loadStorage();
  store.clear();
  // 旧结构只有 enabled（语义为自动播报）
  store.set('@easychat2_tts', JSON.stringify({ enabled: true, activeProvider: 'system', providers: {} }));
  const migrated = await storage.getTtsSettings();
  assert.equal(migrated.autoBroadcast, true);
  assert.equal(migrated.enabled, undefined);
  // 新结构优先取 autoBroadcast
  const saved = await storage.saveTtsSettings({ autoBroadcast: false, activeProvider: 'system', providers: {} });
  assert.equal(saved.autoBroadcast, false);
  const reloaded = await storage.getTtsSettings();
  assert.equal(reloaded.autoBroadcast, false);
});

test('对话配图设置：imagePosition 默认结尾并夹取合法值', async () => {
  const storage = loadStorage();
  store.clear();
  // 旧数据没有 imagePosition → 默认结尾
  store.set('@easychat2_inline_image', JSON.stringify({ enabled: true, providerId: '' }));
  const legacy = await storage.getInlineImageSettings();
  assert.equal(legacy.imagePosition, 'end');
  // 合法值保留
  const saved = await storage.saveInlineImageSettings({
    enabled: true,
    providerId: '',
    stylePrefix: '',
    size: '832*1216',
    maxPromptChars: 400,
    imagePosition: 'middle',
  });
  assert.equal(saved.imagePosition, 'middle');
  // 非法值回退结尾
  const invalid = await storage.saveInlineImageSettings({ imagePosition: '高潮' });
  assert.equal(invalid.imagePosition, 'end');
});

test('语音转文字设置：默认「仅复用」+ 多配置 + 密钥保险箱', async () => {
  const storage = loadStorage();
  store.clear();
  // 默认：无配置，activeId 为空 = 仅复用当前聊天来源
  const initial = await storage.getTranscriptionSettings();
  assert.deepEqual(initial, { activeId: '', configs: [] });
  const saved = await storage.saveTranscriptionSettings({
    activeId: 'stt-1',
    configs: [
      { id: 'stt-1', name: '本地', baseUrl: 'https://stt.test', apiKey: 'sk-secret-value', model: '' },
      { id: 'stt-2', name: '备用', baseUrl: 'https://stt2.test', apiKey: 'k2' },
    ],
  });
  assert.equal(saved.activeId, 'stt-1');
  assert.equal(saved.configs[0].model, 'whisper-1', '缺省 model 应回退 whisper-1');
  // 测试环境 expo-secure-store 不可用：protectSecrets 按「降级安全」保持明文，
  // 读写一致即可（真实设备上会转为 secure:v1:<id> 引用，不落明文）。
  const reloaded = await storage.getTranscriptionSettings();
  assert.equal(reloaded.configs[0].apiKey, 'sk-secret-value', '读回应还原密钥');
  assert.equal(reloaded.activeId, 'stt-1');
});

test('语音转文字设置：activeId 指向不存在的配置时回退为空', async () => {
  const storage = loadStorage();
  store.clear();
  const saved = await storage.saveTranscriptionSettings({
    activeId: 'ghost',
    configs: [{ id: 'stt-1', baseUrl: 'https://stt.test', apiKey: 'k' }],
  });
  assert.equal(saved.activeId, '');
});

test('语音转文字设置：损坏时备份并抛错，不静默覆盖', async () => {
  const storage = loadStorage();
  store.clear();
  store.set('@easychat2_transcription', '{not json');
  await assert.rejects(() => storage.getTranscriptionSettings(), /语音转文字设置读取失败/);
});
