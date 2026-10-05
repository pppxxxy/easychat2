// 书架分组存储域测试：注入 AsyncStorage 与 io 桩（沿用 musicPlaylists.test.mjs 的机制），
// 重点验证与歌单共用工厂后的**领域映射**——条目字段为 bookIds、错误码前缀为 shelf。

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
    // 本地相对依赖同样走转译：源码含 import 语法，交给原生加载器会按 ESM 解析并炸在
    // 其深层依赖上（ERR_MODULE_NOT_FOUND）。递归转译后与主模块共用同一套桩。
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

const shelves = loadSourceModule('src/books/shelves.js');

const KEY = '@easychat2_book_shelves';

test('书架分组：建/改名/删除走通用工厂，条目字段为 bookIds', async () => {
  store.clear();
  const created = await shelves.createBookShelf('  在追  ');
  assert.equal(created.name, '在追');
  assert.deepEqual(created.bookIds, [], '条目字段是 bookIds（不是歌单的 songIds）');

  const renamed = await shelves.renameBookShelf(created.id, '已读完');
  assert.equal(renamed.name, '已读完');

  const { removed, list } = await shelves.deleteBookShelf(created.id);
  assert.equal(removed.id, created.id);
  assert.deepEqual(list, []);
});

test('书架分组：加入/移出幂等且只动目标分组', async () => {
  store.clear();
  const a = await shelves.createBookShelf('A');
  const b = await shelves.createBookShelf('B');

  await shelves.setBookInShelf(a.id, 'book-1', true);
  const again = await shelves.setBookInShelf(a.id, 'book-1', true);
  assert.deepEqual(again.bookIds, ['book-1'], '重复加入不产生重复项');
  await shelves.setBookInShelf(b.id, 'book-2', true);

  const removed = await shelves.setBookInShelf(a.id, 'book-1', false);
  assert.deepEqual(removed.bookIds, []);

  const list = await shelves.getBookShelves();
  assert.deepEqual(list.find(item => item.id === a.id).bookIds, []);
  assert.deepEqual(list.find(item => item.id === b.id).bookIds, ['book-2'], 'B 不受影响');
});

test('书架分组：删除书籍后级联清理引用', async () => {
  store.clear();
  const a = await shelves.createBookShelf('A');
  const b = await shelves.createBookShelf('B');
  await shelves.setBookInShelf(a.id, 'keep', true);
  await shelves.setBookInShelf(a.id, 'gone', true);
  await shelves.setBookInShelf(b.id, 'gone', true);

  assert.equal(await shelves.purgeBooksFromShelves(['gone']), true);
  const list = await shelves.getBookShelves();
  assert.deepEqual(list.find(item => item.id === a.id).bookIds, ['keep']);
  assert.deepEqual(list.find(item => item.id === b.id).bookIds, []);
  assert.equal(await shelves.purgeBooksFromShelves(['not-present']), false);
  assert.equal(await shelves.purgeBooksFromShelves([]), false);
});

test('书架分组：错误码前缀为 shelf，损坏时抛错并备份', async () => {
  store.clear();
  assert.equal(shelves.SHELF_ERROR.NAME_REQUIRED, 'shelf-name-required');
  assert.equal(shelves.SHELF_ERROR.NOT_FOUND, 'shelf-not-found');
  assert.equal(shelves.SHELF_ERROR.READ_FAILED, 'shelf-read-failed');

  await assert.rejects(
    () => shelves.createBookShelf('   '),
    error => error.code === shelves.SHELF_ERROR.NAME_REQUIRED
  );
  await assert.rejects(
    () => shelves.renameBookShelf('missing', 'x'),
    error => error.code === shelves.SHELF_ERROR.NOT_FOUND
  );

  corruptBackups.length = 0;
  store.set(KEY, '{ not json');
  await assert.rejects(
    () => shelves.getBookShelves(),
    error => error.code === shelves.SHELF_ERROR.READ_FAILED
  );
  assert.ok(corruptBackups.includes(KEY), '损坏值应被备份');

  // 首次无键 = 空列表（不是损坏）
  store.clear();
  assert.deepEqual(await shelves.getBookShelves(), []);
});
