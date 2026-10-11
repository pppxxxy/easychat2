// 角色删除清理链的**可观测性**行为测试（回归 2026-10-11 逐行审查 P1）。
//
// 问题：runCharacterCleanup 的 catch 里只有 `if (__DEV__) console.warn(...)`。
// 生产构建 __DEV__ 为假 → 整段被摇掉 →「某个域的数据没清掉」完全不可观测
//（对照 io.js：存储损坏是会 recordDiagnostic 的，同一条纪律）。用户只会看到「角色删了
// 但数据还在」，诊断日志里一条记录都没有。
//
// 附带修掉同一行的第二个隐患：`if (__DEV__)` 直接引用 Metro 全局，纯 Node 环境里
// __DEV__ 不存在 → 在 catch 里抛 ReferenceError → 把「单个域失败」升级成
// 「整个清理链失败」（后面的域全都不跑）。本文件**故意不定义 __DEV__**，
// 让这条路径真的被走到。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

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

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, String(value)); },
  removeItem: async key => { store.delete(key); },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// 刻意**不定义** globalThis.__DEV__：这条路径正是要验的（见文件头）。
assert.equal(typeof globalThis.__DEV__, 'undefined', '本文件不能定义 __DEV__，否则验不到那条路径');

const {
  onCharacterDeleted,
  runCharacterCleanup,
  __resetCharacterCleanupHooks,
} = loadModule(path.resolve('src/storage/characterLifecycle.js'));
const { getDiagnostics, __resetDiagnosticsForTests } = loadModule(path.resolve('src/storage/diagnostics.js'));

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('单个域的清理失败：不阻断后续域，且必须留下诊断记录', async () => {
  __resetCharacterCleanupHooks();
  __resetDiagnosticsForTests();
  store.clear();

  const ran = [];
  onCharacterDeleted('boom', async () => {
    ran.push('boom');
    throw new Error('域清理炸了');
  });
  onCharacterDeleted('after', async () => { ran.push('after'); });

  await runCharacterCleanup(['c1']);
  await settle();

  assert.deepEqual(ran, ['boom', 'after'], '单个域失败不得阻断后续域（也不能让整链抛出去）');
  const entries = await getDiagnostics();
  assert.equal(entries.length, 1, `应恰好记一条诊断，实际 ${entries.length}`);
  assert.equal(entries[0].kind, 'storage');
  assert.match(entries[0].message, /域清理炸了/, '原始错误要进诊断');
  assert.match(entries[0].context, /角色删除清理失败：boom/, '诊断要带上出错的域名');
});

test('清理全部成功时不记诊断（别把正常情况报成故障）', async () => {
  __resetCharacterCleanupHooks();
  __resetDiagnosticsForTests();
  store.clear();

  const ran = [];
  onCharacterDeleted('ok1', async () => { ran.push('ok1'); });
  onCharacterDeleted('ok2', async () => { ran.push('ok2'); });

  await runCharacterCleanup(['c1']);
  await settle();

  assert.deepEqual(ran, ['ok1', 'ok2']);
  assert.deepEqual(await getDiagnostics(), []);
});

test('空 id 列表直接返回，不跑任何钩子', async () => {
  __resetCharacterCleanupHooks();
  __resetDiagnosticsForTests();
  store.clear();

  const ran = [];
  onCharacterDeleted('never', async () => { ran.push('never'); });
  await runCharacterCleanup([]);
  await runCharacterCleanup(null);
  assert.deepEqual(ran, []);
});
