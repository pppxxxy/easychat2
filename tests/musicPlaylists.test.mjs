// 音乐歌单存储域测试：注入 AsyncStorage 与 io 桩（沿用 musicLibrary.test.mjs 的机制），
// 验证建单/重命名/删除、加入移出歌单、删除歌曲的级联清理与损坏防护。

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

const playlists = loadSourceModule('src/music/playlists.js');

const KEY = '@easychat2_music_playlists';

test('歌单：新建追加在尾部，名字去空白并截断上限', async () => {
  store.clear();
  const first = await playlists.createMusicPlaylist('  通勤  ');
  assert.equal(first.name, '通勤');
  assert.deepEqual(first.songIds, []);
  const second = await playlists.createMusicPlaylist('睡前');
  const list = await playlists.getMusicPlaylists();
  assert.deepEqual(list.map(item => item.id), [first.id, second.id], '新歌单追加在尾部');
  const long = await playlists.createMusicPlaylist('长'.repeat(80));
  assert.equal(long.name.length, playlists.PLAYLIST_NAME_MAX, '超长名字截断到上限');
});

test('歌单：空名拒绝，首次读取（无键）返回空表而非损坏', async () => {
  store.clear();
  assert.deepEqual(await playlists.getMusicPlaylists(), [], '没有键时是空歌单列表');
  await assert.rejects(
    () => playlists.createMusicPlaylist('   '),
    error => error.code === playlists.PLAYLIST_ERROR.NAME_REQUIRED
  );
  assert.equal(store.get(KEY), undefined, '失败的建单不得落库');
});

test('歌单：重命名生效、空名/不存在均抛错', async () => {
  store.clear();
  const created = await playlists.createMusicPlaylist('旧名');
  const renamed = await playlists.renameMusicPlaylist(created.id, '新名');
  assert.equal(renamed.name, '新名');
  assert.equal((await playlists.getMusicPlaylists())[0].name, '新名');
  await assert.rejects(
    () => playlists.renameMusicPlaylist(created.id, ' '),
    error => error.code === playlists.PLAYLIST_ERROR.NAME_REQUIRED
  );
  await assert.rejects(
    () => playlists.renameMusicPlaylist('missing', 'x'),
    error => error.code === playlists.PLAYLIST_ERROR.NOT_FOUND
  );
});

test('歌单：删除返回被删对象；删不存在的返回 null 且不动列表', async () => {
  store.clear();
  const a = await playlists.createMusicPlaylist('A');
  const b = await playlists.createMusicPlaylist('B');
  const result = await playlists.deleteMusicPlaylist(a.id);
  assert.equal(result.removed.id, a.id);
  assert.deepEqual(result.list.map(item => item.id), [b.id]);
  const missing = await playlists.deleteMusicPlaylist('missing');
  assert.equal(missing.removed, null);
  assert.deepEqual(missing.list.map(item => item.id), [b.id], '删不存在不得改列表');
});

test('歌单：加入/移出幂等，且只动目标歌单', async () => {
  store.clear();
  const a = await playlists.createMusicPlaylist('A');
  const b = await playlists.createMusicPlaylist('B');

  const added = await playlists.setSongInPlaylist(a.id, 'song-1', true);
  assert.deepEqual(added.songIds, ['song-1']);
  const again = await playlists.setSongInPlaylist(a.id, 'song-1', true);
  assert.deepEqual(again.songIds, ['song-1'], '重复加入不产生重复项');

  await playlists.setSongInPlaylist(a.id, 'song-2', true);
  await playlists.setSongInPlaylist(b.id, 'song-2', true);
  const removed = await playlists.setSongInPlaylist(a.id, 'song-1', false);
  assert.deepEqual(removed.songIds, ['song-2']);

  const list = await playlists.getMusicPlaylists();
  assert.deepEqual(list.find(item => item.id === a.id).songIds, ['song-2']);
  assert.deepEqual(list.find(item => item.id === b.id).songIds, ['song-2'], 'B 不受 A 的增删影响');

  await assert.rejects(
    () => playlists.setSongInPlaylist('missing', 'song-1', true),
    error => error.code === playlists.PLAYLIST_ERROR.NOT_FOUND
  );
});

test('歌单：删除歌曲后级联清理所有歌单里的引用', async () => {
  store.clear();
  const a = await playlists.createMusicPlaylist('A');
  const b = await playlists.createMusicPlaylist('B');
  await playlists.setSongInPlaylist(a.id, 'keep', true);
  await playlists.setSongInPlaylist(a.id, 'gone', true);
  await playlists.setSongInPlaylist(b.id, 'gone', true);

  const changed = await playlists.purgeSongsFromPlaylists(['gone']);
  assert.equal(changed, true);
  const list = await playlists.getMusicPlaylists();
  assert.deepEqual(list.find(item => item.id === a.id).songIds, ['keep']);
  assert.deepEqual(list.find(item => item.id === b.id).songIds, [], '所有歌单都被清到');

  assert.equal(await playlists.purgeSongsFromPlaylists(['not-in-any']), false, '无改动返回 false');
  assert.equal(await playlists.purgeSongsFromPlaylists([]), false, '空入参直接返回 false');
});

test('歌单：读取损坏时抛错并备份，级联清理静默失败不阻断删除', async () => {
  store.clear();
  corruptBackups.length = 0;
  store.set(KEY, '{ not json');
  await assert.rejects(
    () => playlists.getMusicPlaylists(),
    error => error.code === playlists.PLAYLIST_ERROR.READ_FAILED
  );
  assert.ok(corruptBackups.includes(KEY), '损坏值应被备份');

  corruptBackups.length = 0;
  const purged = await playlists.purgeSongsFromPlaylists(['x']);
  assert.equal(purged, false, '清理遇到损坏返回 false，不抛错');
  assert.ok(corruptBackups.includes(KEY));
});

test('歌单：非数组结构视为损坏；条目缺 id/名字被丢弃', async () => {
  store.clear();
  corruptBackups.length = 0;
  store.set(KEY, JSON.stringify({ nope: true }));
  await assert.rejects(
    () => playlists.getMusicPlaylists(),
    error => error.code === playlists.PLAYLIST_ERROR.READ_FAILED
  );

  store.set(KEY, JSON.stringify([
    { id: 'ok', name: '有效', songIds: ['s1', 's1', '', 7] },
    { id: '', name: '缺 id' },
    { id: 'no-name', name: '  ' },
  ]));
  const list = await playlists.getMusicPlaylists();
  assert.deepEqual(list.map(item => item.id), ['ok'], '无效条目被丢弃');
  assert.deepEqual(list[0].songIds, ['s1', '7'], 'songIds 去重、去空、统一为字符串');
});
