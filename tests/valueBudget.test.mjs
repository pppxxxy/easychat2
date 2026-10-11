// 单值体积预算（assertValueBudget）的行为测试（回归 2026-10-11 逐行审查 P1）。
//
// 这是**唯一的系统性防线**：Android 的 CursorWindow 单值读取上限约 2MB，越过之后
// AsyncStorage.getItem 直接抛错，只能靠 readLargeAsyncStorageValue 的 SQLite 分块兜底；
// 那条兜底一旦失败就是「聊天记录永久读不出」。所以在**写入**侧就要能查出「什么时候越过了预算」。
//
// 只报警不抛是有意的：历史数据、一次性导入、用户自己写的大角色卡可能本来就大，
// 在这里抛出去会把「能存进去」变成「存不进去」，比超标本身更糟。测试同时钉住这两面：
// ① 超预算必须留痕；② 超预算**不得**让写入失败。
//
// 走真 io.js / 真 vector.js / 真 diagnostics，只把 AsyncStorage / expo-secure-store /
// expo-file-system / expo-sqlite 四个原生边界换成替身。

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
  multiRemove: async keys => { (Array.isArray(keys) ? keys : []).forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

const FileSystem = {
  documentDirectory: 'file:///documents/',
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  // 保险箱不可用：本文件验的是体积预算，不是密钥保护（那条有专门测试）。
  if (request === 'expo-secure-store') throw new Error('secure store unavailable in tests');
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
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

globalThis.__DEV__ = false;

const io = loadModule(path.resolve('src/storage/io.js'));
const vector = loadModule(path.resolve('src/storage/vector.js'));
const { getDiagnostics, __resetDiagnosticsForTests } = loadModule(path.resolve('src/storage/diagnostics.js'));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function reset() {
  store.clear();
  __resetDiagnosticsForTests();
}

test('assertValueBudget：预算内不记诊断，返回真实字节数', async () => {
  reset();
  const json = JSON.stringify({ hello: '世界' });
  const bytes = io.assertValueBudget('@easychat2_x', json);
  assert.equal(bytes, Buffer.byteLength(json, 'utf8'), '返回的字节数要与 UTF-8 实际长度一致');
  assert.ok(bytes < io.VALUE_BUDGET_BYTES);
  assert.deepEqual(await getDiagnostics(), [], '没超预算不得留痕');
});

test('assertValueBudget：超预算记诊断（带键名与字节数），但**不抛**', async () => {
  reset();
  const json = JSON.stringify({ text: 'x'.repeat(io.VALUE_BUDGET_BYTES + 10) });
  let bytes = 0;
  assert.doesNotThrow(() => { bytes = io.assertValueBudget('@easychat2_big', json); }, '只报警不抛');
  assert.ok(bytes > io.VALUE_BUDGET_BYTES);
  await settle();
  const entries = await getDiagnostics();
  assert.equal(entries.length, 1, `应恰好记一条诊断，实际 ${entries.length}`);
  assert.equal(entries[0].kind, 'storage');
  assert.match(entries[0].message, /error\.storage\.valueBudgetExceeded/, '文案走 i18n（用户可见）');
  assert.match(entries[0].context, /@easychat2_big/, '诊断要点名是哪个键');
  assert.match(entries[0].context, new RegExp(String(io.VALUE_BUDGET_BYTES)), '诊断要带上预算值');
});

test('setJsonWithSecrets：走 io.js 写盘的配置超预算时同样留痕，且写入照常成功', async () => {
  reset();
  await io.setJsonWithSecrets('@easychat2_big_settings', { blob: 'y'.repeat(io.VALUE_BUDGET_BYTES + 10) });
  await settle();
  const entries = await getDiagnostics();
  assert.equal(entries.length, 1);
  assert.match(entries[0].context, /@easychat2_big_settings/);
  assert.ok(store.has('@easychat2_big_settings'), '超预算只报警，写入必须照常成功');
});

test('vector.js 整条向量索引塞单键：超预算时留痕（最容易越界的写入点）', async () => {
  reset();
  // 一条记忆的正文就顶到预算之上：模拟「索引 + embedding 全塞一个键」
  const index = [{
    id: 'seg-1',
    sessionId: 's1',
    messageId: 'm1',
    role: 'user',
    at: 1,
    text: 'z'.repeat(io.VALUE_BUDGET_BYTES + 10),
    vector: [0.1, 0.2, 0.3],
    signature: 'sig',
  }];

  const saved = await vector.saveVectorIndex('c1', index);
  await settle();

  assert.equal(saved.length, 1, '写入照常成功（只报警不抛）');
  assert.equal(store.has('@easychat2_vector_index::c1'), true, '值确实落盘了');
  const entries = await getDiagnostics();
  assert.equal(entries.length, 1, `应恰好记一条诊断，实际 ${entries.length}`);
  assert.match(entries[0].context, /@easychat2_vector_index::c1/, '诊断要点名向量索引键');
});

test('vector.js：正常大小的索引不留痕（别把常规路径报成故障）', async () => {
  reset();
  await vector.saveVectorIndex('c1', [{
    id: 'seg-1', sessionId: 's1', messageId: 'm1', role: 'user', at: 1,
    text: '一段普通记忆', vector: [0.1, 0.2], signature: 'sig',
  }]);
  await settle();
  assert.deepEqual(await getDiagnostics(), []);
});
