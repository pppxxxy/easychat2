import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/storage/diagnostics.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
// 可控开关：模拟 AsyncStorage 读失败（getItem 抛错）。用它验证「读失败 ≠ 没有记录」
// 与「读不出原值就不写」。
let readFails = false;
// 可控开关：模拟清空失败（removeItem 抛错）。
let removeFails = false;
const AsyncStorage = {
  getItem: async key => {
    if (readFails) throw new Error('read failed');
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => {
    if (removeFails) throw new Error('remove failed');
    store.delete(key);
  },
};
const secretsMock = {
  maskSecrets: text => String(text || '').replace(/sk-[a-zA-Z0-9]{8,}/g, '[API_KEY已隐藏]'),
};

// 可控开关：模拟「脱敏器模块加载失败」。用它验证 fail-closed 与「失败不被缓存」。
let secretsLoadFails = false;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === './secrets.js' || request.endsWith('/secrets')) {
    if (secretsLoadFails) throw new Error('secrets module unavailable');
    return secretsMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadModule() {
  const filename = path.resolve('src/storage/diagnostics.js');
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

test('并发记录不丢日志（读-改-写整体串行化）', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  await Promise.all([
    recordDiagnostic('api', new Error('并发A')),
    recordDiagnostic('api', new Error('并发B')),
    recordDiagnostic('api', new Error('并发C')),
  ]);
  const messages = (await getDiagnostics()).map(entry => entry.message);
  assert.ok(messages.includes('并发A'));
  assert.ok(messages.includes('并发B'));
  assert.ok(messages.includes('并发C'));
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

// ---- 脱敏 fail-closed（回归：脱敏器不可用时曾回落原文，且失败被粘性缓存）----
// 哨兵串刻意「一眼可辨」：它只要出现在诊断里，就是写了明文密钥。
const SENTINEL = 'sk-SENTINEL-12345';

test('脱敏器不可用：省略文本，绝不落原文', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  secretsLoadFails = true;
  try {
    await recordDiagnostic('api', new Error(`请求失败 ${SENTINEL}`), `上下文 ${SENTINEL}`);
  } finally {
    secretsLoadFails = false;
  }
  const list = await getDiagnostics();
  assert.equal(list.length, 1);
  assert.equal(list[0].message.includes(SENTINEL), false, 'message 不得出现原文');
  assert.equal(list[0].context.includes(SENTINEL), false, 'context 不得出现原文');
  assert.ok(list[0].message.length > 0, '应留占位符（省略 ≠ 静默留空）');
  assert.notEqual(list[0].message, `请求失败 ${SENTINEL}`, '绝不能回落原文');
  assert.equal(
    String(store.get('@easychat2_diagnostics')).includes(SENTINEL),
    false,
    '持久化里也不得出现原文'
  );
});

test('脱敏器加载失败不被缓存：恢复后下一次调用会重试并真正脱敏', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  secretsLoadFails = true;
  try {
    await recordDiagnostic('api', new Error(`第一次 ${SENTINEL}`));
  } finally {
    secretsLoadFails = false;
  }
  // 第二次：模块已可加载。若失败被缓存（旧实现 maskSecretsLoaded 先置位），
  // 这里仍然拿不到脱敏器 → 仍会看到哨兵原文。
  await recordDiagnostic('api', new Error(`第二次 ${SENTINEL}`));
  const list = await getDiagnostics();
  const second = list[list.length - 1];
  assert.equal(second.message.includes(SENTINEL), false, '第二次不得出现原文');
  assert.ok(second.message.includes('[API_KEY已隐藏]'), '第二次应已重试并拿到脱敏器');
});

test('脱敏器抛错：同样 fail-closed，不落原文', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  const previousLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
    if (request === './secrets.js' || request.endsWith('/secrets')) {
      return { maskSecrets: () => { throw new Error('masker boom'); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const isolated = loadModule();
    isolated.__resetDiagnosticsForTests();
    await isolated.recordDiagnostic('api', new Error(`炸了 ${SENTINEL}`));
    const list = await isolated.getDiagnostics();
    assert.equal(list[0].message.includes(SENTINEL), false, '脱敏器抛错时不得回落原文');
    assert.ok(list[0].message.length > 0);
  } finally {
    Module._load = previousLoad;
  }
});

test('AsyncStorage 不可用时静默（不抛错）', async () => {
  store.clear();
  const previousLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: null };
    if (request === './secrets.js' || request.endsWith('/secrets')) return secretsMock;
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

// ---- 读失败 fail-closed（回归：读失败曾被当成「没有记录」，并把存储里几十条历史覆盖成一条）----
const DIAGNOSTICS_KEY = '@easychat2_diagnostics';
const DIAGNOSTICS_CORRUPT_KEY = `${DIAGNOSTICS_KEY}__corrupt_backup`;

test('读失败（getItem 抛错）：抛错而不是把失败说成「没有记录」', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  store.set(DIAGNOSTICS_KEY, JSON.stringify([{ at: 1, kind: 'api', message: '历史' }]));
  readFails = true;
  try {
    // 旧实现：catch 里 cache = [] 后正常返回 ⇒ UI 的 entries.length === 0 显示成
    // 绿勾「暂无可查看的记录」，把「读不出来」说成「一切正常」。
    await assert.rejects(() => getDiagnostics(), /read failed/);
  } finally {
    readFails = false;
  }
  assert.ok(store.has(DIAGNOSTICS_KEY), '读失败本身不改动存储');
  // 连 getItem 都抛错时手里没有字节，没有可备份的原值（与 io.js 的 backupCorruptValue 同）。
  assert.equal(store.has(DIAGNOSTICS_CORRUPT_KEY), false);
});

test('结构损坏（JSON.parse 失败）：抛错 + 先留原始字节的副本，不当成空记录', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  store.set(DIAGNOSTICS_KEY, '{ not valid json');
  await assert.rejects(() => getDiagnostics());
  assert.equal(store.get(DIAGNOSTICS_CORRUPT_KEY), '{ not valid json', '覆盖不可逆：先备份原始字节');
  assert.equal(store.get(DIAGNOSTICS_KEY), '{ not valid json', '原键本身不动');
});

test('读失败不被缓存：恢复后能重新读到完整历史（旧实现把失败态钉死在内存）', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  await recordDiagnostic('api', new Error('历史一'));
  await recordDiagnostic('storage', new Error('历史二'));
  __resetDiagnosticsForTests(); // 清内存缓存：模拟「重启后首次读取」
  readFails = true;
  try {
    await assert.rejects(() => getDiagnostics(), /read failed/);
  } finally {
    readFails = false;
  }
  const list = await getDiagnostics();
  assert.equal(list.length, 2, '失败态不得被缓存（旧实现 cache=[] 为真值，会永久返回空）');
  assert.ok(list.some(entry => entry.message.includes('历史一')));
});

test('读失败期间记录新诊断：不覆盖历史（读不出原值就不写）', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  await recordDiagnostic('api', new Error('历史'));
  const history = store.get(DIAGNOSTICS_KEY);
  __resetDiagnosticsForTests();
  readFails = true;
  try {
    await recordDiagnostic('webview', new Error('失败期间的新诊断'));
  } finally {
    readFails = false;
  }
  assert.equal(store.get(DIAGNOSTICS_KEY), history, '读失败期间不得把历史整份覆盖成一条');
});

test('清空失败：向调用方抛错，且不清内存缓存（旧实现永不 reject，UI 假清空）', async () => {
  __resetDiagnosticsForTests();
  store.clear();
  await recordDiagnostic('api', new Error('历史'));
  removeFails = true;
  try {
    // 旧实现把 removeItem 的失败吞在内部 ⇒ 这里永远不会 reject，调用方的 .catch 是死代码。
    await assert.rejects(() => clearDiagnostics(), /remove failed/);
  } finally {
    removeFails = false;
  }
  assert.ok(store.has(DIAGNOSTICS_KEY), '删失败时存储里的记录必须还在');
  const list = await getDiagnostics();
  assert.equal(list.length, 1, '删失败时缓存也必须保留：界面不能显示成已清空');
  assert.ok(list[0].message.includes('历史'));
});
