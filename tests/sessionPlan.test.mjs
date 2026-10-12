// O0.3：会话计划落盘（键与消息分开）的往返测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const planPath = path.resolve('src/storage/sessionPlan.js');
const transformed = babel.transformSync(fs.readFileSync(planPath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: planPath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
// 读会抛错的键（Android 单值上限 / 权限失败都是这个形态）：getItem 直接抛，判为「读不出」。
const failedGets = new Set();
const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const coreStub = { sessionPlanKey: id => `@easychat2_session_plan::${id}` };
// 诊断打桩：本文件只验「读不出有没有留痕」，真 diagnostics.js 的落盘/去重/脱敏由
// diagnostics.test.mjs 覆盖。打桩也让断言不依赖异步落盘时序。
const diagnostics = [];
const diagnosticsStub = {
  recordDiagnostic: (kind, error, context = '') => {
    diagnostics.push({
      kind: String(kind),
      message: String((error && error.message) || error || ''),
      context: String(context || ''),
    });
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === './sessionCore.js') return coreStub;
  if (request === './diagnostics.js') return diagnosticsStub;
  return originalLoad.call(this, request, parent, isMain);
};

function loadPlan() {
  const runtimeModule = new Module(planPath);
  runtimeModule.filename = planPath;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(planPath));
  runtimeModule._compile(transformed, planPath);
  return runtimeModule.exports;
}

test.beforeEach(() => {
  store.clear();
  failedGets.clear();
  diagnostics.length = 0;
});

test('sessionPlan：save → get 往返；空清单删除键', async () => {
  const { saveSessionPlan, getSessionPlan } = loadPlan();
  await saveSessionPlan('s1', [{ step: 'A', status: 'in_progress' }]);
  assert.deepEqual(await getSessionPlan('s1'), [{ step: 'A', status: 'in_progress' }]);

  await saveSessionPlan('s1', []);
  assert.deepEqual(await getSessionPlan('s1'), []);
  assert.equal(store.has('@easychat2_session_plan::s1'), false, '空清单删除键，不留空壳');
});

test('sessionPlan：坏数据/空会话 id 安全返回空', async () => {
  const { getSessionPlan, saveSessionPlan } = loadPlan();
  store.set('@easychat2_session_plan::bad', '{not json');
  assert.deepEqual(await getSessionPlan('bad'), []);
  assert.deepEqual(await getSessionPlan(''), []);
  assert.deepEqual(await saveSessionPlan('', [{ step: 'A', status: 'pending' }]), []);
});

// 读侧三态缺失只留痕（定性已下调，不是数据丢失）：返回类型刻意不变（调用方
// workspace/screen/ChatPanel.js 的 recap 注入不需要改动），但「读不出」必须可观测，
// 否则它与「确实没有计划」在诊断里同形。
test('sessionPlan：读不出 / 结构不对必须留诊断，且与「确实没有计划」可区分', async () => {
  const { getSessionPlan } = loadPlan();

  // 键不存在 = 确实没有计划：不得留痕（别把正常情况报成故障）
  assert.deepEqual(await getSessionPlan('none'), []);
  assert.deepEqual(diagnostics, [], '「确实没有计划」不该留诊断');

  // 合法 JSON 但不是清单：与读不出同形，必须留痕
  store.set('@easychat2_session_plan::wrong-shape', JSON.stringify({ step: 'A' }));
  assert.deepEqual(await getSessionPlan('wrong-shape'), []);
  assert.equal(diagnostics.length, 1, '结构不对必须留痕');
  assert.equal(diagnostics[0].kind, 'storage');
  assert.match(diagnostics[0].context, /session_plan::wrong-shape/, '诊断要指出是哪个键');

  // 坏 JSON
  diagnostics.length = 0;
  store.set('@easychat2_session_plan::bad2', '{not json');
  assert.deepEqual(await getSessionPlan('bad2'), []);
  assert.equal(diagnostics.length, 1, '坏 JSON 必须留痕');

  // 读直接抛错：返回类型不变（[]），但必须留痕，且不得改动原键
  diagnostics.length = 0;
  const raw = JSON.stringify([{ step: 'A', status: 'pending' }]);
  store.set('@easychat2_session_plan::boom', raw);
  failedGets.add('@easychat2_session_plan::boom');
  assert.deepEqual(await getSessionPlan('boom'), []);
  assert.equal(diagnostics.length, 1, '读抛错必须留痕');
  assert.match(
    diagnostics[0].message,
    /会话计划读取失败|error\.storage\.sessionPlanReadFailed/,
    '诊断文案必须自足（recordDiagnostic 会跑 maskSecrets）'
  );
  assert.equal(store.get('@easychat2_session_plan::boom'), raw, '读失败不得改动原键');
});
