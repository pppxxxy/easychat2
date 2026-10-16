// FEAT-AC11：跨面板杀回合——修「切个 tab 任务就死」。
//
// 来源：用户 17:38–17:41 真机复现 + 诊断日志 + 截图 #443/#444。
// 对码基线 HEAD=a5b66f0（AC10）。三层根因（全部对码核实）：
//   BUG-A【P0 根因】手机上切任何 tab = 卸载 ChatPanel = abort 运行中回合
//     WorkspaceScreen 窄屏走条件渲染（`panel === 'chat' ? renderChatPanel() : ...`），
//     而 ChatPanel 卸载清理里无条件 abort 了 controllerRef ⇒ 切个 tab 就杀任务。
//     对照：宽屏当年为「切侧栏不丢打了一半的话」已做常驻——平板修了、手机没修。
//   BUG-B【P0 可观测性】abort 路径零打点 ⇒ 这类死亡在日志里完全隐形
//     loop.js 的收尾 catch 只在 error.timedOut === true 时发 turn-timeout，
//     用户停止 / 面板卸载 abort 一个事件都不发（两个回合只到 turn-tool 就没了）。
//   BUG-C【P1】turn-tool 失败事件不带原因（round 7 两条 read 失败为什么失败，日志答不上）
//   BUG-D【P1 UX】确认弹窗看不出「这是重试」/「还要点几次」
//
// 测试分工（仓库纪律）：能真跑的纯逻辑真跑；渲染结构靠**源码契约**断言
//（本仓无 react-test-renderer 依赖——见下方 P0-1 组的说明）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  TURN_EVENTS,
  formatTurnEvent,
  noteTurnEvent,
  setTurnEventRecorder,
} from '../src/screenWatch/turnDiagnostics.js';
import {
  abortWithReason,
  normalizeAbortReason,
  readAbortReason,
} from '../src/agent/turnAbort.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const loopPath = path.resolve('src/agent/loop.js');

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// 去掉注释（含块注释与行内 `/* … */`）。
//
// ⚠️ 不能用「只删行首是 // 或 * 的行」那种简易写法：本仓的 JSX 注释形如
// `{/* … */}`，注释体从**行中间**开始，简易写法删不掉；而 AC11 的说明注释里
// 正引用了旧的（要禁止的）条件渲染写法——于是「断言不得出现旧写法」会被
// **我自己的解释性注释**打红（本仓反复踩过的假阳性形态）。
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------- ① 中止理由边车（P0-2 的一半）——纯逻辑真跑 ----------

test('P0-2 边车：abortWithReason **同时**写 controller 与 controller.signal', () => {
  // 这是本模块存在的核心理由：AbortController 与它的 signal 是**两个对象**。
  // 只写 controller.abortReason 时，loop 拿到的是 options.signal（= controller.signal）
  // ——读不到那个字段，理由静默变空串，日志里只有 turn-aborted 没有 reason。
  const controller = new AbortController();
  assert.equal(controller.signal.aborted, false);
  const ok = abortWithReason(controller, 'panel-switch');
  assert.equal(ok, true);
  assert.equal(controller.abortReason, 'panel-switch', 'controller 上要能看到（宿主/调试用）');
  assert.equal(controller.signal.abortReason, 'panel-switch', 'signal 上也要有（loop 读的是它）');
  assert.equal(controller.signal.aborted, true);
  assert.equal(readAbortReason(controller.signal), 'panel-switch', '读得到');
});

test('P0-2 边车：**先到先得**——已中止的 controller 不被覆盖理由', () => {
  // 关屏（visible=false）先 abort，随后组件卸载还会再走一次清理。
  // 若第二次覆盖，理由会从 'screen-close' 变成 'panel-unmount'，把人指向错误方向。
  const controller = new AbortController();
  abortWithReason(controller, 'screen-close');
  const second = abortWithReason(controller, 'panel-unmount');
  assert.equal(second, false, '已中止时不再执行（不覆盖已有理由）');
  assert.equal(readAbortReason(controller.signal), 'screen-close', '理由必须保持第一次的值');
});

test('P0-2 边车：非法理由一律丢弃（绝不猜）', () => {
  // 理由是**枚举式原因码**，不是自由文本通道（防正文/隐私从这里漏进日志）。
  for (const bad of ['', '   ', 'Panel-Switch', '有中文', 'a'.repeat(64), 123, null, undefined, {}]) {
    assert.equal(normalizeAbortReason(bad), '', `非法理由必须归一成空串: ${JSON.stringify(bad)}`);
  }
  // 读不到时返回空串（而不是编一个）——编理由比没理由更糟。
  const controller = new AbortController();
  controller.abort();
  assert.equal(readAbortReason(controller.signal), '', '无边车 → 空串（不编）');
  assert.equal(readAbortReason(null), '', '无 signal → 空串');
  assert.equal(readAbortReason(undefined), '', 'undefined → 空串');
});

test('P0-2 边车：合法标签透传，非法标签不写（但 abort 照常生效）', () => {
  const controller = new AbortController();
  abortWithReason(controller, 'NOT VALID');
  assert.equal(controller.signal.aborted, true, '理由非法也必须真的中止（中止是主行为）');
  assert.equal(readAbortReason(controller.signal), '', '但不要写非法标签进去');
  // controller 缺失/坏掉时不抛（打点辅助能力不该影响主流程）
  assert.equal(abortWithReason(null, 'user-stop'), false);
  assert.equal(abortWithReason({}, 'user-stop'), false);
});

// ---------- ② loop 的 abort 打点（P0-2）——真跑，断言落盘文本 ----------
//
// loop.js 不能直接 import（静态链经 api.js → storage/io.js 拖进 expo-file-system），
// 用与 agentLoop.test.mjs / overlayTurnResilience.test.mjs 同一套 Babel + Module._load 桩。

let stubTools = [];
let stubStreamPlan = [];
let stubRunTool = null;
const apiStub = {
  createAbortError: () => Object.assign(new Error('已停止'), { name: 'AbortError', canceled: true }),
  isCanceledError: error => !!(error && (error.canceled === true || error.name === 'AbortError')),
  // ⚠️ 桩必须**如实模拟**真实 api.js 的中止行为：signal 一 abort，请求就
  // **reject(AbortError)**（api.js:669-677 `onAbortSignal → fail(createAbortError())`）。
  // 我第一版的桩无视 signal 直接返回文本，于是 loop 走的是「正常完成」路径——
  // 测出来的失败是**桩不真实**，不是被测代码有问题（这类假失败会诱导人去改对的代码）。
  streamChatCompletion: async (messages, opts = {}) => {
    const signal = opts.signal || null;
    if (signal && signal.aborted) throw apiStub.createAbortError();
    const plan = stubStreamPlan.shift() || { text: '', toolCalls: [] };
    if (typeof plan.onCall === 'function') plan.onCall();
    // 调用过程中被中止（模拟「用户在 round 2 的 LLM 调用中点了停止」）
    if (signal && signal.aborted) throw apiStub.createAbortError();
    if (plan.throw) throw plan.throw;
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
  runTool: async (call, ctx) => (stubRunTool ? stubRunTool(call, ctx) : { content: 'ok', isError: false }),
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

/**
 * 捕获一轮回合的落盘打点。
 *
 * ⚠️ 必须注入 noteTurnEvent 作为 onTurnEvent：loop.js **只在宿主提供了钩子时**
 * 才发射事件（`const onTurnEvent = typeof options.onTurnEvent === 'function' ? … : null`）。
 * 只装 recorder 而不注入钩子时，事件在 loop 里就被丢掉了——那正是 AC8 BUG-D
 * 「定义了却没人注入」的形态，我第一版测试正是这么写的（全红）。
 *
 * @param {(opts: object) => Promise<any>} run 接收 { onTurnEvent } 的 runner
 */
async function captureTurnEvents(run) {
  const lines = [];
  setTurnEventRecorder(line => lines.push(line));
  try {
    await run({ onTurnEvent: noteTurnEvent });
  } finally {
    setTurnEventRecorder(null);
  }
  return lines;
}

test('P0-2：用户停止 → turn-aborted 带 reason=user-stop（此前零事件）', async () => {
  stubTools = [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }];
  const controller = new AbortController();
  stubStreamPlan = [
    // 第 1 轮：在模型请求处触发中止（模拟用户在 round 2 的 LLM 调用中点了停止）
    { text: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
    { onCall: () => abortWithReason(controller, 'user-stop') },
  ];
  const { runAgentTurn } = loadLoopExports();

  const lines = await captureTurnEvents(async ({ onTurnEvent }) => {
    await assert.rejects(
      () => runAgentTurn([{ role: 'user', content: 'hi' }], {
        mode: 'write', signal: controller.signal, onTurnEvent,
      }),
      /停止/
    );
  });
  const aborted = lines.find(line => line.startsWith('turn-aborted'));
  assert.ok(aborted, `中止必须打点（此前完全隐形）: ${JSON.stringify(lines)}`);
  assert.match(aborted, /reason=user-stop/, `必须带理由: ${aborted}`);
  assert.match(aborted, /round=/, '带轮数');
  assert.match(aborted, /elapsed=/, '带耗时');
  // 中止不得冒充正常完成
  assert.equal(lines.some(line => line.startsWith('turn-done')), false,
    `中止不得打成 turn-done（那会显示成正常完成）: ${JSON.stringify(lines)}`);
});

test('P0-2：不同来源的理由各自如实落盘（panel-switch / screen-close）', async () => {
  const { runAgentTurn } = loadLoopExports();
  for (const reason of ['panel-switch', 'screen-close', 'switch-chat']) {
    stubTools = [];
    const controller = new AbortController();
    stubStreamPlan = [{ onCall: () => abortWithReason(controller, reason) }];
    const lines = await captureTurnEvents(async ({ onTurnEvent }) => {
      await assert.rejects(() => runAgentTurn([{ role: 'user', content: 'hi' }], {
        // 无工具分支也会经 if (effectiveSignal.aborted) throwIfStopped() 中止
        mode: 'read', signal: controller.signal, onTurnEvent,
      }));
    });
    const aborted = lines.find(line => line.startsWith('turn-aborted'));
    assert.ok(aborted, `[${reason}] 要有 turn-aborted: ${JSON.stringify(lines)}`);
    assert.match(aborted, new RegExp(`reason=${reason}`), `[${reason}] 理由要如实: ${aborted}`);
  }
});

test('P0-2：无理由边车时仍打出 turn-aborted（只是没有 reason 字段）', async () => {
  // 「绝不猜」：读不到理由就不写 reason，但事件本身必须发出来（否则又是隐形死亡）。
  stubTools = [];
  const controller = new AbortController();
  stubStreamPlan = [{ onCall: () => controller.abort() }];
  const { runAgentTurn } = loadLoopExports();
  const lines = await captureTurnEvents(async ({ onTurnEvent }) => {
    await assert.rejects(() => runAgentTurn([{ role: 'user', content: 'hi' }], {
      mode: 'read', signal: controller.signal, onTurnEvent,
    }));
  });
  const aborted = lines.find(line => line.startsWith('turn-aborted'));
  assert.ok(aborted, `要有 turn-aborted: ${JSON.stringify(lines)}`);
  assert.equal(aborted.includes('reason='), false, `读不到理由时不得编一个: ${aborted}`);
});

test('P0-2：非中止的真错误打 turn-failed（不是 turn-aborted）', async () => {
  // 与中止分开：中止是意图（用户/宿主停的），失败是故障。混在一起排查时无法分辨。
  stubTools = [];
  stubStreamPlan = [{ throw: Object.assign(new Error('503 Service Unavailable'), { name: 'Error' }) }];
  const { runAgentTurn } = loadLoopExports();
  const lines = await captureTurnEvents(async ({ onTurnEvent }) => {
    await assert.rejects(() => runAgentTurn([{ role: 'user', content: 'hi' }], {
      mode: 'read', onTurnEvent,
    }));
  });
  assert.ok(lines.some(line => line.startsWith('turn-failed')),
    `真错误要打 turn-failed: ${JSON.stringify(lines)}`);
  assert.equal(lines.some(line => line.startsWith('turn-aborted')), false,
    `真错误不得打成 turn-aborted: ${JSON.stringify(lines)}`);
});

test('P0-2：事件表登记齐备（turn-aborted / turn-failed 都在白名单里）', () => {
  // 未登记的事件会被渲染成 turn-unknown（AC9 的教训）——这里反向钉住。
  assert.ok(TURN_EVENTS.includes('turn-aborted'), 'turn-aborted 必须登记');
  assert.ok(TURN_EVENTS.includes('turn-failed'), 'turn-failed 必须登记');
  // reason 必须在字段白名单里，否则带上去也会被渲染层丢掉
  const line = formatTurnEvent('turn-aborted', { round: 1, reason: 'user-stop', elapsed: 5 });
  assert.equal(line, 'turn-aborted round=1 reason=user-stop elapsed=5ms');
});

test('P0-2：reason 只接受短标签且经白名单渲染（自由文本进不去）', () => {
  // 日志字段是白名单过滤的：即使误传长文本，formatTurnEvent 也会渲染它——
  // 所以「只认短标签」这条把关必须在**写边车那一层**（turnAbort）。
  // 这里断言渲染层确实会输出 reason（说明白名单生效），并断言边车层拒绝长文本。
  assert.equal(normalizeAbortReason('x'.repeat(32)), 'x'.repeat(32), '32 字符以内合法');
  assert.equal(normalizeAbortReason(`x${'y'.repeat(32)}`), '', '超过 32 字符拒绝');
  assert.equal(normalizeAbortReason('user-stop'), 'user-stop');
});

// ---------- ③ turn-tool 失败带原因（P1-3）——真跑 ----------

test('P1-3：工具失败 → turn-tool ok=fail 带原因摘要（此前只有 ok=fail）', async () => {
  stubTools = [{ type: 'function', function: { name: 'read_workspace_file', description: '', parameters: {} } }];
  stubRunTool = () => ({ content: '文件不存在：src/nope.js', isError: true });
  stubStreamPlan = [
    { text: '', toolCalls: [{ id: 'c1', name: 'read_workspace_file', arguments: '{"path":"src/nope.js"}' }] },
    { text: '放弃了', toolCalls: [] },
    { text: '收尾', toolCalls: [] },
  ];
  const { runAgentTurn } = loadLoopExports();
  const lines = await captureTurnEvents(async ({ onTurnEvent }) => {
    await runAgentTurn([{ role: 'user', content: '读一下' }], { mode: 'write', onTurnEvent });
  });
  const failed = lines.find(line => /^turn-tool\b/.test(line) && line.includes('ok=fail'));
  assert.ok(failed, `要有失败的 turn-tool: ${JSON.stringify(lines)}`);
  assert.match(failed, /error=文件不存在/, `失败必须带原因摘要: ${failed}`);
});

test('P1-3：失败摘要**只取首行**且截断（多行正文/堆栈不进打点）', async () => {
  // ⚠️ 必须**直接断言纯函数**，不能只断言日志文本：渲染层（turnDiagnostics 的 error
  // 分支）自己也会取首行，两层做同一件事 ⇒ 「loop 层取首行」坏掉时日志看起来没变。
  // 注入验证实测到过这个空转（把取首行改成取全文，日志断言照样通过）。
  const { describeToolFailure, TOOL_FAILURE_SUMMARY_MAX } = await import('../src/agent/toolFailure.js');
  assert.equal(describeToolFailure({ content: '第一行原因\n第二行堆栈\n第三行' }), '第一行原因',
    '只取首行');
  assert.equal(describeToolFailure({ content: '  \n第二行才是有内容的' }), '', '首行为空白 → 空串');
  assert.equal(describeToolFailure({ content: '' }), '', '空 content → 空串');
  assert.equal(describeToolFailure(null), '', 'null → 空串（不抛）');
  assert.equal(describeToolFailure({}), '', '无 content → 空串');
  // 截断到上限
  const long = 'x'.repeat(500);
  assert.equal(describeToolFailure({ content: long }).length, TOOL_FAILURE_SUMMARY_MAX,
    `超长必须截断到 ${TOOL_FAILURE_SUMMARY_MAX}`);
});

test('P1-3：失败摘要**先脱敏再截断**（密钥不得随工具结果进日志）', async () => {
  const { describeToolFailure } = await import('../src/agent/toolFailure.js');
  const { registerSecretValues, clearRegisteredSecrets } = await import('../src/storage/secrets.js');
  try {
    registerSecretValues(['sk-live-abcdefghijklmnop']);
    const masked = describeToolFailure({ content: '请求失败：sk-live-abcdefghijklmnop 无效\n堆栈' });
    assert.equal(masked.includes('sk-live-abcdefghijklmnop'), false,
      `密钥必须被掩码: ${masked}`);
    assert.match(masked, /已隐藏/, '掩码标记要在');
    assert.match(masked, /请求失败/, '首行原因仍要保留');
    // 顺序：**先脱敏再截断**。反过来的话，跨在截断点上的密钥会被截成半截躲过掩码。
    // 构造一个「密钥刚好跨越截断点」的输入来钉住顺序。
    const secret = 'sk-live-abcdefghijklmnop';
    const padded = `${'a'.repeat(150)}${secret}`; // 密钥从 150 开始，跨越 160 的边界
    const out = describeToolFailure({ content: padded });
    assert.equal(out.includes('sk-live'), false,
      `跨截断点的密钥也必须被完整掩码（先脱敏再截断）: ${out.slice(-40)}`);
  } finally {
    clearRegisteredSecrets();
  }
});

test('P1-3：成功事件**不带** error 字段（不给日志灌噪音）', async () => {
  stubTools = [{ type: 'function', function: { name: 'read_workspace_file', description: '', parameters: {} } }];
  stubRunTool = () => ({ content: '文件内容很长很长', isError: false });
  stubStreamPlan = [
    { text: '', toolCalls: [{ id: 'c1', name: 'read_workspace_file', arguments: '{"path":"a"}' }] },
    { text: '收尾', toolCalls: [] },
    { text: '收尾2', toolCalls: [] },
  ];
  const { runAgentTurn } = loadLoopExports();
  const lines = await captureTurnEvents(async ({ onTurnEvent }) => {
    await runAgentTurn([{ role: 'user', content: '读' }], { mode: 'write', onTurnEvent });
  });
  const okLine = lines.find(line => /^turn-tool\b/.test(line) && line.includes('ok=ok'));
  assert.ok(okLine, `要有成功打点: ${JSON.stringify(lines)}`);
  assert.equal(okLine.includes('error='), false, `成功不得带 error: ${okLine}`);
});

// ---------- ④ 确认弹窗的重试标注与进度感（P1-4）----------真跑纯函数 ----------

test('P1-4：attempt≥2 才标注重试；缺失/非法不标注（不编数）', async () => {
  const { describeToolApproval } = await import('../src/chat/toolApproval.js');
  const t = (key, params) => (key === 'chat.tool.approval.retryNote' ? `RETRY:${params.n}` : key);
  const args = { command: 'git clone x' };
  // 首次（1）不标注——加「第 1 次」纯属噪音
  assert.equal(
    describeToolApproval({ name: 'run_shell', args, t, attempt: 1 }).body.includes('RETRY:'),
    false, '首次不得标注重试'
  );
  assert.match(describeToolApproval({ name: 'run_shell', args, t, attempt: 2 }).body, /RETRY:2/);
  // 未知/缺失 → 不标注
  for (const bad of [0, undefined, null, 'x', 1.5]) {
    assert.equal(
      describeToolApproval({ name: 'run_shell', args, t, attempt: bad }).body.includes('RETRY:'),
      false, `非法 attempt 不得标注: ${JSON.stringify(bad)}`
    );
  }
});

test('P1-4：进度提示只在 batchRemaining>0 时出现（不可得就不显示，不编数）', async () => {
  const { describeToolApproval } = await import('../src/chat/toolApproval.js');
  const t = (key, params) => (key === 'chat.tool.approval.progressNote' ? `PROGRESS:${params.n}` : key);
  const args = { command: 'git clone x' };
  assert.match(describeToolApproval({ name: 'run_shell', args, t, batchRemaining: 4 }).body, /PROGRESS:4/);
  for (const bad of [0, undefined, null, -1, 'x']) {
    assert.equal(
      describeToolApproval({ name: 'run_shell', args, t, batchRemaining: bad }).body.includes('PROGRESS:'),
      false, `不可得时不得显示进度: ${JSON.stringify(bad)}`
    );
  }
});

test('P1-4：只加信息——三选项与拒绝优先的结算一字不动', async () => {
  const { describeToolApproval } = await import('../src/chat/toolApproval.js');
  const t = key => key;
  const copy = describeToolApproval({
    name: 'run_shell', args: { command: 'x' }, t, attempt: 2, batchRemaining: 3,
  });
  // 三选项仍在（+ ask 档的 once）
  for (const key of ['deny', 'allow', 'session', 'always', 'once']) {
    assert.ok(copy[key], `必须有 ${key} 按钮文案`);
  }
  // 加信息不得改变「谁能放行」——这里只断言文案对象形状未变（结算逻辑在 approveToolCall，
  // 由既有的 toolPermissions / agentToolApproval 测试覆盖，本批一字未改）。
  assert.equal(typeof copy.title, 'string');
  assert.equal(typeof copy.body, 'string');
});

// ---------- ⑤ 窄屏 ChatPanel 常驻（P0-1）——源码结构契约 ----------
//
// 为什么用源码契约而不是真渲染断言（如实标注）：本仓**没有 react-test-renderer
// 依赖**（package.json 的 devDependencies 里没有），任务书 §三 建议的
// 「用 react-test-renderer 断言切 panel 不 unmount ChatPanel」在当前依赖下无法执行。
// 沙箱也不便为此引入新依赖（会动 lockfile）。故这里钉**结构契约**：
// 窄屏分支不得出现条件渲染（那正是卸载的成因），且对话面板必须挂在一个
// 常驻容器里（paneHidden 只是样式隐藏）。这与本仓对 Kotlin/结构类改动的既有做法一致。

test('P0-1：窄屏分支**不得**条件渲染对话面板（切 tab 不再卸载 ⇒ 不再 abort 回合）', () => {
  const screen = read('src/workspace/screen/WorkspaceScreen.js');
  const code = stripComments(screen);
  // 旧形态（根因）：`(panel === 'chat' ? renderChatPanel() : renderDomainPanel(panel))`
  // ——三目直接决定渲染哪个组件，切 tab 必然卸载另一个。
  assert.equal(
    /panel === 'chat' \? renderChatPanel\(\) : renderDomainPanel\(panel\)/.test(code),
    false,
    '窄屏不得再条件渲染（那会在切 tab 时卸载 ChatPanel，连带 abort 运行中的回合）'
  );
  // 新形态：对话面板挂在一个容器里，容器样式随 panel 切换（常驻 + 隐藏）
  assert.match(code, /\{renderChatPanel\(\)\}/,
    '对话面板仍由 renderChatPanel() 渲染');
  const paneHiddenUses = [...code.matchAll(/styles\.paneHidden/g)].length;
  assert.ok(paneHiddenUses >= 2,
    `paneHidden（display:'none' 的隐藏容器）应被宽窄屏共用，当前 ${paneHiddenUses} 处`);
});

test('P0-1：隐藏用的是 display:none（**不是** false && 之类的卸载写法）', () => {
  const screen = read('src/workspace/screen/WorkspaceScreen.js');
  // paneHidden 的定义必须是样式级隐藏
  assert.match(screen, /paneHidden: \{ display: 'none' \}/,
    "paneHidden 必须是 display:'none'（组件保持挂载）");
  // 不得用 `{false && ...}` / `{panel !== 'chat' && ...}` 把 ChatPanel 包起来
  //（那仍是条件渲染，只是藏了 JSX——本轮修的就是这个语义差）
  const code = stripComments(screen);
  assert.equal(
    /\{[^}]*&&\s*renderChatPanel\(\)/.test(code),
    false,
    '不得用 `&&` 条件渲染 ChatPanel（仍是卸载，只是写法更隐晦）'
  );
});

test('P0-1：卸载清理里的 abort **保留**（服务「关掉整个工作区即停」）但必须带理由', () => {
  const chat = stripComments(read('src/workspace/screen/ChatPanel.js'));
  // 关屏即停是**有意设计**，不得因为本轮修复而被删掉
  assert.match(chat, /if \(visible\) return;[\s\S]{0,300}?abortTurn\(controllerRef\.current, 'screen-close'\)/,
    '关屏（visible=false）必须仍然立即中止，且标 screen-close');
  assert.match(chat, /abortTurn\(controllerRef\.current, 'panel-unmount'\)/,
    '组件卸载兜底仍在，标 panel-unmount（P0-1 后它只应出现在 Modal 销毁路径）');
  assert.match(chat, /abortTurn\(controllerRef\.current, 'user-stop'\)/,
    '用户点停止标 user-stop');
});

test('P0-1：ChatPanel 的行数回落到棘轮基线之下（纪律：拆文件，不抬上限）', () => {
  const count = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  const baseline = JSON.parse(read('architecture-baseline.json')).fileLineBaseline;
  const limit = baseline['src/workspace/screen/ChatPanel.js'];
  assert.ok(limit, 'ChatPanel 必须在基线里（它仍超 800 硬上限）');
  const lines = count(read('src/workspace/screen/ChatPanel.js'));
  assert.ok(lines <= limit,
    `ChatPanel ${lines} 行 > 基线 ${limit}：本轮新增的接线必须靠**外提**腾出空间，不得抬基线`);
  // 外提的模块确实存在且被引用
  const drafts = read('src/workspace/screen/chatPanelDrafts.js');
  assert.match(drafts, /export function persistDraft/, '草稿落盘已外提');
  assert.match(read('src/workspace/screen/ChatPanel.js'),
    /from '\.\/chatPanelDrafts\.js'/, 'ChatPanel 必须引用外提后的模块（不是只创建文件）');
});

test('P0-1：窄屏常驻的注释不得再声称「窄屏走条件渲染」（防误导后人）', () => {
  const screen = read('src/workspace/screen/WorkspaceScreen.js');
  // 宽屏那段注释原文写着「窄屏逐字不变（下面的 else 分支就是原来的条件渲染）」——
  // AC11 之后该说法已不成立，留着会让人以为窄屏仍会卸载。
  assert.equal(screen.includes('窄屏**逐字不变**'), false,
    '旧注释必须更新（窄屏已改为常驻，否则误导后人）');
  assert.match(screen, /FEAT-AC11 P0-1/,
    '窄屏常驻处要有 FEAT-AC11 的成因说明（为什么两处必须一起改）');
});

// ---------- ⑥ 行数棘轮 ----------

test('行数：本轮新增/修改文件都在 800 硬上限内', () => {
  const count = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  for (const file of [
    'src/agent/loop.js',
    'src/agent/turnAbort.js',
    'src/agent/toolFailure.js',
    'src/agent/tools/registry.js',
    'src/chat/toolApproval.js',
    'src/chat/toolApprovalFlow.js',
    'src/screenWatch/turnDiagnostics.js',
    'src/workspace/screen/WorkspaceScreen.js',
    'src/workspace/screen/chatPanelDrafts.js',
  ]) {
    const lines = count(read(file));
    assert.ok(lines <= 800, `${file}: ${lines} > 800（棘轮纪律：拆文件，不抬上限）`);
  }
});
