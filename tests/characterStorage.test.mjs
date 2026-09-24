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
  setCalls = 0;
  vectorSetCalls = 0;
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
