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
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const coreStub = { sessionPlanKey: id => `@easychat2_session_plan::${id}` };

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === './sessionCore.js') return coreStub;
  return originalLoad.call(this, request, parent, isMain);
};

function loadPlan() {
  const runtimeModule = new Module(planPath);
  runtimeModule.filename = planPath;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(planPath));
  runtimeModule._compile(transformed, planPath);
  return runtimeModule.exports;
}

test.beforeEach(() => store.clear());

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
