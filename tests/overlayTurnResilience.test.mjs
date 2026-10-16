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
  runWorkspaceWatchTurn,
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
//
// ⚠️ FEAT-AC9 P0：两个桩**可变**——第 ⑫ 组要做「形状契约」的**真跑**测试
//（发射方形状穿过接收方签名），需要真的跑一轮带工具的循环。
// 不变的桩只能跑「无工具」分支，那测不到 turn-tool 这条最关键的发射点。
let stubTools = [];
let stubStreamPlan = [];
const apiStub = {
  createAbortError: () => Object.assign(new Error('aborted'), { name: 'AbortError', canceled: true }),
  isCanceledError: error => !!(error && (error.canceled === true || error.name === 'AbortError')),
  streamChatCompletion: async () => {
    const plan = stubStreamPlan.shift() || { text: '', toolCalls: [] };
    return {
      text: typeof plan.text === 'string' ? plan.text : '',
      toolCalls: plan.toolCalls || [],
      model: plan.model || '',
      usage: null,
    };
  },
};
const registryStub = {
  listToolsForMode: () => stubTools,
  runTool: async () => ({ content: 'ok', isError: false }),
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
  // FEAT-AC9 P0-3：ok 归一成 'ok' / 'fail' 字面量（FIELDS 注释一直这么宣称，
  // 而实现渲染的是 true/false——改行为与注释对齐）。**false 仍然被保留**（变成 fail），
  // 这正是本条要守的：成败不能因为取值是 falsy 而消失。
  assert.equal(formatTurnEvent('turn-tool', { tool: 'set_app_setting', ok: false }),
    'turn-tool tool=set_app_setting ok=fail', 'ok=false 必须保留（归一成 fail）');
  assert.equal(formatTurnEvent('turn-tool', { tool: 'set_app_setting', ok: true }),
    'turn-tool tool=set_app_setting ok=ok', 'ok=true 归一成 ok');
  // 幂等：已经是 'ok' 字面量再走一遍不得被翻成 fail（二次包装/转发的情形）
  assert.equal(formatTurnEvent('turn-tool', { tool: 'x', ok: 'ok' }), 'turn-tool tool=x ok=ok',
    'ok 字面量必须幂等（不得把成功降级成失败）');
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

test('打点事件齐备（turn-start/tool/done/timeout/aborted/failed + AC8 的落库留痕）', () => {
  // FEAT-AC8 P0-C 把 thread-append 加进同一落盘通道（它不是回合事件，
  // 但共用「组装 → 注入落盘」这一层，故同表登记——分开两张表只会两处漂移）。
  // FEAT-AC9 P0-3 补上 turn-aborted / turn-failed：中止与失败此前**冒充**
  // turn-done / turn-timeout（详见 turnDiagnostics 里该段的说明）。
  assert.deepEqual([...TURN_EVENTS],
    ['turn-start', 'turn-tool', 'turn-done', 'turn-timeout', 'turn-aborted', 'turn-failed', 'thread-append']);
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
  // ⚠️ FEAT-AC11 改了形态：三分法（超时/中止/失败）抽成 turnEndingEvent 一处判定，
  // 被**两处** catch 共用（无工具单轮分支 + 有工具多轮循环）。原断言钉的是内联的
  // `if (error.timedOut === true) { … emitTurnEvent('turn-timeout'` —— 那条形态已不存在，
  // 但**行为**必须保留：超时仍要打 turn-timeout 并带耗时/轮数。
  // 故改钉「分类函数里的超时分支」，并保留其余事件断言（行为不变，位置变了）。
  assert.match(loop, /function turnEndingEvent\([\s\S]{0,400}?error\.timedOut === true[\s\S]{0,200}?return \['turn-timeout'/,
    '超时要映射成 turn-timeout 事件');
  assert.match(loop, /'turn-timeout', \{ round, model, elapsed, error \}/,
    '超时事件要带轮数、模型与耗时');
  // 两处 catch 都必须走同一个分类函数（否则又回到「一条路径有打点、另一条没有」）
  const endings = [...loop.matchAll(/emitTurnEvent\(\.\.\.turnEndingEvent\(/g)].length;
  assert.ok(endings >= 2,
    `无工具单轮分支与多轮循环**两处**收尾都要用同一分类函数，当前 ${endings} 处`);
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

// ---------- ⑫ FEAT-AC9 P0：**形状契约**（发射方形状 → 接收方签名）----------
//
// 这一组是本轮的核心防再犯措施。为什么必须有它：
// BUG-E 之所以能活着进真机，是因为**没有任何测试把发射方的形状接到接收方的签名上**——
// workspaceWatchTurn 与 loop 各自测各自的发射形状，turnDiagnostics 测自己的两参签名，
// 而两个接线点是**裸焊**（`onTurnEvent: noteTurnEvent`）。两边各自全绿，集成处断裂。
// 所以下面**真跑**发射方（不是源码正则匹配），把它的输出喂进真实的 noteTurnEvent，
// 断言落盘的**文本**可读。任何人再改坏形状，这里立刻变红。

test('P0 形状契约：loop 的发射形状穿过 noteTurnEvent，产出可读的 turn-*（不是 turn-unknown）', async () => {
  // 真跑一轮带工具的 loop：stub 的 streamChatCompletion 第一轮给工具调用、第二轮收尾。
  stubTools = [{ type: 'function', function: { name: 'set_app_setting', description: '', parameters: {} } }];
  stubStreamPlan = [
    { text: '', toolCalls: [{ id: 'c1', name: 'set_app_setting', arguments: '{"key":"tts.autoBroadcast","value":true}' }] },
    { text: '已打开', toolCalls: [], model: 'm1' },
  ];
  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  try {
    const { runAgentTurn } = loadLoopExports();
    await runAgentTurn([{ role: 'user', content: '打开语音播报' }], {
      mode: 'write',
      onTurnEvent: noteTurnEvent,
    });
  } finally {
    setTurnEventRecorder(null);
  }

  // 关键断言：**一条都不能是 turn-unknown**（这正是真机 4 条 turn-unknown 的形态）
  const unknown = lines.filter(line => line.startsWith('turn-unknown'));
  assert.deepEqual(unknown, [], `不得出现 turn-unknown（形状对不上的形态），实际: ${JSON.stringify(lines)}`);
  // 事件名与字段都要在（名对了但字段空 = 同样不可用）
  const started = lines.find(line => line.startsWith('turn-start'));
  assert.ok(started, `要有 turn-start，实际: ${JSON.stringify(lines)}`);
  const toolPre = lines.find(line => /^turn-tool\b/.test(line) && line.includes('tool=set_app_setting') && !line.includes('ok='));
  assert.ok(toolPre, `要有工具执行前的 turn-tool（带工具名），实际: ${JSON.stringify(lines)}`);
  const toolPost = lines.find(line => /^turn-tool\b/.test(line) && line.includes('ok=ok'));
  assert.ok(toolPost, `要有工具执行后的 turn-tool（带成败），实际: ${JSON.stringify(lines)}`);
  assert.ok(lines.some(line => line.startsWith('turn-done')), '要有 turn-done');
  // 字段不能丢（真机的第二个症状就是「字段全空」）
  assert.match(toolPre, /tool=set_app_setting/, '字段必须渲染出来（不能只剩裸事件名）');
});

test('P0 形状契约：两参形状穿过 noteTurnEvent 同样可读（唯一合法契约）', () => {
  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  try {
    noteTurnEvent('turn-tool', { round: 0, tool: 'set_app_setting', ok: false });
  } finally {
    setTurnEventRecorder(null);
  }
  assert.deepEqual(lines, ['turn-tool round=0 tool=set_app_setting ok=fail']);
});

test('P0 形状契约：单对象形状仍被接收方归一（防御层，未来新接线不再集体 turn-unknown）', () => {
  // 这是**双保险**的第二道：发射方已统一两参，但接收方保留对象归一。
  // 目的不是「继续支持两种形状」，而是让**未来某个忘记对齐的新接线点**
  // 退化成一个可读的打点，而不是一整轮日志全变成 turn-unknown（真机形态）。
  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  try {
    noteTurnEvent({ event: 'turn-tool', round: 2, tool: 'set_app_setting', ok: false });
  } finally {
    setTurnEventRecorder(null);
  }
  assert.deepEqual(lines, ['turn-tool round=2 tool=set_app_setting ok=fail'],
    '对象形状必须被归一成事件名 + 字段（不是 turn-unknown、不是字段全丢）');
});

test('P0 形状契约：内层退回单对象时，回合级去重**仍然生效**（去重必须先归一）', async () => {
  // 这条是注入验证逼出来的真实缺陷（不是假想）：
  // 去重器原先按 `event === 'turn-start'` 判重，而内层若退回单对象形状，
  // `event` 是**对象**⇒ 比较静默失配 ⇒ 去重失效 ⇒ 重复行重新出现。
  // 修法是「先归一、再判重」——接收方防御层不该只在最末端生效。
  // 这里直接构造**单对象形状**的内层发射器，验证去重仍然吃掉重复的边界事件。
  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  try {
    await runWorkspaceWatchTurn({
      userText: '随便说句话',
      thread: { id: 'swthread-abcd', entries: [] },
      appendEntry: async () => {},
      runAgent: async payload => {
        // 模拟「内层 loop 用单对象形状发回合级事件」（形状漂移的情形）
        if (typeof payload.onTurnEvent === 'function') {
          payload.onTurnEvent({ event: 'turn-start', round: 0 });
          payload.onTurnEvent({ event: 'turn-tool', round: 1, tool: 'set_app_setting' });
          payload.onTurnEvent({ event: 'turn-done', round: 1, model: 'm-inner' });
        }
        return { text: '好', steps: [] };
      },
      onTurnEvent: noteTurnEvent,
      t: key => key,
    });
  } finally {
    setTurnEventRecorder(null);
  }
  const starts = lines.filter(line => line.startsWith('turn-start')).length;
  const dones = lines.filter(line => line.startsWith('turn-done')).length;
  assert.equal(starts, 1, `内层单对象形状下 turn-start 仍只能 1 条: ${JSON.stringify(lines)}`);
  assert.equal(dones, 1, `内层单对象形状下 turn-done 仍只能 1 条: ${JSON.stringify(lines)}`);
  // 工具事件照常放行（本层看不到细节，不该吞）
  assert.ok(lines.some(line => line.startsWith('turn-tool') && line.includes('tool=set_app_setting')),
    `工具事件必须放行: ${JSON.stringify(lines)}`);
  // 内层的 model 仍要合并进唯一那条 turn-done
  assert.match(lines.find(line => line.startsWith('turn-done')), /model=m-inner/,
    '内层 model 不得因为形状漂移而丢失');
});

test('P0 形状契约：aborted 收尾走 turn-aborted，不再冒充 turn-done', async () => {
  // classifyTurnEnding 分三种（aborted / timeout / failed），打点必须如实映射。
  // 原实现 `ending === 'aborted' ? 'turn-done' : 'turn-timeout'`：
  //   · 用户点「停止」→ 日志显示**正常完成**；
  //   · 断网这类普通失败 → 日志显示**超时**。
  // 这里真跑 runWorkspaceWatchTurn 的中止路径，断言落盘的是 turn-aborted。
  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  let thrown;
  try {
    const aborted = Object.assign(new Error('已停止'), { canceled: true });
    await runWorkspaceWatchTurn({
      userText: '跑个长任务',
      runAgent: async () => { thrown = aborted; throw aborted; },
      thread: { id: 'swthread-abcd', entries: [] },
      appendEntry: async () => {},
      onTurnEvent: noteTurnEvent,
      t: key => key,
    });
  } finally {
    setTurnEventRecorder(null);
  }
  assert.ok(thrown, '前置条件：runAgent 真的抛了中止错误');
  assert.ok(lines.some(line => line.startsWith('turn-aborted')),
    `中止要打 turn-aborted，实际: ${JSON.stringify(lines)}`);
  assert.equal(lines.some(line => line.startsWith('turn-done')), false,
    `中止不得打成 turn-done（那会让日志显示成正常完成）: ${JSON.stringify(lines)}`);
});

test('P0 形状契约：普通失败走 turn-failed，不再冒充 turn-timeout', async () => {
  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  try {
    await runWorkspaceWatchTurn({
      userText: '跑一下',
      runAgent: async () => { throw new Error('503 Service Unavailable'); },
      thread: { id: 'swthread-abcd', entries: [] },
      appendEntry: async () => {},
      onTurnEvent: noteTurnEvent,
      t: key => key,
    });
  } finally {
    setTurnEventRecorder(null);
  }
  assert.ok(lines.some(line => line.startsWith('turn-failed')),
    `非超时失败要打 turn-failed，实际: ${JSON.stringify(lines)}`);
  assert.equal(lines.some(line => line.startsWith('turn-timeout')), false,
    `普通失败不得打成 turn-timeout（那会误导成「模型没响应」）: ${JSON.stringify(lines)}`);
});

test('P0 形状契约：一个完整工作区回合只发**一组**回合级事件（消除内外层重复）', async () => {
  // 探针实测发现（任务书算式漏掉的一处）：内层 loop.js 也发 turn-start / turn-done，
  // 于是「一个回合」在平面日志里出现 6 条 turn-*（2×start + 2×tool + 2×done），
  // 而用户按「start + pre + post + done = 4 条」核对验收会永远对不上。
  // 收口后：回合级边界事件**只由 runWorkspaceWatchTurn 发**。
  // 模拟真实链路：runWorkspaceWatchTurn → (headlessAgent) → loop。
  stubTools = [{ type: 'function', function: { name: 'set_app_setting', description: '', parameters: {} } }];
  stubStreamPlan = [
    { text: '', toolCalls: [{ id: 'c1', name: 'set_app_setting', arguments: '{"key":"k","value":true}' }] },
    { text: '已改', toolCalls: [], model: 'm1' },
  ];
  const { runAgentTurn } = loadLoopExports();

  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  try {
    await runWorkspaceWatchTurn({
      userText: '帮我打开语音播报',
      mode: 'write',
      thread: { id: 'swthread-abcd', entries: [] },
      appendEntry: async () => {},
      runAgent: async payload => {
        const text = await runAgentTurn(
          [{ role: 'user', content: payload.prompt }],
          { mode: payload.mode, onTurnEvent: payload.onTurnEvent, onToolEvent: payload.onToolEvent }
        );
        return { text: text || '已改', steps: [] };
      },
      onTurnEvent: noteTurnEvent,
      t: key => key,
    });
  } finally {
    setTurnEventRecorder(null);
  }

  const turnLines = lines.filter(line => /^turn-(?!unknown)/.test(line));
  const byName = name => turnLines.filter(line => line.startsWith(name)).length;
  assert.equal(byName('turn-start'), 1, `turn-start 只能 1 条（内外层重复是本轮探针发现的）: ${JSON.stringify(lines)}`);
  assert.equal(byName('turn-done'), 1, `turn-done 只能 1 条: ${JSON.stringify(lines)}`);
  assert.equal(byName('turn-tool'), 2, `工具要两条（pre 带工具名 / post 带成败）: ${JSON.stringify(lines)}`);
  // 内层 turn-done 带的 model 不能因为去重而丢失（信息合并进唯一那条）
  const done = turnLines.find(line => line.startsWith('turn-done'));
  assert.match(done, /model=m1/, '内层带回的 model 必须合并进唯一那条 turn-done（去重不等于丢信息）');
  assert.equal(turnLines.some(line => line.startsWith('turn-unknown')), false,
    `不得有 turn-unknown: ${JSON.stringify(lines)}`);
});
