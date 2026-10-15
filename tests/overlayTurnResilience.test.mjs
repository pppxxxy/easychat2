// FEAT-AC7：悬浮窗接线断点 + 回合超时 + 观测器常驻。
//
// 四个根因（本轮任务书 §一，全部对码核实）：
//   BUG-1 悬浮窗工作区 scope 发话无回复 → chat-send 订阅挂在**看屏幕页组件**里，
//         用户在工作区页时监听器不存在，原生事件静默丢弃（截图 #285）。
//   BUG-2 app 面板卡在「正在调用 set_app_setting…」→ 单请求**有**超时（requestTimeout.js
//         三档），但**回合级**没有上限：12 轮 × 最多 4 模型 × 120s ≈ 96 分钟（截图 #286/287）。
//   BUG-3 诊断日志全空 → trace 落盘入口同样挂在那个不在场的页面里（AC5 第 4 条假通过）。
//   BUG-4 设置改完快照不刷 → **任务书判为「全仓无人调用」，经核实是误判**（见文件末尾一条）。
//
// 测试分工（仓库纪律）：纯逻辑真跑；接线层源码断言，且断言**调用点/分支体**而非名字。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TURN_EVENTS,
  formatTurnEvent,
  noteTurnEvent,
  setTurnEventRecorder,
} from '../src/screenWatch/turnDiagnostics.js';
import {
  classifyTurnEnding,
  turnEndingTextKey,
} from '../src/screenWatch/workspaceWatchTurn.js';

// ⚠️ loop.js **不能直接 import**：它的静态链经 api.js → storage/io.js 拖进
// expo-file-system/legacy，Node 里解析不了（本仓既有约束）。
// 本文件对 loop 的断言绝大多数是**源码断言**（下面第 ⑤ 组）；只有两个纯常量/纯函数
// 需要真跑，用与 agentLoop.test.mjs **同一套** Babel + Module._load 桩加载
//（同一写法，避免第二套 harness 各自漂移）。桩只需要盖住 loop 的两条依赖：
// network/api.js 与 tools/registry.js——被加载模块**顶层**就会 require 它们。
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

const loopPath = path.resolve('src/agent/loop.js');

// 最小桩：本文件只取两个导出，不跑循环，所以桩只需让顶层 require 成功。
const apiStub = {
  createAbortError: () => Object.assign(new Error('aborted'), { name: 'AbortError', canceled: true }),
  isCanceledError: error => !!(error && (error.canceled === true || error.name === 'AbortError')),
  streamChatCompletion: async () => ({ text: '', toolCalls: [] }),
};
const registryStub = {
  listToolsForMode: () => [],
  runTool: async () => ({ content: '', isError: false }),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../network/api.js') return apiStub;
  if (request === './tools/registry.js') return registryStub;
  return originalLoad.call(this, request, parent, isMain);
};

let loopExports = null;
function loadLoopExports() {
  if (loopExports) return loopExports;
  const transformed = babel.transformSync(fs.readFileSync(loopPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: loopPath,
    presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const runtimeModule = new Module(loopPath);
  runtimeModule.filename = loopPath;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(loopPath));
  runtimeModule._compile(transformed, loopPath);
  loopExports = runtimeModule.exports;
  return loopExports;
}

const { DEFAULT_TURN_BUDGET_MS, createTurnTimeoutError } = loadLoopExports();

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

function stripComments(source) {
  return source.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

// ---------- ① 纯层：回合打点格式 ----------

test('打点格式：事件名 + 白名单字段；缺字段省略，不写 undefined', () => {
  assert.equal(formatTurnEvent('turn-tool', { round: 2, tool: 'set_app_setting' }),
    'turn-tool round=2 tool=set_app_setting');
  // elapsed 带 ms 单位
  assert.equal(formatTurnEvent('turn-done', { round: 1, elapsed: 1200 }), 'turn-done round=1 elapsed=1200ms');
  assert.equal(formatTurnEvent('turn-start', {}), 'turn-start');
  // ⚠️ FEAT-AC8 P0-D：falsy 值必须**保留**（`ok=false` 与 `elapsed=0` 都是有意义的值）。
  // 早先的实现用 `if (!value) continue`，会把它们吞掉——那正是「打点白记了」的形态：
  // 当晚 5 次 set_app_setting 全部失败，若 ok=false 被过滤，日志里就只剩工具名，
  // 读不出成败（BUG-A 也就无法当场定罪）。
  assert.equal(formatTurnEvent('turn-tool', { tool: 'set_app_setting', ok: false }),
    'turn-tool tool=set_app_setting ok=false', 'ok=false 必须保留');
  assert.equal(formatTurnEvent('turn-done', { elapsed: 0 }), 'turn-done elapsed=0ms', 'elapsed=0 必须保留');
  // 未知事件名归 turn-unknown（不静默丢弃，也不冒充已知事件）
  assert.equal(formatTurnEvent('bogus', { round: 1 }), 'turn-unknown round=1');
  // 非白名单字段（可能含隐私正文）不得进日志
  const line = formatTurnEvent('turn-tool', { round: 1, tool: 'x', prompt: '用户的私密正文' });
  assert.equal(line.includes('用户的私密正文'), false, '白名单外的字段不得进打点');
  // error 只取首行并截断
  const withError = formatTurnEvent('turn-timeout', { error: new Error('第一行\n第二行堆栈') });
  assert.equal(withError.includes('第二行堆栈'), false, 'error 只取首行（堆栈由真错误路径负责）');
});

test('打点事件齐备（turn-start/tool/done/timeout + AC8 的落库留痕）', () => {
  // FEAT-AC8 P0-C 把 thread-append 加进同一落盘通道（它不是回合事件，
  // 但共用「组装 → 注入落盘」这一层，故同表登记——分开两张表只会两处漂移）。
  assert.deepEqual([...TURN_EVENTS], ['turn-start', 'turn-tool', 'turn-done', 'turn-timeout', 'thread-append']);
});

test('打点：未注入 recorder 时静默；注入后逐条落盘；recorder 抛错不影响主流程', () => {
  const seen = [];
  setTurnEventRecorder(line => seen.push(line));
  try {
    noteTurnEvent('turn-start', { round: 0 });
    noteTurnEvent('turn-done', { round: 1, elapsed: 5 });
    assert.equal(seen.length, 2);
    assert.match(seen[0], /^turn-start/);
    // recorder 抛错不得冒泡（打点是辅助能力）
    setTurnEventRecorder(() => { throw new Error('disk full'); });
    assert.doesNotThrow(() => noteTurnEvent('turn-done', {}));
  } finally {
    setTurnEventRecorder(null);
  }
  // 清空后静默
  assert.doesNotThrow(() => noteTurnEvent('turn-done', {}));
});

// ---------- ② 纯层：收尾分类 ----------

test('收尾分类：中止 / 超时 / 失败必须分开（中止是意图，超时是故障）', () => {
  const aborted = Object.assign(new Error('x'), { canceled: true });
  assert.equal(classifyTurnEnding({ error: aborted }), 'aborted');
  assert.equal(classifyTurnEnding({ error: Object.assign(new Error('x'), { name: 'AbortError' }) }), 'aborted');
  assert.equal(classifyTurnEnding({ error: Object.assign(new Error('x'), { timedOut: true }) }), 'timeout');
  assert.equal(classifyTurnEnding({ timedOut: true }), 'timeout');
  assert.equal(classifyTurnEnding({ error: new Error('503') }), 'failed');
  assert.equal(classifyTurnEnding({}), 'failed');
  // 三种收尾给三句不同的话（混成一句会让用户以为是自己点错了）
  const keys = ['aborted', 'timeout', 'failed'].map(turnEndingTextKey);
  assert.equal(new Set(keys).size, 3, '三种收尾的文案键必须互不相同');
  assert.equal(turnEndingTextKey('aborted'), 'screenWatch.overlay.turnStopped');
  assert.equal(turnEndingTextKey('timeout'), 'screenWatch.overlay.turnTimeout');
});

// ---------- ③ 纯层：回合超时错误 ----------

test('回合超时错误：可辨识（timedOut）、含模型与轮数、给可操作建议', () => {
  const error = createTurnTimeoutError({ model: 'kilo-auto/free', round: 3, elapsedMs: 181000 });
  assert.equal(error.name, 'TurnTimeoutError');
  assert.equal(error.timedOut, true, '必须可辨识——宿主据此给「超时」而不是「已停止」');
  assert.match(error.message, /kilo-auto\/free/, '要说出卡在哪个模型（用户换模型重试的依据）');
  assert.match(error.message, /第 3 轮/, '要说出卡在第几轮');
  assert.match(error.message, /181s/, '要说出已耗时');
  assert.match(error.message, /换|拆/, '要给可操作的建议，不只是报告失败');
  // 缺参不抛（调用方可能拿不到模型名）
  assert.doesNotThrow(() => createTurnTimeoutError());
  assert.equal(createTurnTimeoutError().timedOut, true);
});

test('回合预算常量存在且是「用户会觉得卡死」之前的量级', () => {
  assert.equal(typeof DEFAULT_TURN_BUDGET_MS, 'number');
  assert.ok(DEFAULT_TURN_BUDGET_MS > 0);
  // 必须显著小于「12 轮 × 4 模型 × 120s ≈ 96 分钟」那个无界最坏值，否则等于没加
  assert.ok(DEFAULT_TURN_BUDGET_MS <= 300000, '回合上限要在分钟级，不能是小时级');
  assert.ok(DEFAULT_TURN_BUDGET_MS >= 60000, '也不能太短——正常多轮工具回合要跑得完');
});

// ---------- ④ 接线：P0-A 监听器 app 级常驻（BUG-1/3 的核心）----------

test('P0-A：trace / chat-send / request-capture 的订阅在 app 级桥里，不在页面里', () => {
  const bridge = read('src/screenWatch/overlayEventBridge.js');
  // 三个订阅必须真的在 app 级桥的 useEffect 里
  assert.match(bridge, /addTraceListener\(\)/, '打点落盘入口必须在 app 级（BUG-3）');
  assert.match(bridge, /addChatSendListener\(payload => \{ handleOverlayChatSend\(payload\); \}\)/,
    'chat-send 订阅必须在 app 级（BUG-1）');
  assert.match(bridge, /addRequestCaptureListener\(/, '截屏请求订阅必须在 app 级');

  // 页面不得再持有这三个订阅（重复订阅 = 一个事件两个处理者）
  const screen = stripComments(read('src/screenWatch/ScreenWatchScreen.js'));
  for (const name of ['addTraceListener', 'addChatSendListener', 'addRequestCaptureListener']) {
    assert.equal(new RegExp(`${name}\\(`).test(screen), false,
      `ScreenWatchScreen 不得再订阅 ${name}（已上移 app 级）`);
  }
  // 页面改为注入实现
  assert.match(screen, /setOverlayChatHandler\(/, '页面应注入聊天处理器');
  assert.match(screen, /setOverlayCaptureHandler\(/, '页面应注入截屏处理器');
  // 注入必须在卸载时清空（否则页面卸载后 handler 还指着已死的闭包）
  assert.match(screen, /setOverlayChatHandler\(null\)/, '卸载时要清空聊天注入');
  assert.match(screen, /setOverlayCaptureHandler\(null\)/, '卸载时要清空截屏注入');
});

test('P0-A：App.js 装配了 app 级桥（页面不在场也常驻）', () => {
  const app = read('App.js');
  assert.ok(app.includes('OverlayEventBridge'), 'App 装配处必须渲染 app 级桥');
  assert.match(app, /<OverlayConfigBridge \/>/, '既有配置桥保留');
  // 必须在 startupReady 之后渲染（与其它桥同一时机）
  assert.match(app, /startupReady \? <><OverlayConfigBridge \/><OverlayEventBridge \/><\/> : null/,
    '桥必须在 app 就绪后挂载');
});

test('P0-A（守卫注入测试）：页面**未挂载**时，工作区 scope 仍能被处理', () => {
  // 这是任务书 §二 P0-A 明确要求的守卫：模拟「ScreenWatchScreen 未挂载」，
  // 断言工作区 scope 的处理器**仍然会走自足路径**（不再静默丢弃）。
  //
  // ⚠️ 本文件是 .mjs（Node 直跑），而 overlayEventBridge.js 含 JSX（渲染 null），
  // Node 的 ESM 加载器解析不了 `return null` 之外的 JSX——所以这里用**源码断言**
  // 钉住结构（与第 ④ 组同法），行为由「工作区 scope 不读 chatHandler」这条**结构事实**保证。
  const bridge = stripComments(read('src/screenWatch/overlayEventBridge.js'));
  // 工作区分支必须在「检查 chatHandler」**之前**就 return —— 这正是「页面不在场也能跑」的充要条件。
  const fnAt = bridge.indexOf('export async function handleOverlayChatSend');
  assert.ok(fnAt > 0, 'handleOverlayChatSend 定位失败');
  const body = bridge.slice(fnAt, fnAt + 1200);
  const workspaceAt = body.indexOf("if (scope === 'workspace')");
  const handlerAt = body.indexOf("typeof chatHandler !== 'function'");
  assert.ok(workspaceAt > 0, '必须有工作区分支');
  assert.ok(handlerAt > 0, '聊天 scope 仍要有页面缺失兜底');
  assert.ok(workspaceAt < handlerAt,
    '工作区分支必须在 chatHandler 判据**之前**——这是「页面未挂载也能处理工作区消息」的充要条件');
  // 工作区分支体内不得出现 chatHandler（自足的证明：它不依赖任何页面注入）
  const workspaceBlock = body.slice(workspaceAt, handlerAt);
  assert.equal(/chatHandler/.test(workspaceBlock), false,
    '工作区分支不得依赖 chatHandler（那就是 BUG-1 的形态）');
  // 且必须真的调用回合执行器
  assert.match(workspaceBlock, /runAndPushOverlayWorkspaceTurn\(/,
    '工作区分支要真的跑回合');
});

// ---------- ⑤ 接线：P0-B 回合超时真的接进了循环 ----------

test('P0-B：回合预算在 loop 里真的生效（派生信号 + 到点 abort + 清理）', () => {
  const loop = stripComments(read('src/agent/loop.js'));
  // 预算常量与默认值
  assert.match(loop, /const turnBudgetMs = Number\.isFinite\(Number\(options\.turnBudgetMs\)\)/,
    '预算可从调用方覆盖（可配）');
  assert.match(loop, /setTimeout\(\(\) => \{[\s\S]{0,120}?timedOut = true;[\s\S]{0,80}?budgetController\.abort\(\)/,
    '到点必须真的 abort（不是只记标记）');
  // 模型请求必须用派生信号（不是原 signal）——否则超时 abort 传不进请求
  assert.match(loop, /const streamRound = roundTools => streamChatCompletion\(history, \{[\s\S]{0,200}?signal: effectiveSignal/,
    '模型请求必须用派生信号');
  assert.match(loop, /const result = await streamChatCompletion\(history, \{[\s\S]{0,160}?signal: effectiveSignal/,
    '无工具单轮也要用派生信号');
  // 工具执行同样要能被超时打断
  assert.match(loop, /outcome = await runTool\(call, \{[\s\S]{0,120}?signal: effectiveSignal/,
    '工具执行要用派生信号（否则超时打不断一个卡住的工具）');
  // 清理：必须在 finally 里（否则已结束的回合会在 180s 后 abort 复用的 signal）
  assert.match(loop, /\} finally \{[\s\S]{0,300}?clearBudget\(\);/,
    '预算计时器必须在 finally 清理');
  // 中止判据统一走 throwIfStopped（区分超时与用户中止）
  assert.match(loop, /const throwIfStopped = \(\) => \{[\s\S]{0,200}?if \(timedOut\)[\s\S]{0,200}?createTurnTimeoutError/,
    '中止点必须先判超时再判用户中止');
  // 不得用 AbortSignal.any（Hermes 上未必存在——no-undef 门禁会直接报）
  assert.equal(/AbortSignal\.any/.test(loop), false, '不得依赖 AbortSignal.any');
});

test('P0-B：超时错误在 loop 里被识别并打点（turn-timeout 带耗时与轮数）', () => {
  const loop = read('src/agent/loop.js');
  assert.match(loop, /if \(error && error\.timedOut === true\) \{[\s\S]{0,300}?emitTurnEvent\('turn-timeout'/,
    '超时要打 turn-timeout 事件');
  assert.match(loop, /emitTurnEvent\('turn-start'/, '回合开始要打点');
  assert.match(loop, /emitTurnEvent\('turn-done'/, '成功结束要打点');
  assert.match(loop, /emitTurnEvent\('turn-tool'/, '工具调用要打点');
  // 打点必须用注入的 onTurnEvent（不在 loop 里直接 import 诊断模块——那会把 RN 拖进来）
  assert.match(loop, /const onTurnEvent = typeof options\.onTurnEvent === 'function'/,
    '打点走注入的 onTurnEvent');
});

// ---------- ⑥ 接线：P0-C 四种收尾都落库（修「（暂无内容）」）----------

test('P0-C：runWorkspaceWatchTurn 成功/失败/中止/超时四种收尾都落库', () => {
  const turn = read('src/screenWatch/workspaceWatchTurn.js');
  const code = stripComments(turn);
  // 成功路径落库
  assert.match(code, /await persistTurnEntries\(\{[\s\S]{0,200}?conclusionText: text/,
    '成功路径要落库');
  // catch 路径落库（此前中止直接 return 什么都不写 ⇒ 线程 0 条目）
  assert.match(code, /catch \(caught\) \{[\s\S]{0,900}?await persistTurnEntries\(/,
    '失败/中止/超时路径也要落库');
  // 中止仍不报错（既有语义不变），但已经落库
  assert.match(code, /if \(ending === 'aborted'\) return \{ ok: false, text: '', steps: \[\], error: '' \}/,
    '中止不报错但已落库');
  // 空回复也算一种收尾，照样落库
  assert.match(code, /const emptyConclusion = t\('error\.comments\.noReply'\)/,
    '空回复也要落库（不让线程空着）');
  // 落库实现是**一个**函数（两条驱动路径共用同一份纪律，不会两处各写一遍）
  assert.equal((code.match(/async function persistTurnEntries\(/g) || []).length, 1,
    '落库收口为一个函数');
  // 用户说过的话永远先落（它是事实）
  assert.match(turn, /const said = String\(userText \|\| ''\)\.trim\(\);\n  if \(said\) \{/,
    '用户消息优先落库');
});

test('P0-C：落库写失败不挡主流程，且**必须留痕**（AC8 起不再静默）', () => {
  const turn = read('src/screenWatch/workspaceWatchTurn.js');
  // 早期这里是裸 `catch (error) {}`——「失败静默」保住了主流程，但真机上
  // 「到底写没写进去」无法证实也无法证伪（AC8 BUG-C 的盲区）。
  // AC8 起：失败仍然不挡主流程，但**每一条都留痕**（ok:false）。
  assert.match(turn, /for \(const entry of entries\) \{[\s\S]{0,700}?catch \(error\) \{\s*ok = false;\s*\}/,
    '逐条落库且失败不挡本轮结果（catch 里置 ok=false）');
  // 留痕必须真的调用（不是只定义 onAppend 参数）
  assert.match(turn, /if \(typeof onAppend === 'function'\) \{[\s\S]{0,200}?onAppend\(\{ threadId: thread\.id, role: entry\.role, ok \}\)/,
    '每条落库都要报送结果（含失败的）');
  // 三处落库调用点都要接上留痕器（漏一处 = 那条路径仍然静默）
  const wired = (turn.match(/onAppend: appendTracer/g) || []).length;
  assert.equal(wired, 3, `三处落库（成功/空回复/异常收尾）都要留痕，实际接上 ${wired} 处`);
});

// ---------- ⑦ 接线：P0-F 悬浮窗忙反馈（不允许沉默）----------

test('P0-F：工作区回合先给忙反馈，结束时推结果替换', () => {
  const overlayTurn = read('src/screenWatch/overlayWorkspaceTurn.js');
  // 忙反馈必须在跑回合**之前**（否则用户先看到的是长时间沉默）
  assert.match(overlayTurn, /export async function runAndPushOverlayWorkspaceTurn[\s\S]{0,600}?updateOverlayText\(tActive\('screenWatch\.overlay\.turnBusy'\)\)[\s\S]{0,400}?await runOverlayWorkspaceTurn/,
    '先给忙反馈再跑回合');
  // 结果必须推回窗（成功/失败都要，不允许「发了话之后什么都没有」）
  assert.match(overlayTurn, /pushOverlayChatMessage\(\{ role: 'assistant', text: reply \}\)/,
    '结果要推回悬浮窗');
  // 失败时也要有话说（不能只推成功路径）
  assert.match(overlayTurn, /result\.ok\s*\?\s*result\.text\s*:\s*\(result\.error \|\| tActive\('screenWatch\.comments\.failed'\)\)/,
    '失败也要给出文案');
});

// ---------- ⑧ i18n ----------

test('i18n：AC7 新增词条中英齐备', () => {
  const zh = read('src/i18n/locales/zh-CN/workspaceWatch.js');
  const en = read('src/i18n/locales/en/workspaceWatch.js');
  for (const key of [
    'screenWatch.overlay.turnBusy',
    'screenWatch.overlay.turnStopped',
    'screenWatch.overlay.turnTimeout',
    'screenWatch.overlay.chatNeedsPage',
    'screenWatch.overlay.captureNeedsPage',
  ]) {
    assert.ok(zh.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(en.includes(`'${key}'`), `en 缺 ${key}`);
  }
  // 超时文案必须带 {seconds}（否则用户不知道等了多久）
  assert.ok(zh.includes('{seconds}'), 'zh 超时文案要带 {seconds}');
  assert.ok(en.includes('{seconds}'), 'en 超时文案要带 {seconds}');
});

// ---------- ⑨ 行数棘轮 ----------

test('行数：本轮新增/修改文件都在 800 硬上限内', () => {
  const count = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  for (const file of [
    'App.js',
    'src/agent/loop.js',
    'src/screenWatch/overlayEventBridge.js',
    'src/screenWatch/overlayWorkspaceTurn.js',
    'src/screenWatch/turnDiagnostics.js',
    'src/screenWatch/workspaceWatchTurn.js',
    'src/screenWatch/ScreenWatchScreen.js',
  ]) {
    const lines = count(read(file));
    assert.ok(lines <= 800, `${file}: ${lines} > 800（棘轮纪律：拆文件，不抬上限）`);
  }
});

// ---------- ⑩ 任务书 BUG-4 的核实结论（防后人再被同一误判带偏）----------

test('BUG-4 核实：setOverlaySnapshotRefresher **已被调用**（任务书「全仓无人调用」是误判）', () => {
  // 任务书 §一 BUG-4 称「setOverlaySnapshotRefresher 导出了，全仓无人调用」。
  // 核实结论：**误判**——宿主一直在调它。
  // 误判来源：当时它在 App.js（仓库**根目录**，不在 src/ 下），只 grep src/ 就会漏掉。
  //
  // ⚠️ 2026-10-15 m1015m1 合并后修正本断言：原先钉的是「App.js 里有这行」——
  // 那是**位置**断言，而宿主接线已被（正确地）外提到 src/startup/workspaceRecorders.js
  // 做集中装配。位置会变，**行为**不会：要钉的是「有宿主注入真实实现，且卸载时清空，
  // 且工具侧真的调用它」。故改为按行为断言（跨 App.js / workspaceRecorders 两处均可）。
  const app = read('App.js');
  const recorders = read('src/startup/workspaceRecorders.js');
  const wiring = `${app}\n${recorders}`;
  assert.match(wiring, /setOverlaySnapshotRefresher\(\(\) => writeOverlayConfigSnapshot\(/,
    '宿主必须注入真实快照刷新实现（App.js 或集中装配模块皆可）');
  assert.match(wiring, /setOverlaySnapshotRefresher\(null\)/, '卸载时清空注入');
  // 工具侧确实会调用它（不是只注入不使用）
  const tools = read('src/workspace/toolDefs/appSettingsTools.js');
  assert.match(tools, /if \(overlaySnapshotRefresher\) await overlaySnapshotRefresher\(\);/,
    'set_app_setting 落盘后要真的刷快照');
  // 且已有单测断言「写入 → 刷快照 → 留痕」的顺序
  const test = read('tests/appSettingsTools.test.mjs');
  assert.ok(test.includes("assert.ok(calls.includes('snapshot')"),
    '既有单测已断言快照刷新被触发');
});

test('宿主接线：四个 recorder 全部有注入点（缺一个 = 生产静默 no-op）', () => {
  // 合并 m1015m1 时核实出的一类缺陷：工具层用**注入**解耦（正确，保住纯 Node 单测），
  // 但「注入点是否被宿主接上」没有守卫 ⇒ 定义了却没人调 = 生产里静默 no-op。
  // 当时 setSettingChangeRecorder / setReminderRecorder **从未被注入**（只定义了）。
  // 这条按**行为**钉住四个注入点都有人接（不管接在哪个文件）。
  const wiring = `${read('App.js')}\n${read('src/startup/workspaceRecorders.js')}`;
  for (const name of [
    'setOverlaySnapshotRefresher',
    'setMusicToolRecorder',
    'setSettingChangeRecorder',
    'setReminderRecorder',
  ]) {
    // 必须有「传真实实现」的调用（排除 setXxx(null) 这种卸载调用）
    assert.match(wiring, new RegExp(`${name}\\((?!null)`),
      `${name} 必须被宿主注入真实实现（只定义不注入 = 生产 no-op）`);
  }
});

// ---------- ⑪ requiresConfirmation 函数形态：消费方必须认得出（fail-open 风险）----------

test('requiresConfirmationFor：函数形态的唯一求值入口，且 fail-closed', async () => {
  // 背景（合并 m1015m1 时核实）：该批把 requiresConfirmation 扩展成支持函数形态
  //（control_music 按 action 分级）。**任何写成 `=== true` 的消费方对函数形态都求值为
  // false** —— 那是放行方向（fail-open）。实测两个消费方原先正是这种写法。
  // 修法：求值收口到 requiresConfirmationFor，各消费方统一走它。
  // registry.js 可被 Node 直接 import（不拖 RN/expo——它有惰性 require 纪律）。
  const { requiresConfirmationFor } = await import('../src/agent/tools/registry.js');
  // 布尔形态：严格 === true
  assert.equal(requiresConfirmationFor({ requiresConfirmation: true }), true);
  assert.equal(requiresConfirmationFor({ requiresConfirmation: false }), false);
  assert.equal(requiresConfirmationFor({}), false);
  assert.equal(requiresConfirmationFor(null), false);
  // 函数形态：按 args 求值
  const graded = { requiresConfirmation: args => (args && args.action === 'play') === true };
  assert.equal(requiresConfirmationFor(graded, { action: 'play' }), true);
  assert.equal(requiresConfirmationFor(graded, { action: 'pause' }), false);
  // 函数返回非布尔：只认 === true（与布尔形态同口径，不把 truthy 当确认）
  assert.equal(requiresConfirmationFor({ requiresConfirmation: () => 'yes' }), false);
  // 判定函数抛错 → fail-closed（宁可多问一次，不可静默放行）
  assert.equal(requiresConfirmationFor({ requiresConfirmation: () => { throw new Error('boom'); } }), true,
    '分级函数坏掉时必须按「需要确认」处理');
});

test('函数形态消费方：MCP 的 confirm 与 runTool 共用同一求值（不得各写 === true）', () => {
  // MCP 的 confirm 钩子语义是「工具自己声明要确认 ⇒ 档位+预览已替用户回答」。
  // 它原先写 `definition.requiresConfirmation === true` —— 对 control_music（函数形态）
  // 求值为 false ⇒ 在 MCP 写档下**不经确认执行**。已改为走 requiresConfirmationFor。
  const runtime = read('src/mcp/serverRuntime.js');
  assert.match(runtime, /requiresConfirmationFor\(definition, toolArgs \|\| \{\}\)/,
    'MCP confirm 必须走统一求值（认得出函数形态）');
  // ⚠️ 必须剥注释再判：本文件里有一行注释正解释着「不能写 === true」，
  // 按整文件匹配会自己打自己（本仓反复踩过的假阳性形态，这次又踩了一次）。
  const runtimeCode = runtime.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(/requiresConfirmation === true/.test(runtimeCode), false,
    '不得再写 === true（对函数形态 fail-open）');
  // runTool 内部同样走统一求值（不在两处各写一份三目）
  const registry = read('src/agent/tools/registry.js');
  assert.match(registry, /const needsConfirmation = requiresConfirmationFor\(tool, args\);/,
    'runTool 的判定也要走统一求值');
});

test('子代理白名单与函数形态工具的交集必须为空（否则 subagent 会 fail-open）', () => {
  // subagent.js 刻意不接触全局注册表（文件头的硬边界），它的 needsConfirm 用的是
  // `tool.requiresConfirmation === true`。该写法**只对布尔形态完整**：
  // 一旦函数形态工具进了它的名字白名单，就会静默放行（不确认）。
  // 目前白名单是固定三个只读 + 三个写文件工具，不含 control_music（唯一的函数形态工具）。
  // 这条把那个**前提**钉住：将来谁把函数形态工具加进白名单，这里立刻变红。
  const subagent = read('src/agent/subagent.js');
  const names = [...subagent.matchAll(/SUBAGENT_(?:WRITE_)?TOOL_NAMES = Object\.freeze\(\[([^\]]*)\]/g)]
    .flatMap(match => match[1].split(',').map(item => item.trim().replace(/^'|'$/g, '')).filter(Boolean));
  assert.ok(names.length >= 5, `白名单解析失败（只取到 ${names.length} 个）`);
  // 唯一的函数形态工具（发现新的就一起加进来）
  const functionFormTools = ['control_music'];
  for (const tool of functionFormTools) {
    assert.equal(names.includes(tool), false,
      `${tool} 使用函数形态 requiresConfirmation，不得进子代理白名单（那里只认 === true，会 fail-open）`);
  }
});
