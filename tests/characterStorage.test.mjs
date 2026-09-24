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

test('损坏的旧表情包键只备份不迁移覆盖', async () => {
  const storage = loadStorage();
  store.set('@easychat2_stickers', JSON.stringify([{ id: 'broken' }]));
  assert.deepEqual(await storage.getStickers(), []);
  assert.equal(store.has('@easychat2_stickers'), true);
  assert.equal(store.has('@easychat2_stickers__corrupt_backup'), true);
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
