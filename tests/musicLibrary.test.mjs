// 音乐库存储域测试：注入 AsyncStorage 与 io 桩（沿用 appearanceSettings.test.mjs 的机制），
// 验证索引分键读写、置顶/原位替换、打点保存、删除清扫、损坏防护与评论分键上限。

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
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

const library = loadSourceModule('src/music/library.js');
const comments = loadSourceModule('src/music/comments.js');

const INDEX_KEY = '@easychat2_music_index';
const itemKey = id => `@easychat2_music_item::${id}`;

function makeItem(overrides = {}) {
  return {
    id: `song-${Math.random().toString(36).slice(2, 8)}`,
    name: '测试歌曲',
    uri: 'file:///docs/music/abc.mp3',
    size: 1024,
    mime: 'audio/mpeg',
    addedAt: 1000,
    ...overrides,
  };
}

test('音乐库：新增置顶、已有原位替换', async () => {
  store.clear();
  const first = await library.saveMusicItem(makeItem({ id: 's1', name: '第一首' }));
  assert.equal(first.name, '第一首');
  const second = await library.saveMusicItem(makeItem({ id: 's2', name: '第二首' }));
  assert.equal(second.name, '第二首');
  let items = await library.getMusicItems();
  assert.deepEqual(items.map(item => item.id), ['s2', 's1'], '新导入应置顶');
  await library.saveMusicItem(makeItem({ id: 's1', name: '第一首改名' }));
  items = await library.getMusicItems();
  assert.deepEqual(items.map(item => item.id), ['s2', 's1'], '更新不得改变顺序');
  assert.equal(items[1].name, '第一首改名');
});

test('音乐库：必填字段缺失抛错，记录不落库', async () => {
  store.clear();
  await assert.rejects(() => library.saveMusicItem(makeItem({ id: '', name: '无 id' })));
  await assert.rejects(() => library.saveMusicItem(makeItem({ name: '无 uri', uri: '' })));
  assert.equal(store.get(INDEX_KEY), undefined, '失败保存不得写入索引');
});

test('音乐库：时长回填只改 durationMs，未知时长保持 0', async () => {
  store.clear();
  await library.saveMusicItem(makeItem({ id: 'd1' }));
  const updated = await library.saveMusicDuration('d1', 152000);
  assert.equal(updated.durationMs, 152000);
  const reloaded = (await library.getMusicItems()).find(item => item.id === 'd1');
  assert.equal(reloaded.durationMs, 152000);
  assert.equal(reloaded.name, '测试歌曲', '时长回填不得动其他字段');
  assert.equal(await library.saveMusicDuration('missing', 1000), null);
});

test('音乐库：打点整组覆盖保存且归一化排序去重', async () => {
  store.clear();
  await library.saveMusicItem(makeItem({ id: 't1' }));
  const updated = await library.saveMusicTriggers('t1', [
    { id: 'b', atMs: 62000, note: '副歌' },
    { id: 'a', atMs: 12000, note: ' '.repeat(200) + '前奏感受' },
    { id: 'b', atMs: 62000 },
    { id: 'bad', atMs: -5 },
  ]);
  assert.deepEqual(updated.triggers.map(item => item.id), ['a', 'b'], '按时间升序、同刻去重');
  assert.equal(updated.triggers[0].note, '前奏感受', '备注去除首尾空白后保存');
  const reloaded = (await library.getMusicItems()).find(item => item.id === 't1');
  assert.deepEqual(reloaded.triggers.map(item => item.id), ['a', 'b']);
  await assert.rejects(() => library.saveMusicTriggers('missing-song', []));
});

test('音乐库：删除返回被删条目并清扫陈旧分键与评论键', async () => {
  store.clear();
  await library.saveMusicItem(makeItem({ id: 'x1', uri: 'file:///docs/music/x1.mp3' }));
  await library.saveMusicItem(makeItem({ id: 'x2' }));
  await AsyncStorage.setItem(itemKey('ghost'), JSON.stringify(makeItem({ id: 'ghost' })));
  const { removed, remaining } = await library.deleteMusicItems(['x1']);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].uri, 'file:///docs/music/x1.mp3');
  assert.equal(remaining.length, 1);
  assert.equal(store.has(itemKey('x1')), false, '被删条目分键应清除');
  assert.equal(store.has(itemKey('ghost')), false, '索引外的幽灵分键应清扫');
  assert.equal(store.has(itemKey('x2')), true);
});

test('音乐库：索引正常但条目损坏时抛错并备份原值', async () => {
  store.clear();
  await library.saveMusicItem(makeItem({ id: 'c1' }));
  store.set(itemKey('c1'), '{broken json');
  await assert.rejects(() => library.getMusicItems(), /读取失败/);
  assert.deepEqual(corruptBackups, [itemKey('c1')], '损坏原值必须先备份');
});

test('音乐库：uri 落库前登记媒体保护', async () => {
  store.clear();
  // markMediaWrite 是真实模块（纯内存）：直接观测保护集合的变化。
  const protection = await import('../src/storage/mediaProtection.js');
  const before = protection.isRecentMediaUri('file:///docs/music/protected.mp3');
  await library.saveMusicItem(makeItem({ id: 'p1', uri: 'file:///docs/music/protected.mp3' }));
  assert.equal(before, false);
  assert.equal(protection.isRecentMediaUri('file:///docs/music/protected.mp3'), true);
});

test('音乐评论：追加、同 id 幂等、上限 50 丢最旧', async () => {
  store.clear();
  const first = { id: 'm1', text: '前奏不错', characterId: 'ch1', characterName: '小雪', atMs: 1000, createdAt: 1, source: 'opening' };
  await comments.appendMusicComment('song-a', first);
  await comments.appendMusicComment('song-a', { ...first });
  let list = await comments.getMusicComments('song-a');
  assert.equal(list.length, 1, '同 id 重复追加应幂等');
  for (let index = 0; index < 55; index += 1) {
    await comments.appendMusicComment('song-a', { id: `g${index}`, text: `第${index}条`, atMs: index * 1000, createdAt: index + 2 });
  }
  list = await comments.getMusicComments('song-a');
  assert.equal(list.length, 50, '超出上限应丢最旧');
  assert.equal(list[0].id, 'g5', '最旧的 m1..g4 被裁掉');
  assert.equal(list[49].id, 'g54');
  assert.equal(list[49].source, 'manual', '未登记来源回退 manual');
});

test('音乐评论：损坏列表回落为空并备份；清空与随歌删除', async () => {
  store.clear();
  await comments.appendMusicComment('song-b', { id: 'm1', text: '好听' });
  store.set(comments.musicCommentsKey('song-c'), 'not json');
  corruptBackups.length = 0;
  assert.deepEqual(await comments.getMusicComments('song-c'), []);
  assert.deepEqual(corruptBackups, [comments.musicCommentsKey('song-c')]);
  await comments.clearMusicComments('song-b');
  assert.deepEqual(await comments.getMusicComments('song-b'), []);
  await comments.appendMusicComment('song-d', { id: 'm1', text: 'x' });
  const removedKeys = await comments.deleteMusicCommentsForSongs(['song-d', 'song-e']);
  assert.equal(removedKeys, 2);
  assert.equal(store.has(comments.musicCommentsKey('song-d')), false);
});

test('音乐评论：文本为空的评论不落库', async () => {
  store.clear();
  await assert.rejects(() => comments.appendMusicComment('song-f', { id: 'm1', text: '   ' }));
  assert.deepEqual(await comments.getMusicComments('song-f'), []);
});
