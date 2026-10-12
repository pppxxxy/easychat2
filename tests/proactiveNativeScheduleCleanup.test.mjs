// 角色删除 → 原生日程清理的**行为**测试（回归 2026-10-11 审查待办第 5 项）。
//
// 被钉住的缺陷：JS 侧的作息（storage/schedule.js）与定时 Agent 任务（storage/agentTasks.js）
// 各有自己的 onCharacterDeleted 钩子，但原生闹钟/Worker 是**另一份存储**（Kotlin MessageStore）。
// 删角色只清 JS 会留下「到点仍被系统唤起、JS 侧却已没有这个角色」的僵尸定时器：白耗电，
// 且可能按已删角色的旧快照发消息。此前 cancelRoleSchedules / cancelAgentTasksForRole 都**没有调用方**。
//
// 本文件用真模块 + 真 characterLifecycle，只把 react-native 的 NativeModules 换成可记录的替身，
// 断言：钩子确实注册了、删角色时按 id 逐个调用原生 cancelRole、单个失败不阻断其余角色、
// 原生缺席（iOS / 旧构建）时不抛也不误调。

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

// 原生替身：测试用 currentNative 换（null = 原生缺席）。
let currentNative = null;

class FakeNativeEventEmitter {
  constructor() {}
  addListener() { return { remove() {} }; }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'react-native') {
    return {
      __esModule: true,
      NativeModules: { ProactiveMessage: currentNative },
      Platform: { OS: 'android' },
      NativeEventEmitter: FakeNativeEventEmitter,
      PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
    };
  }
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

// 载入一对「全新的」characterLifecycle + proactiveMessage：清缓存以便换原生替身重载，
// 且保证两边拿到的是同一个 characterLifecycle 实例（否则钩子注册在一个、清理跑在另一个）。
function loadFreshGraph() {
  const lifecyclePath = path.resolve('src/storage/characterLifecycle.js');
  const proactivePath = path.resolve('src/proactive/proactiveMessage.js');
  delete Module._cache[lifecyclePath];
  delete Module._cache[proactivePath];
  const lifecycle = loadModule(lifecyclePath);
  const proactive = loadModule(proactivePath);
  return { lifecycle, proactive };
}

test('角色删除的清理钩子已注册到 proactive 域（谁的数据谁负责）', () => {
  currentNative = { cancelRole: async () => true };
  const { lifecycle } = loadFreshGraph();
  assert.ok(
    lifecycle.__listCharacterCleanupHooks().includes('proactiveNativeSchedules'),
    'proactiveNativeSchedules 必须注册到角色生命周期，否则原生闹钟永不清理'
  );
});

test('删角色：按 id 逐个调用原生 cancelRole', async () => {
  const calls = [];
  currentNative = { cancelRole: async roleId => { calls.push(roleId); return true; } };
  const { lifecycle } = loadFreshGraph();

  await lifecycle.runCharacterCleanup(['c1', 'c2']);

  assert.deepEqual(calls, ['c1', 'c2'], '被删的两个角色都应各调一次原生取消');
});

test('单个角色的原生取消失败，不阻断其余角色（尽力而为）', async () => {
  const calls = [];
  currentNative = {
    cancelRole: async roleId => {
      calls.push(roleId);
      if (roleId === 'c1') throw new Error('native boom');
      return true;
    },
  };
  const { lifecycle } = loadFreshGraph();

  // 不应抛出：runCharacterCleanup 逐个 try/catch，失败只记诊断。
  await lifecycle.runCharacterCleanup(['c1', 'c2', 'c3']);

  assert.deepEqual(calls, ['c1', 'c2', 'c3'], 'c1 失败也必须继续清 c2/c3');
});

test('原生同步抛异常也被吞掉，不阻断后续角色', async () => {
  const calls = [];
  currentNative = {
    cancelRole: roleId => {
      calls.push(roleId);
      if (roleId === 'c1') throw new Error('sync boom');
      return true; // 旧实现可能同步返回布尔，而非 Promise
    },
  };
  const { lifecycle } = loadFreshGraph();

  await lifecycle.runCharacterCleanup(['c1', 'c2']);

  assert.deepEqual(calls, ['c1', 'c2'], '同步抛 + 同步返回布尔两种形态都要容错');
});

test('原生缺席（iOS / 旧构建）：不抛、不误调', async () => {
  currentNative = null;
  const { lifecycle } = loadFreshGraph();

  // 不该抛：钩子里有原生可用性守卫。
  await lifecycle.runCharacterCleanup(['c1']);
  assert.ok(true);
});

test('原生存在但没有 cancelRole 方法：静默跳过（旧版本模块）', async () => {
  currentNative = { schedule: async () => 'slot' };
  const { lifecycle } = loadFreshGraph();

  await lifecycle.runCharacterCleanup(['c1']);
  assert.ok(true);
});

test('空 id 不调用原生（避免把空串当 roleId 传下去）', async () => {
  const calls = [];
  currentNative = { cancelRole: async roleId => { calls.push(roleId); return true; } };
  const { lifecycle } = loadFreshGraph();

  await lifecycle.runCharacterCleanup(['c1', '', '  ']);

  assert.deepEqual(calls, ['c1'], '空白 id 必须被过滤');
});

test('agentTaskNative 不再重复导出角色级取消（避免两个入口各写一遍）', () => {
  const source = fs.readFileSync(path.resolve('src/agent/task/agentTaskNative.js'), 'utf8');
  assert.equal(
    /export function cancelAgentTasksForRole/.test(source),
    false,
    'cancelAgentTasksForRole 已由 proactive 的 onCharacterDeleted 钩子统一承担，不应再留重复导出'
  );
  // 但注释必须解释「为什么不在这里做」，否则下次又有人加回来。
  assert.ok(source.includes('cancelRole'), '文件里应留下指向 proactive 钩子的说明');
});
