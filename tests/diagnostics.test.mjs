import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/diagnostics.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const secretsMock = {
  maskSecrets: text => String(text || '').replace(/sk-[a-zA-Z0-9]{8,}/g, '[API_KEY已隐藏]'),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === './secrets' || request.endsWith('/secrets')) return secretsMock;
  return originalLoad.call(this, request, parent, isMain);
};

function loadModule() {
  const filename = path.resolve('src/diagnostics.test-runtime.cjs');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

const mod = loadModule();
const {
  recordDiagnostic,
  getDiagnostics,
  clearDiagnostics,
  formatDiagnostics,
  normalizeDiagnostic,
  __resetDiagnosticsForTests,
} = mod;

test('记录诊断并脱敏：明文密钥不落盘', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  await recordDiagnostic('api', new Error('请求失败 sk-abcdef123456'));
  const list = await getDiagnostics();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'api');
  assert.equal(list[0].message.includes('sk-abcdef123456'), false);
  assert.ok(list[0].message.includes('[API_KEY已隐藏]'));
  // 持久化里也不含明文
  assert.equal(String(store.get('@easychat2_diagnostics')).includes('sk-abcdef123456'), false);
});

test('短窗口去重：连续同错误只留一条', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  await recordDiagnostic('storage', new Error('读取失败'));
  await recordDiagnostic('storage', new Error('读取失败'));
  await recordDiagnostic('storage', new Error('读取失败'));
  const list = await getDiagnostics();
  assert.equal(list.length, 1);
});

test('上限裁剪：只保留最近 MAX 条', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  for (let index = 0; index < 60; index += 1) {
    await recordDiagnostic('unhandled', new Error(`错误 ${index}`));
  }
  const list = await getDiagnostics();
  assert.ok(list.length <= 50);
  assert.ok(list[list.length - 1].message.includes('错误 59'));
});

test('未知 kind 归为 unhandled，格式化包含时间与内容', () => {
  const entry = normalizeDiagnostic({ kind: 'weird', message: 'x' });
  assert.equal(entry.kind, 'unhandled');
  const text = formatDiagnostics([{ at: 1700000000000, kind: 'api', message: '失败', context: 'ctx', stack: 'stack' }]);
  assert.ok(text.includes('api: 失败'));
  assert.ok(text.includes('context: ctx'));
  assert.ok(text.includes('stack'));
});

test('清空后读取为空', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  await recordDiagnostic('webview', new Error('崩溃'));
  await clearDiagnostics();
  const list = await getDiagnostics();
  assert.deepEqual(list, []);
  assert.equal(store.has('@easychat2_diagnostics'), false);
});

test('AsyncStorage 不可用时静默（不抛错）', async () => {
  store.clear();
  const previousLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: null };
    if (request === './secrets' || request.endsWith('/secrets')) return secretsMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const isolated = loadModule();
    isolated.__resetDiagnosticsForTests();
    assert.doesNotThrow(() => isolated.recordDiagnostic('api', new Error('x')));
    const list = await isolated.getDiagnostics();
    assert.deepEqual(list, []);
  } finally {
    Module._load = previousLoad;
  }
});
