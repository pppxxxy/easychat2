import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

// characterLibrary 依赖 storage.js（会拉入 async-storage / secrets），
// 沿用仓库既有做法：babel 转译到真实源码路径后注入内存模块加载。
const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/context/characterLibrary.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

// ../storage 是原生 ESM（Node 直接解析会绕开 Module._load 拦截，并在
// expo-file-system 的扩展名解析上失败）。characterLibrary 只用到
// DEFAULT_CHARACTER 与 sortCharacters，这里按真实语义提供最小替身。
const DEFAULT_CHARACTER = {
  id: 'default',
  builtin: true,
  name: 'EasyChat2 助手',
  lastUsedAt: 0,
};
function sortCharacters(list) {
  return [...list].sort((a, b) => {
    const pinnedDiff = (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0);
    if (pinnedDiff !== 0) return pinnedDiff;
    const diff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}
const storageMock = { __esModule: true, DEFAULT_CHARACTER, sortCharacters };

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../storage.js' || request.endsWith('/storage')) return storageMock;
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const filename = path.resolve('src/context/characterLibrary.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;

const {
  resolveActiveId,
  uniqueId,
  withUpdatedCharacter,
  withSwitchedCharacter,
  withAddedCharacter,
  withDeletedCharacter,
  withPinnedCharacter,
  withDeletedCharacters,
  runWithRollback,
} = runtimeModule.exports;

const DEFAULT = { id: 'default', builtin: true, name: '助手', lastUsedAt: 0 };
const make = (id, extra = {}) => ({ ...DEFAULT, id, builtin: false, ...extra });

test('resolveActiveId：存在则保留，缺失则回落到内置卡', () => {
  const list = [make('a'), make('b')];
  assert.equal(resolveActiveId(list, 'b'), 'b');
  assert.equal(resolveActiveId(list, 'missing'), 'default');
  const withDefault = [make('a'), { ...DEFAULT }];
  assert.equal(resolveActiveId(withDefault, ''), 'default');
});

test('uniqueId：占用时追加递增后缀，空白基准生成随机卡号', () => {
  const list = [make('card'), make('card-2')];
  assert.equal(uniqueId('card', list), 'card-3');
  assert.equal(uniqueId('free', list), 'free');
  const generated = uniqueId('', list);
  assert.ok(generated.startsWith('card-'));
  assert.equal(list.some(c => c.id === generated), false);
});

test('withUpdatedCharacter：合并补丁且保留 id，支持函数补丁', () => {
  const list = [make('a', { name: '旧' })];
  const direct = withUpdatedCharacter(list, 'a', { name: '新' });
  assert.equal(direct.character.name, '新');
  assert.equal(direct.character.id, 'a');
  const viaFn = withUpdatedCharacter(list, 'a', prev => ({ name: `${prev.name}改` }));
  assert.equal(viaFn.character.name, '旧改');
  // 补丁试图改 id 也应被忽略
  const forced = withUpdatedCharacter(list, 'a', { id: 'hack' });
  assert.equal(forced.character.id, 'a');
});

test('withSwitchedCharacter：命中更新时间戳，未命中返回 found=false', () => {
  const list = [make('a'), make('b')];
  const hit = withSwitchedCharacter(list, 'a', 12345);
  assert.equal(hit.found, true);
  assert.equal(hit.character.lastUsedAt, 12345);
  const miss = withSwitchedCharacter(list, 'zzz', 1);
  assert.equal(miss.found, false);
  assert.equal(miss.character, null);
});

test('withAddedCharacter：写入新卡并清掉继承的 builtin 标记', () => {
  const list = [make('a')];
  const { list: next, character } = withAddedCharacter(list, { id: 'a', name: '重名', builtin: true }, 9);
  assert.equal(character.id, 'a-2');
  assert.equal(character.builtin, false);
  assert.equal(character.lastUsedAt, 9);
  assert.equal(next.some(c => c.id === 'a-2'), true);
});

test('withDeletedCharacter：删除后若删的是当前卡则回落，removed 标记准确', () => {
  const list = [make('a'), make('b')];
  const { list: next, activeId, removed } = withDeletedCharacter(list, 'a', 'a');
  assert.equal(removed, true);
  assert.equal(next.some(c => c.id === 'a'), false);
  assert.equal(activeId, 'default');
  const noop = withDeletedCharacter(list, 'zzz', 'a');
  assert.equal(noop.removed, false);
  assert.equal(noop.activeId, 'a');
});

test('withPinnedCharacter：置顶与取消置顶，未命中 found=false', () => {
  const list = [make('a'), make('b')];
  const pinned = withPinnedCharacter(list, 'a', true);
  assert.equal(pinned.found, true);
  assert.equal(pinned.character.pinned, true);
  const unpinned = withPinnedCharacter(list, 'a', false);
  assert.equal(unpinned.character.pinned, false);
  assert.equal(withPinnedCharacter(list, 'zzz', true).found, false);
});

test('withDeletedCharacters：批量删除，删空时补内置卡', () => {
  const list = [make('a'), make('b'), make('c')];
  const partial = withDeletedCharacters(list, ['a', 'b'], 'a');
  assert.equal(partial.removedCount, 2);
  assert.equal(partial.activeId, 'default');
  const all = withDeletedCharacters(list, ['a', 'b', 'c'], 'a');
  assert.equal(all.removedCount, 3);
  assert.equal(all.list.length, 1);
  assert.equal(all.list[0].id, 'default');
});

test('runWithRollback：成功不改动，失败回滚并抛出原错误', async () => {
  let restored = null;
  await runWithRollback('snap', s => { restored = s; }, async () => {});
  assert.equal(restored, null);
  const boom = new Error('写入失败');
  await assert.rejects(
    runWithRollback('snap', s => { restored = s; }, async () => { throw boom; }),
    err => err === boom
  );
  assert.equal(restored, 'snap');
});
