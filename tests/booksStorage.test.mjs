// 书架存储域测试：注入 AsyncStorage、io 与 expo-file-system/legacy 三重桩
// （沿用 musicLibrary.test.mjs 机制）。锁定索引分键读写、进度保存、正文文件读写
// 与删除清扫；正文恒走文件，是书架与曲库的关键差异。

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
const fileStore = new Map();
const corruptBackups = [];

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  multiSet: async entries => { entries.forEach(([key, value]) => store.set(key, value)); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

const FileSystemStub = {
  documentDirectory: 'file:///docs/',
  EncodingType: { UTF8: 'utf8' },
  readAsStringAsync: async uri => {
    if (!fileStore.has(String(uri))) throw new Error('ENOENT');
    return fileStore.get(String(uri));
  },
  writeAsStringAsync: async (uri, content) => { fileStore.set(String(uri), String(content)); },
  deleteAsync: async uri => { fileStore.delete(String(uri)); },
  makeDirectoryAsync: async () => {},
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

function loadSourceModule(relativePath) {
  const sourcePath = path.resolve(relativePath);
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
    if (request.includes('expo-file-system')) return FileSystemStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

const library = loadSourceModule('src/books/library.js');
const comments = loadSourceModule('src/books/comments.js');

const itemKey = id => `@easychat2_books_item::${id}`;

function makeBook(overrides = {}) {
  return {
    id: `book-${Math.random().toString(36).slice(2, 8)}`,
    name: '测试小说',
    uri: 'file:///docs/books/abc.txt',
    size: 2048,
    chars: 8000,
    addedAt: 1000,
    ...overrides,
  };
}

test('书架：新增置顶、原位替换、必填校验', async () => {
  store.clear();
  fileStore.clear();
  await library.saveBookItem(makeBook({ id: 'b1', name: '第一本' }));
  await library.saveBookItem(makeBook({ id: 'b2', name: '第二本' }));
  let books = await library.getBooks();
  assert.deepEqual(books.map(item => item.id), ['b2', 'b1']);
  await library.saveBookItem(makeBook({ id: 'b1', name: '第一本改名' }));
  books = await library.getBooks();
  assert.deepEqual(books.map(item => item.id), ['b2', 'b1']);
  assert.equal(books[1].name, '第一本改名');
  await assert.rejects(() => library.saveBookItem(makeBook({ id: '', name: 'x' })));
});

test('书架：进度保存只动 progress，章节随条目持久化', async () => {
  store.clear();
  await library.saveBookItem(makeBook({
    id: 'p1',
    chapters: [{ title: '第一章 起点', blockIndex: 0 }, { title: '第二章 转折', blockIndex: 3 }],
  }));
  const updated = await library.saveBookProgress('p1', { blockIndex: 3, pageIndex: 7, anchorText: '某段开头' });
  assert.equal(updated.progress.blockIndex, 3);
  assert.equal(updated.progress.pageIndex, 7);
  assert.equal(updated.progress.anchorText, '某段开头');
  const reloaded = (await library.getBooks()).find(item => item.id === 'p1');
  assert.equal(reloaded.chars, 8000, '进度不得动其他字段');
  assert.deepEqual(reloaded.chapters.map(chapter => chapter.title), ['第一章 起点', '第二章 转折']);
  // 非法进度归一化：负数与 NaN 回 0
  const clamped = await library.saveBookProgress('p1', { blockIndex: -4, pageIndex: Number.NaN, anchorText: 42 });
  assert.deepEqual(clamped.progress, { blockIndex: 0, pageIndex: 0, anchorText: '42' });
  assert.equal(await library.saveBookProgress('missing', {}), null);
});

test('书架：正文读写走文件桩', async () => {
  store.clear();
  fileStore.clear();
  await library.saveBookItem(makeBook({ id: 'c1', uri: 'file:///docs/books/c1.txt' }));
  const item = (await library.getBooks())[0];
  fileStore.set(item.uri, '正文内容第一段。\n\n第二段。');
  assert.equal(await library.readBookContent(item), '正文内容第一段。\n\n第二段。');
  await assert.rejects(() => library.readBookContent({ uri: 'file:///docs/books/missing.txt' }));
  await assert.rejects(() => library.readBookContent({ uri: '' }));
});

test('书架：删除清扫分键，损坏备份原值', async () => {
  store.clear();
  await library.saveBookItem(makeBook({ id: 'd1' }));
  await library.saveBookItem(makeBook({ id: 'd2' }));
  await AsyncStorage.setItem(itemKey('ghost'), JSON.stringify(makeBook({ id: 'ghost' })));
  const { removed } = await library.deleteBooks(['d1']);
  assert.equal(removed[0].id, 'd1');
  assert.equal(store.has(itemKey('d1')), false);
  assert.equal(store.has(itemKey('ghost')), false);
  assert.equal(store.has(itemKey('d2')), true);
  corruptBackups.length = 0;
  store.set(itemKey('d2'), '{broken');
  await assert.rejects(() => library.getBooks(), /读取失败/);
  assert.deepEqual(corruptBackups, [itemKey('d2')]);
});

test('书评：追加、幂等、上限、锚归一化与随书删除', async () => {
  store.clear();
  const first = {
    id: 'm1',
    text: '这段写得真好',
    characterId: 'ch1',
    characterName: '小雪',
    anchor: { blockIndex: 2, anchorText: '页首行', excerpt: 'x'.repeat(500) },
    chapterTitle: '第一章 起点',
    createdAt: 1,
    source: 'manual',
  };
  await comments.appendBookComment('book-a', first);
  await comments.appendBookComment('book-a', { ...first });
  let list = await comments.getBookComments('book-a');
  assert.equal(list.length, 1);
  assert.equal(list[0].anchor.excerpt.length, 400, '摘录截断到 400');
  for (let index = 0; index < 55; index += 1) {
    await comments.appendBookComment('book-a', { id: `g${index}`, text: `第${index}条`, createdAt: index + 2 });
  }
  list = await comments.getBookComments('book-a');
  assert.equal(list.length, 50);
  assert.equal(list[0].id, 'g5');
  await comments.appendBookComment('book-b', { id: 'm9', text: 'y' });
  const removedKeys = await comments.deleteBookCommentsForBooks(['book-b', 'book-z']);
  assert.equal(removedKeys, 2);
  assert.deepEqual(await comments.getBookComments('book-b'), []);
  await assert.rejects(() => comments.appendBookComment('book-c', { id: 'm2', text: '  ' }));
});
