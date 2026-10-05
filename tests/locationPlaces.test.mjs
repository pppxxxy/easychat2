// 地图标注点（我的位置）测试：新增/删除/选中、坏数据与幽灵 id 归一。
// 与 locationStorage.test.mjs 同机制：注入 AsyncStorage 与 io 桩。

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

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
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
    return {
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
    };
  },
  backupCorruptValue: async () => {},
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

const location = loadSourceModule('src/storage/location.js');

test('标注点：新增并自动选中，名称去空白、坐标保留', async () => {
  store.clear();
  const saved = await location.addNamedLocation({ name: '  家  ', latitude: 39.9, longitude: 116.4 }, 1000);
  assert.equal(saved.locations.length, 1);
  const entry = saved.locations[0];
  assert.equal(entry.name, '家', '名称去首尾空白');
  assert.equal(entry.latitude, 39.9);
  assert.equal(entry.longitude, 116.4);
  assert.equal(entry.createdAt, 1000);
  assert.ok(entry.id, '生成 id');
  assert.equal(saved.activeLocationId, entry.id, '新增后自动选中');

  const readBack = await location.getNamedLocations();
  assert.equal(readBack.length, 1, '持久化后可读回');
  assert.equal(readBack[0].name, '家');
});

test('标注点：name 缺省为空串，坐标非法直接抛错（不落坏点）', async () => {
  store.clear();
  const saved = await location.addNamedLocation({ latitude: 1.5, longitude: 2.5 }, 1);
  assert.equal(saved.locations[0].name, '', '缺省名称归一为空串');
  await assert.rejects(() => location.addNamedLocation({ latitude: 0, longitude: 0 }), /坐标无效/);
  await assert.rejects(() => location.addNamedLocation({ latitude: 'x', longitude: 1 }), /坐标无效/);
  await assert.rejects(() => location.addNamedLocation({ latitude: 999, longitude: 1 }), /坐标无效/);
});

test('标注点：删除只清自己的选中，不影响别的选中项', async () => {
  store.clear();
  const first = await location.addNamedLocation({ name: 'A', latitude: 1.1, longitude: 2.2 }, 1);
  const idA = first.locations[0].id;
  const second = await location.addNamedLocation({ name: 'B', latitude: 3.3, longitude: 4.4 }, 2);
  const idB = second.locations[1].id;
  assert.equal(second.activeLocationId, idB, '后加的成为选中');

  // 删掉未选中的 A：选中仍应是 B。
  const afterRemoveA = await location.removeNamedLocation(idA);
  assert.equal(afterRemoveA.locations.length, 1);
  assert.equal(afterRemoveA.activeLocationId, idB, '删非选中项不影响选中');

  // 删掉选中的 B：选中清空，回落 GPS 当前位置。
  const afterRemoveB = await location.removeNamedLocation(idB);
  assert.equal(afterRemoveB.locations.length, 0);
  assert.equal(afterRemoveB.activeLocationId, '', '删选中项后清空选中');
});

test('标注点：setActiveLocationId 只认已存在的点（幽灵 id 归一为空）', async () => {
  store.clear();
  const withPoint = await location.addNamedLocation({ name: 'A', latitude: 1, longitude: 2 }, 1);
  const id = withPoint.locations[0].id;

  const cleared = await location.setActiveLocationId('');
  assert.equal(cleared.activeLocationId, '', '传空串=取消选中');

  const ghost = await location.setActiveLocationId('loc-not-exist');
  assert.equal(ghost.activeLocationId, '', '不存在的 id 不接受');

  const picked = await location.setActiveLocationId(id);
  assert.equal(picked.activeLocationId, id);
});

test('标注点：归一化丢坏数据、按 id 去重、修掉幽灵 activeLocationId', () => {
  const normalized = location.normalizeLocationSettings({
    locations: [
      { id: 'a', name: '好点', latitude: 39.9, longitude: 116.4 },
      { id: 'a', name: '重复 id', latitude: 1, longitude: 2 },
      { id: 'b', name: '零坐标', latitude: 0, longitude: 0 },
      { id: 'c', name: '越界', latitude: 999, longitude: 1 },
      'not-an-object',
      { id: 'd', name: 'x'.repeat(80), latitude: 3, longitude: 4 },
    ],
    activeLocationId: 'nope',
  });
  assert.deepEqual(normalized.locations.map(item => item.id), ['a', 'd'], '坏数据被丢弃、重复 id 保留首条');
  assert.equal(normalized.locations[0].name, '好点');
  assert.equal(normalized.locations[1].name.length, 40, '名称截断到 40 字');
  assert.equal(normalized.activeLocationId, '', '指向不存在的点 → 清空');

  const kept = location.normalizeLocationSettings({
    locations: [{ id: 'a', latitude: 1, longitude: 2 }],
    activeLocationId: 'a',
  });
  assert.equal(kept.activeLocationId, 'a', '存在的点保留选中');

  // 旧数据（完全没有 locations 字段）不因升级而丢开关/位置语义。
  const legacy = location.normalizeLocationSettings({ enabled: true, last: { latitude: 1, longitude: 2 } });
  assert.equal(legacy.enabled, true);
  assert.deepEqual(legacy.locations, []);
  assert.equal(legacy.activeLocationId, '');
});

test('makeLocationId：生成唯一、可用的 id', () => {
  const ids = new Set(Array.from({ length: 50 }, () => location.makeLocationId()));
  assert.equal(ids.size, 50, '批量生成不重复');
  for (const id of ids) assert.ok(id.startsWith('loc-') && id.length > 8);
});
