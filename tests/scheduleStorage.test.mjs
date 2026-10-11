// 角色作息存储测试（P1）。加载真实现（storage/schedule.js + io + characterLifecycle），
// 在 AsyncStorage mock 上验证读写/清理/损坏兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const STORAGE_DIR = path.resolve('src/storage');
const CHAT_DIR = path.resolve('src/chat');
const store = new Map();

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

function loadModule(absPath) {
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
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/', EncodingType: {}, getInfoAsync: async () => ({ exists: false }) };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request.endsWith('/secretStore.js') || request.endsWith('/secretStore')) {
    return { __esModule: true, hydrateSecrets: value => value, protectSecrets: value => value };
  }
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if ((resolved.startsWith(`${STORAGE_DIR}${path.sep}`) || resolved.startsWith(`${CHAT_DIR}${path.sep}`))
      && fs.existsSync(resolved)) {
      return loadModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

function clearCache() {
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${STORAGE_DIR}${path.sep}`) || key.startsWith(`${CHAT_DIR}${path.sep}`)) {
      delete Module._cache[key];
    }
  });
}

function loadSchedule() {
  store.clear();
  clearCache();
  return loadModule(path.resolve('src/storage/schedule.js'));
}

test('saveCharacterSchedule / getCharacterSchedule：按角色持久化新模型', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('c1', {
    schema: 2,
    enabled: true,
    splitWeekday: true,
    workday: { segments: [{ name: '上学', start: '08:00', end: '12:00' }], events: [] },
    restday: { segments: [{ name: '睡懒觉', start: '10:00', end: '12:00' }], events: [] },
    holidays: ['2026-10-08'],
  });
  const got = await mod.getCharacterSchedule('c1');
  assert.equal(got.enabled, true);
  assert.equal(got.splitWeekday, true);
  assert.equal(got.workday.segments[0].name, '上学');
  assert.equal(got.restday.segments[0].name, '睡懒觉');
  assert.deepEqual(got.holidays, ['2026-10-08']);
  assert.equal(await mod.getCharacterSchedule('nope'), null);
});

test('读路径迁移：旧四时刻数据读到即等价的新模型（不丢用户作息）', async () => {
  const mod = loadSchedule();
  store.set('@easychat2_character_schedules', JSON.stringify({
    old: { enabled: true, wake: '06:30', workStart: '09:00', workEnd: '18:00', sleep: '23:30' },
  }));
  const got = await mod.getCharacterSchedule('old');
  assert.equal(got.schema, 2);
  assert.equal(got.enabled, true);
  assert.deepEqual(
    got.workday.segments.map(s => [s.builtin, s.start, s.end]),
    [['sleep', '23:30', '06:30'], ['work', '09:00', '18:00']]
  );
});

test('迁移写回：保存任一角色会把其它角色的旧数据一起落成新模型', async () => {
  const mod = loadSchedule();
  store.set('@easychat2_character_schedules', JSON.stringify({
    old: { enabled: true, wake: '06:30', workStart: '09:00', workEnd: '18:00', sleep: '23:30' },
  }));
  await mod.saveCharacterSchedule('fresh', { schema: 2, enabled: true });
  const raw = JSON.parse(store.get('@easychat2_character_schedules'));
  assert.equal(raw.old.schema, 2, '旧条目在下次保存时被写回成新模型');
  assert.equal(raw.old.workday.segments.length, 2);
});

test('saveCharacterSchedule：非法时间段被丢弃、非法时间回退默认', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('c2', { schema: 2, enabled: true, workday: { segments: [{ name: 'x', start: '99:99', end: '10:00' }] } });
  const got = await mod.getCharacterSchedule('c2');
  assert.deepEqual(got.workday.segments, []);
  // 完全没写过作息的角色拿到默认两段（等价旧默认四时刻）
  const empty = await mod.saveCharacterSchedule('c3', { enabled: true });
  assert.deepEqual(empty.workday.segments.map(s => [s.start, s.end]), [['23:00', '07:00'], ['09:00', '18:00']]);
});

test('getAllCharacterSchedules：返回全部角色作息', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('a', { enabled: true });
  await mod.saveCharacterSchedule('b', { enabled: false });
  const all = await mod.getAllCharacterSchedules();
  assert.deepEqual(Object.keys(all).sort(), ['a', 'b']);
});

test('deleteCharacterSchedule：删除单个条目', async () => {
  const mod = loadSchedule();
  await mod.saveCharacterSchedule('a', { enabled: true });
  assert.equal(await mod.deleteCharacterSchedule('a'), true);
  assert.equal(await mod.getCharacterSchedule('a'), null);
  assert.equal(await mod.deleteCharacterSchedule('a'), false);
});

test('角色删除钩子：整条清理，新字段（时间段/概率事件/节假日）一并清掉', async () => {
  const mod = loadSchedule();
  const lifecycle = loadModule(path.resolve('src/storage/characterLifecycle.js'));
  const rich = {
    schema: 2,
    enabled: true,
    splitWeekday: true,
    workday: { segments: [{ name: '上学', start: '08:00', end: '12:00' }], events: [{ at: '15:00', description: '买咖啡', probability: 30 }] },
    restday: { segments: [], events: [] },
    holidays: ['2026-10-08'],
  };
  await mod.saveCharacterSchedule('keep', rich);
  await mod.saveCharacterSchedule('gone', rich);
  await lifecycle.runCharacterCleanup(['gone']);
  assert.equal(await mod.getCharacterSchedule('gone'), null);
  const kept = await mod.getCharacterSchedule('keep');
  assert.ok(kept, '未删除的角色保留');
  assert.equal(kept.workday.events[0].description, '买咖啡');
  assert.deepEqual(kept.holidays, ['2026-10-08']);
  const raw = JSON.parse(store.get('@easychat2_character_schedules'));
  assert.deepEqual(Object.keys(raw), ['keep'], '存储里不留残键');
});

test('损坏存储：备份原始值后按空处理', async () => {
  const mod = loadSchedule();
  store.set('@easychat2_character_schedules', '{not json');
  const all = await mod.getAllCharacterSchedules();
  assert.deepEqual(all, {});
  assert.ok(store.has('@easychat2_character_schedules__corrupt_backup'), '损坏值已备份');
});
