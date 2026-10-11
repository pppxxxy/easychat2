// src/storage/agentTasks.js 的**真实模块**行为测试（回归 2026-10-11 逐行审查 P1）。
//
// 为什么单独立一个文件：tests/agentTask.test.mjs 只 import 纯逻辑模块
//（taskModel / taskSchedule / taskPrompt / taskDispatch / taskRunner），**从不加载真模块**
// ——于是 src/storage/agentTasks.js 141 行 0% 覆盖，是 src/storage/ 里唯一的 0% 文件。
// 这与「假对象掩盖缺陷」同型：拿纯函数证明「任务模型对」，完全证明不了「落盘/清理对」。
//
// 这里走真模块 + 真 io.js + 真 characterLifecycle，只把 AsyncStorage / FileSystem /
// expo-sqlite 三个原生边界换成内存替身；角色删除那条走**真的钩子链**
//（runCharacterCleanup），而不是直接调内部函数——否则测不到「钩子有没有注册上」。

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

const {
  AGENT_TASKS_KEY,
  AGENT_TASK_RUNS_KEY,
  bindAgentTaskSession,
  clearAgentTaskRun,
  getAgentTaskRunDates,
  getAgentTasks,
  markAgentTaskRun,
  saveAgentTasks,
} = loadModule(path.resolve('src/storage/agentTasks.js'));
const { runCharacterCleanup, __listCharacterCleanupHooks } = loadModule(
  path.resolve('src/storage/characterLifecycle.js')
);

const task = (taskId, roleId, extra = {}) => ({
  taskId, roleId, mode: 'WORK', hour: 8, minute: 0, ...extra,
});

function reset() {
  store.clear();
}

test('钩子已注册到角色生命周期（谁的数据谁负责）', () => {
  assert.ok(__listCharacterCleanupHooks().includes('agentTasks'), 'agentTasks 必须注册清理钩子');
});

test('saveAgentTasks / getAgentTasks：往返 + 归一化 + 过滤无角色条目', async () => {
  reset();
  const saved = await saveAgentTasks([
    task('t1', 'c1', { hour: 21, minute: 5, instruction: '查天气' }),
    { taskId: 't2', roleId: '', mode: 'WORK' }, // 无角色 → 归一化时丢掉
  ]);
  assert.deepEqual(saved.map(item => item.taskId), ['t1'], '无 roleId 的条目被过滤');
  assert.equal(saved[0].hour, 21);
  assert.equal(saved[0].instruction, '查天气');

  const loaded = await getAgentTasks();
  assert.deepEqual(loaded.map(item => item.taskId), ['t1']);
  assert.equal(loaded[0].minute, 5);
  assert.equal(loaded[0].enabled, true);
});

test('getAgentTasks：键不存在返回空数组；结构损坏先备份再返回空（不静默覆盖）', async () => {
  reset();
  assert.deepEqual(await getAgentTasks(), [], '键不存在 → []');

  store.set(AGENT_TASKS_KEY, '{ 坏 JSON');
  assert.deepEqual(await getAgentTasks(), [], '损坏 → []');
  assert.equal(store.has(`${AGENT_TASKS_KEY}__corrupt_backup`), true, '损坏值必须先备份再重建');
  assert.equal(store.get(`${AGENT_TASKS_KEY}__corrupt_backup`), '{ 坏 JSON', '备份的是原始串');
});

test('bindAgentTaskSession：命中才改，且只改那一条（不整表覆盖）', async () => {
  reset();
  await saveAgentTasks([task('t1', 'c1'), task('t2', 'c2')]);

  assert.equal(await bindAgentTaskSession('t1', 's-bound'), true, '命中返回 true');
  assert.equal(await bindAgentTaskSession('t1', 's-bound'), false, '已绑定同一会话 → 幂等返回 false');
  assert.equal(await bindAgentTaskSession('missing', 's-x'), false, '没命中返回 false');
  assert.equal(await bindAgentTaskSession('', 's-x'), false, '空参数直接 false');

  const loaded = await getAgentTasks();
  assert.equal(loaded.find(item => item.taskId === 't1').sessionTargetId, 's-bound');
  assert.equal(loaded.find(item => item.taskId === 't2').sessionTargetId, '', '别的任务不受影响');
});

test('markAgentTaskRun / clearAgentTaskRun：按任务记日期，可单独清除', async () => {
  reset();
  const day = new Date(2024, 4, 17); // 本地日期 2024-05-17
  assert.equal(await markAgentTaskRun('t1', day), true);
  assert.equal(await markAgentTaskRun('t2', day), true);
  assert.deepEqual(await getAgentTaskRunDates(), { t1: '2024-05-17', t2: '2024-05-17' });

  assert.equal(await markAgentTaskRun('', day), false, '空 id 不写');
  assert.equal(await clearAgentTaskRun('t1'), true);
  assert.equal(await clearAgentTaskRun('t1'), false, '再清一次没得清 → false');
  assert.equal(await clearAgentTaskRun(''), false, '空 id → false');
  assert.deepEqual(await getAgentTaskRunDates(), { t2: '2024-05-17' });
});

test('markAgentTaskRun 会过滤掉历史脏数据（空键/空值不保留）', async () => {
  reset();
  store.set(AGENT_TASK_RUNS_KEY, JSON.stringify({ t1: '2024-05-17', '': '2024-05-17', t2: '', t3: 123 }));
  // t3 的 123 会被 String() 成 '123' 保留；空键与空值被丢弃
  assert.deepEqual(await getAgentTaskRunDates(), { t1: '2024-05-17', t3: '123' });
});

test('删角色：agent_tasks 与 agent_task_runs 真的被清（真钩子链）', async () => {
  reset();
  await saveAgentTasks([
    task('t1', 'c1'),
    task('t2', 'c2'),
    task('t3', 'c1'),
  ]);
  await markAgentTaskRun('t1', new Date(2024, 4, 17));
  await markAgentTaskRun('t2', new Date(2024, 4, 17));
  await markAgentTaskRun('t3', new Date(2024, 4, 17));

  await runCharacterCleanup(['c1']);

  const tasks = await getAgentTasks();
  assert.deepEqual(tasks.map(item => item.taskId), ['t2'], '被删角色的任务全清，别人的保留');
  assert.deepEqual(
    await getAgentTaskRunDates(),
    { t2: '2024-05-17' },
    '被删任务的运行记录一起清掉（否则「今日已跑」的孤儿记录会残留）'
  );
});

test('删角色：没有该角色的任务时不写盘（无变化就不产生写入）', async () => {
  reset();
  await saveAgentTasks([task('t2', 'c2')]);
  const before = store.get(AGENT_TASKS_KEY);

  await runCharacterCleanup(['nobody']);

  assert.equal(store.get(AGENT_TASKS_KEY), before, '无命中不得改写');
  assert.deepEqual(await getAgentTasks(), (await getAgentTasks()), '读回仍然正常');
});

test('删角色：空 id 列表不触发任何写入', async () => {
  reset();
  await saveAgentTasks([task('t1', 'c1')]);
  const before = store.get(AGENT_TASKS_KEY);
  await runCharacterCleanup([]);
  assert.equal(store.get(AGENT_TASKS_KEY), before);
});
