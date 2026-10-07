// 记忆冲突记录存储域：往返 / 分区 / 决议保留 / 关联清理 / 上限 / 坏数据降级。
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
  readJsonStatus: async key => {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    try {
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
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

const conflicts = loadSourceModule('src/storage/memoryConflicts.js');

function record(overrides = {}) {
  return {
    key: 'k1',
    aKey: 'A',
    bKey: 'B',
    aText: '喜欢猫',
    bText: '讨厌猫',
    score: 0.9,
    conflict: true,
    reason: '结论相反',
    at: 100,
    ...overrides,
  };
}

test('冲突存储：按角色分区往返，互不影响', async () => {
  store.clear();
  assert.deepEqual(await conflicts.getMemoryConflicts('c1'), [], '没有记录返回空数组');

  await conflicts.upsertMemoryConflicts('c1', [record()]);
  await conflicts.upsertMemoryConflicts('c2', [record({ key: 'k9', aKey: 'X', bKey: 'Y' })]);

  const c1 = await conflicts.getMemoryConflicts('c1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].aText, '喜欢猫');
  assert.equal((await conflicts.getMemoryConflicts('c2'))[0].key, 'k9');
  assert.deepEqual(await conflicts.getMemoryConflicts(''), [], '空 id 不读不写');
});

test('冲突存储：upsert 按 key 去重，且不覆盖用户已做的决议', async () => {
  store.clear();
  await conflicts.upsertMemoryConflicts('c1', [record()]);
  await conflicts.resolveMemoryConflict('c1', 'k1', 'ignored');

  await conflicts.upsertMemoryConflicts('c1', [record({ reason: '重新判定' })]);
  const list = await conflicts.getMemoryConflicts('c1');
  assert.equal(list.length, 1, '同一对不会写两条');
  assert.equal(list[0].reason, '重新判定', '判定内容更新');
  assert.equal(list[0].resolution, 'ignored', '用户已做的决议不能被重扫抹掉');
});

test('冲突存储：删除记忆时连带清掉牵涉它的记录', async () => {
  store.clear();
  await conflicts.upsertMemoryConflicts('c1', [
    record({ key: 'k1', aKey: 'A', bKey: 'B' }),
    record({ key: 'k2', aKey: 'B', bKey: 'C' }),
    record({ key: 'k3', aKey: 'C', bKey: 'D' }),
  ]);
  await conflicts.removeMemoryConflictsForMemories('c1', ['B']);
  assert.deepEqual((await conflicts.getMemoryConflicts('c1')).map(item => item.key), ['k3']);
});

test('冲突存储：清空只清该角色', async () => {
  store.clear();
  await conflicts.upsertMemoryConflicts('c1', [record()]);
  await conflicts.upsertMemoryConflicts('c2', [record()]);
  await conflicts.clearMemoryConflicts('c1');
  assert.deepEqual(await conflicts.getMemoryConflicts('c1'), []);
  assert.equal((await conflicts.getMemoryConflicts('c2')).length, 1);
});

test('冲突存储：超出上限时丢最旧的判定', async () => {
  store.clear();
  const many = Array.from({ length: conflicts.MAX_CONFLICT_RECORDS + 5 }, (unused, index) => record({
    key: `k${index}`,
    at: index + 1,
  }));
  await conflicts.upsertMemoryConflicts('c1', many);
  const list = await conflicts.getMemoryConflicts('c1');
  assert.equal(list.length, conflicts.MAX_CONFLICT_RECORDS, '记录数收敛到上限');
  assert.ok(!list.some(item => item.key === 'k0'), '最旧的被淘汰');
  assert.ok(list.some(item => item.key === `k${conflicts.MAX_CONFLICT_RECORDS + 4}`), '最新的保留');
});

test('冲突存储：坏 JSON 与缺 key 的脏记录都不崩', async () => {
  store.clear();
  await AsyncStorage.setItem(conflicts.MEMORY_CONFLICT_PREFIX + '::c1', '{ not json');
  assert.deepEqual(await conflicts.getMemoryConflicts('c1'), [], '坏数据当作没有记录');

  await AsyncStorage.setItem(conflicts.MEMORY_CONFLICT_PREFIX + '::c1', JSON.stringify([
    record(),
    { aKey: 'no-key' },
    null,
  ]));
  const list = await conflicts.getMemoryConflicts('c1');
  assert.equal(list.length, 1, '缺 key 的记录被丢掉');
});

test('冲突存储：清空后不留空键', async () => {
  store.clear();
  await conflicts.upsertMemoryConflicts('c1', [record()]);
  assert.ok(store.has(conflicts.MEMORY_CONFLICT_PREFIX + '::c1'));
  await conflicts.clearMemoryConflicts('c1');
  assert.equal(store.has(conflicts.MEMORY_CONFLICT_PREFIX + '::c1'), false);
});
