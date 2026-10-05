// 位置存储域测试：注入 AsyncStorage 与 io 桩（沿用 booksStorage.test.mjs 机制）。
// 用户裁决后的语义：**不再读取系统定位**，位置是用户自写的清单（可增删改、一次用一个）。
// 锁定：清单往返、增删改与选中回落、老数据（真实定位）迁移、非法坐标归一、
// 损坏先备份再回落/拒绝覆盖。

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

const location = loadSourceModule('src/storage/location.js');

const EMPTY_SETTINGS = {
  enabled: false,
  awareness: false,
  places: [],
  activePlaceId: '',
  seeded: false,
  tileUrl: '',
};

test('位置设置：开关与位置清单往返', async () => {
  store.clear();
  assert.deepEqual(await location.getLocationSettings(), EMPTY_SETTINGS);

  const saved = await location.saveLocationSettings({
    enabled: true,
    places: [
      { id: 'a', name: '  山东青岛  ' },
      { id: 'b', name: '霍格沃茨魔法学院', latitude: 36.07, longitude: 120.38 },
    ],
    activePlaceId: 'b',
    tileUrl: '   ',
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.awareness, false, '位置感知是纯 opt-in，缺省关闭');
  assert.equal(saved.places[0].name, '山东青岛', '名称去首尾空白');
  assert.equal(saved.places[0].latitude, null, '没填坐标 = null（虚构地点只有名字）');
  assert.equal(saved.places[1].latitude, 36.07);
  assert.equal(saved.activePlaceId, 'b');
  assert.equal(saved.tileUrl, '', '空白瓦片模板归一为空');
});

test('位置设置：增删改与选中回落（纯函数）', () => {
  const base = location.normalizeLocationSettings({ places: [{ id: 'a', name: 'A' }], activePlaceId: 'a' });

  const added = location.upsertPlace(base, { name: 'B' }, { now: 123 });
  assert.equal(added.places.length, 2);
  assert.equal(added.activePlaceId, added.places[1].id, '新增后自动选中它');
  assert.equal(added.places[1].latitude, null);

  const edited = location.upsertPlace(added, { id: 'a', name: 'A2', latitude: 1, longitude: 2 }, { now: 456 });
  assert.equal(edited.places[0].name, 'A2', '同 id = 编辑');
  assert.equal(edited.places[0].latitude, 1);
  assert.equal(edited.places.length, 2, '编辑不新增条目');
  assert.equal(edited.activePlaceId, 'a');

  const removed = location.removePlace(edited, 'a');
  assert.equal(removed.places.length, 1);
  assert.equal(removed.activePlaceId, removed.places[0].id, '删掉选中项时回落到第一条');

  // 只填半个坐标按「没填」处理（不落半个坐标）
  const half = location.upsertPlace(base, { name: 'C', latitude: 10 }, { now: 1 });
  assert.equal(half.places[1].latitude, null);

  // 名称必填：空名条目直接丢弃
  assert.equal(location.normalizePlace({ name: '   ' }), null);
  assert.equal(location.upsertPlace(base, { name: '  ' }, { now: 1 }).places.length, 1);
});

test('位置设置：老数据（真实定位）迁移为一条普通位置', () => {
  const migrated = location.normalizeLocationSettings({
    enabled: true,
    last: { latitude: 39.9042, longitude: 116.4074, description: '北京市', updatedAt: 123 },
  });
  assert.equal(migrated.places.length, 1, '老的真实定位迁成清单第一条（不丢用户数据）');
  assert.equal(migrated.places[0].name, '北京市');
  assert.equal(migrated.places[0].latitude, 39.9042);
  assert.equal(migrated.activePlaceId, migrated.places[0].id);

  // 没有 places 字段也没有 last（全新用户）：空清单——示例由界面按当前语言写入
  assert.deepEqual(location.normalizeLocationSettings({ enabled: true }).places, []);
  // 有 places 字段（哪怕空数组）就以盘上为准：用户删光后不再自动补示例
  assert.deepEqual(location.normalizeLocationSettings({ places: [] }).places, []);
});

test('位置设置：非法/零坐标归一为 null，重复 id 去重', () => {
  assert.equal(location.normalizePlace({ name: 'x', latitude: 0, longitude: 0 }).latitude, null);
  assert.equal(location.normalizePlace({ name: 'x', latitude: 999, longitude: 1 }).latitude, null);
  assert.equal(location.normalizePlace({ name: 'x', latitude: 'y', longitude: 1 }).latitude, null);
  assert.equal(location.normalizePlace({ name: 'x', latitude: -33.86, longitude: 151.2 }).latitude, -33.86);
  assert.equal(location.normalizeLocationSettings({ enabled: 'yes' }).enabled, false, '非 true 一律关闭');

  const duplicate = location.normalizeLocationSettings({
    places: [{ id: 'a', name: '一' }, { id: 'a', name: '二' }],
  });
  assert.equal(duplicate.places.length, 1, '同 id 只留第一条');

  // 选中项失效（被删/不存在）→ 回落第一条
  const stale = location.normalizeLocationSettings({ places: [{ id: 'a', name: '一' }], activePlaceId: 'gone' });
  assert.equal(stale.activePlaceId, 'a');
});

test('位置设置：损坏先备份再回落；更新时拒绝覆盖', async () => {
  store.clear();
  corruptBackups.length = 0;
  store.set(location.LOCATION_KEY, '{broken');
  const fallback = await location.getLocationSettings();
  assert.deepEqual(fallback, EMPTY_SETTINGS);
  assert.ok(corruptBackups.includes(location.LOCATION_KEY), '损坏原值必须备份');

  store.set(location.LOCATION_KEY, '{broken');
  await assert.rejects(
    () => location.updateLocationSettings(current => ({ ...current, enabled: true })),
    /读取失败/,
  );
});
