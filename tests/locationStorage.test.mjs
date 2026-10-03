// 位置存储域测试：注入 AsyncStorage 与 io 桩（沿用 booksStorage.test.mjs 机制）。
// 锁定开关/最近位置往返、非法坐标归一、损坏先备份再回落/拒绝覆盖。

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

test('位置设置：开关与最近位置往返', async () => {
  store.clear();
  assert.deepEqual(await location.getLocationSettings(), { enabled: false, last: null, tileUrl: '' });

  const saved = await location.saveLocationSettings({
    enabled: true,
    last: { latitude: 39.9042, longitude: 116.4074, description: '  北京市  ', updatedAt: 123 },
    tileUrl: '   ',
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.last.description, '北京市', '描述去首尾空白');
  assert.equal(saved.last.updatedAt, 123);
  assert.equal(saved.tileUrl, '', '空白瓦片模板归一为空');

  const updated = await location.setLastLocation({ latitude: 1, longitude: 2, updatedAt: 9 });
  assert.equal(updated.enabled, true, 'setLastLocation 不影响开关');
  assert.equal(updated.last.latitude, 1);
  assert.equal(updated.last.description, '');
});

test('位置设置：非法/零坐标归一为 null', () => {
  assert.equal(location.normalizeLocationSettings({ last: { latitude: 0, longitude: 0 } }).last, null);
  assert.equal(location.normalizeLocationSettings({ last: { latitude: 999, longitude: 1 } }).last, null);
  assert.equal(location.normalizeLocationSettings({ last: { latitude: 'x', longitude: 1 } }).last, null);
  assert.equal(location.normalizeLocationSettings({ last: { latitude: -33.86, longitude: 151.2 } }).last.latitude, -33.86);
  assert.equal(location.normalizeLocationSettings({ enabled: 'yes' }).enabled, false, '非 true 一律关闭');
});

test('位置设置：损坏先备份再回落；更新时拒绝覆盖', async () => {
  store.clear();
  corruptBackups.length = 0;
  store.set(location.LOCATION_KEY, '{broken');
  const fallback = await location.getLocationSettings();
  assert.deepEqual(fallback, { enabled: false, last: null, tileUrl: '' });
  assert.ok(corruptBackups.includes(location.LOCATION_KEY), '损坏原值必须备份');

  store.set(location.LOCATION_KEY, '{broken');
  await assert.rejects(
    () => location.updateLocationSettings(current => ({ ...current, enabled: true })),
    /读取失败/,
  );
});
