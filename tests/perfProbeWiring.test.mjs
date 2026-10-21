// 卡顿取证（perfProbe）**接线**的行为测试：60s 调度器 tick 与每轮落盘。
//
// 为什么补这两条：排查「发热/卡顿」时能拿到的读数只有四个（会话刷新、消息读取、
// 落盘、调度 tick）。前两个此前已接（见 perfProbe.test.mjs 的接线守卫），
// 后两个一直没接——于是「停在设置页也烫」这种形态没有任何后台活动读数可对照，
// 只能靠读代码猜。本文件把这两段钉住：
//   · app.tick        —— agentTaskScheduler 每 60s 一轮的耗时（设置页烫的头号可疑形态）
//   · session.saveMessages —— 每次落盘的真实耗时（「越用越卡」若来自写盘，这里直接看到）
//
// 前一条是**真行为测试**：注入假的 AppState / taskDispatch / measureAsync，
// 断言 tick 确实被探针包住、且包住的确实是 runDueAgentTasks（不是别的东西被顺手计时）。
// 后一条落在源码契约上——useSessionMessages 是 600+ 行的大 hook，在 Node 里把它整个
// 渲染起来只能靠一堆假 props 自欺，那测的是假货；仓库既有先例（perfProbe.test.mjs
// 的「接线」两条）同样用锚点钉调用点，并已用注入验证过锚点会红。

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

// 探针替身：记下每次计时用的 label 与阈值，并如实把 fn 跑掉。
const measured = [];
const fakeProbe = {
  __esModule: true,
  PERF_THRESHOLDS: { render: 50, storageRead: 120, storageWrite: 120, startup: 800 },
  measureAsync: async (label, fn, threshold) => {
    measured.push({ label, threshold });
    return fn();
  },
  measureSync: (label, fn) => fn(),
  isPerfProbeEnabled: () => false,
  setPerfProbeEnabled: () => false,
};

// AppState 替身：记住订阅者，供测试模拟前后台切换。
const appStateListeners = [];
const fakeAppState = {
  currentState: 'active',
  addEventListener(event, handler) {
    appStateListeners.push({ event, handler });
    return { remove: () => {} };
  },
};

// taskDispatch 替身：记住被调用次数与参数。
// 2026-10-21：调度器拆成 collect（只选择，被 app.tick 计量）+ execute（逐任务执行，
// 用 agent.task.run 计量）——替身必须同时提供两段，否则测不到真实接线。
const collectCalls = [];
const executeCalls = [];
let dueTasks = [{ taskId: 'task-1' }];
let dispatchResult = 0;
const fakeTaskDispatch = {
  __esModule: true,
  // 兼容：调度器仍 re-export 组合入口
  runDueAgentTasks: async () => 0,
  collectDueAgentTasks: async args => {
    collectCalls.push(args);
    return { deps: { runAgentTask: async () => ({ ok: true }) }, due: dueTasks };
  },
  executeDueAgentTasks: async (due, deps, options) => {
    executeCalls.push({ due, options });
    if (dispatchResult > 0) return dispatchResult;
    let produced = 0;
    for (const task of (Array.isArray(due) ? due : [])) {
      const run = () => deps.runAgentTask(task, options);
      const result = typeof options.measureTask === 'function'
        ? await options.measureTask(task, run)
        : await run();
      if (result && result.ok) produced += 1;
    }
    return produced;
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'react-native') return { __esModule: true, AppState: fakeAppState };
  if (request.endsWith('logging/perfProbe.js')) return fakeProbe;
  if (request.endsWith('taskDispatch.js')) return fakeTaskDispatch;
  return originalLoad.call(this, request, parent, isMain);
};

const schedulerPath = path.join(SRC_DIR, 'agent', 'task', 'agentTaskScheduler.js');
const compiled = babel.transformSync(fs.readFileSync(schedulerPath, 'utf8'), {
  babelrc: false, configFile: false, filename: schedulerPath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const mod = new Module(schedulerPath);
mod.filename = schedulerPath;
mod.paths = Module._nodeModulePaths(path.dirname(schedulerPath));
mod._compile(compiled, schedulerPath);
const scheduler = mod.exports;

// 让 tick() 的 await 链跑完（tick 内部是 async，start 返回时它还在飞行中）。
const flush = () => new Promise(resolve => setImmediate(resolve));

test.beforeEach(() => {
  measured.length = 0;
  collectCalls.length = 0;
  executeCalls.length = 0;
  dueTasks = [{ taskId: 'task-1' }];
  dispatchResult = 0;
  appStateListeners.length = 0;
});

// 起一个调度器，保证**无论断言成败**都停掉它。
//
// 这不是洁癖：注入验证时把探针摘掉，第 98 行的断言先红，后面那句裸 stop() 就永远
// 跑不到——`setInterval` 还挂着，node --test 进程杀不掉，整批测试卡在后台不退。
// 一个会因失败而泄漏定时器的测试，在被注入时不是「变红」而是「挂死」，那比漏测更糟：
// 它会让验证者以为测试没问题、只是环境慢。
async function withScheduler(options, body) {
  const stop = scheduler.startAgentTaskScheduler(options);
  try {
    await flush();
    await body();
  } finally {
    stop();
  }
}

test('接线：app.tick 只计量调度（collect），任务执行走 agent.task.run', async () => {
  // intervalMs 取极大：只测「启动即跑的那一轮」，不让定时器在测试里真的重复触发。
  await withScheduler({ intervalMs: 1e9 }, async () => {
    const ticks = measured.filter(item => item.label === 'app.tick');
    assert.equal(ticks.length, 1, `启动必须跑一轮且带 app.tick 打点，实际 ${ticks.length}`);
    assert.equal(collectCalls.length, 1, '计时包住的必须真的是 collectDueAgentTasks');
    assert.ok(collectCalls[0].now instanceof Date, 'now 由调度器取一次并传给选择阶段');
    assert.equal(ticks[0].threshold, 800, '调度阈值取「一次后台活动明显拖住主线程」的量级');
    // 2026-10-21 修正：任务执行（模型+工具，十几秒正常）不得混进 app.tick。
    const runs = measured.filter(item => item.label === 'agent.task.run');
    assert.equal(runs.length, dueTasks.length, '每个到期任务单独计时');
    assert.equal(runs[0].threshold, 120000, '任务执行用宽松阈值（>=2 分钟才算异常）');
    assert.equal(executeCalls.length, 1, '执行阶段确实被调用');
    assert.equal(executeCalls[0].options.notify, true, '参数不得被探针吞掉或改写');
  });
});

test('接线：探针原样返回结果——产出计数仍能触发 onResults', async () => {
  const reported = [];
  dispatchResult = 3;
  await withScheduler(
    { intervalMs: 1e9, onResults: n => reported.push(n) },
    async () => {
      // 若执行阶段的返回值被吞成 undefined，`produced > 0` 为假 → 这条会红。
      assert.deepEqual(reported, [3], 'executeDueAgentTasks 的返回值必须透传出来');
    }
  );
});

test('接线：调度失败时探针不改变「不抛、不影响 App」的既有语义', async () => {
  // 探针模块在计时失败路径上会 rethrow（见 perfProbe 的 finally）——这里确认调度器
  // 自己的 try/catch 仍然兜住它，不会把异常漏到定时器外面。
  const originalCollect = fakeTaskDispatch.collectDueAgentTasks;
  fakeTaskDispatch.collectDueAgentTasks = async () => { throw new Error('dispatch boom'); };
  try {
    await withScheduler({ intervalMs: 1e9 }, async () => {
      assert.equal(measured.filter(item => item.label === 'app.tick').length, 1,
        '失败的那一轮同样要留打点（慢的失败也卡）');
    });
  } finally {
    fakeTaskDispatch.collectDueAgentTasks = originalCollect;
  }
});

test('接线：session.saveMessages 进了探针（否则「越用越卡」没有写盘读数）', () => {
  const source = fs.readFileSync(path.join(SRC_DIR, 'chat', 'useSessionMessages.js'), 'utf8');
  assert.ok(source.includes("'session.saveMessages'"), '落盘必须带 label');
  // 光有 label 不算接线：必须确认它真的包住了 saveMessagesBySession。
  const probeAt = source.indexOf('measureAsync(\n        \'session.saveMessages\'');
  const saveAt = source.indexOf('saveMessagesBySession(', probeAt);
  assert.ok(probeAt > 0, '落盘探针必须以预期形态出现在调用链上');
  assert.ok(saveAt > probeAt, 'saveMessagesBySession 必须落在探针的回调里');
  assert.ok(source.includes('PERF_THRESHOLDS.storageWrite'), '写盘用写阈值，不要复用读阈值');
});
