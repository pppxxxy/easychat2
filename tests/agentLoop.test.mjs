import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const loopPath = path.resolve('src/agent/loop.js');
const transformed = babel.transformSync(fs.readFileSync(loopPath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: loopPath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

function createAbortError() {
  const error = new Error('已停止生成。');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}
function isCanceledError(error) {
  return !!error && (error.canceled === true || error.name === 'AbortError');
}

let streamCalls;
let streamPlan;
let fakeTools;
let runCalls;
let runHandler;

function resetFakes() {
  streamCalls = [];
  streamPlan = [];
  fakeTools = [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }];
  runCalls = [];
  runHandler = () => ({ content: 'file body', isError: false });
}

const apiStub = {
  createAbortError,
  isCanceledError,
  streamChatCompletion: async (messages, options = {}) => {
    const index = streamCalls.length;
    streamCalls.push({ messages: messages.map(item => ({ ...item })), options });
    const plan = streamPlan[index] || { text: '' };
    // I1：轮次钩子——测试用来模拟「用户在本轮进行中发送补充指令」。
    if (typeof plan.onRound === 'function') plan.onRound(index);
    for (const chunk of plan.chunks || []) {
      if (typeof options.onChunk === 'function') options.onChunk(chunk);
    }
    return {
      text: typeof plan.text === 'string' ? plan.text : '',
      reasoning: plan.reasoning || '',
      toolCalls: plan.toolCalls || [],
      finishReason: plan.finishReason || null,
      // E1：usage 透传测试用（不配置 = null，与真实端点不返回 usage 同形）。
      usage: plan.usage || null,
    };
  },
};

const registryStub = {
  listToolsForMode: () => fakeTools,
  runTool: async (call, ctx) => {
    runCalls.push({ call, ctx });
    return runHandler(call, ctx);
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../network/api.js') return apiStub;
  if (request === './tools/registry.js') return registryStub;
  return originalLoad.call(this, request, parent, isMain);
};

function loadLoop() {
  const filename = loopPath;
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

test.beforeEach(() => {
  resetFakes();
});

test('无工具时单轮透传并返回文本', async () => {
  fakeTools = [];
  streamPlan = [{ text: '你好', chunks: ['你', '你好'] }];
  const { runAgentTurn } = loadLoop();
  const tokens = [];
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'ask',
    onToken: value => tokens.push(value),
  });
  assert.equal(text, '你好');
  assert.deepEqual(tokens, ['你', '你好']);
  assert.equal(streamCalls.length, 1);
  assert.equal('tools' in streamCalls[0].options, false);
});

test('工具轮：执行工具、回喂结果、下一轮累积返回', async () => {
  streamPlan = [
    {
      text: '想查',
      chunks: ['想', '想查'],
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
    },
    { text: '结果', chunks: ['结', '结果'] },
  ];
  const { runAgentTurn } = loadLoop();
  const tokens = [];
  const toolEvents = [];
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    onToken: value => tokens.push(value),
    onToolEvent: event => toolEvents.push(event),
  });
  assert.equal(text, '想查结果');
  assert.deepEqual(tokens, ['想', '想查', '想查结', '想查结果']);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].call.name, 'read_file');
  assert.equal(runCalls[0].ctx.mode, 'read');
  assert.equal(streamCalls[0].options.tools.length, 1);
  assert.equal(streamCalls[0].options.toolChoice, 'auto');
  const round2 = streamCalls[1].messages;
  const assistant = round2.find(item => item.role === 'assistant' && item.tool_calls);
  assert.equal(assistant.content, '想查');
  assert.equal(assistant.tool_calls[0].id, 'c1');
  const toolMsg = round2.find(item => item.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.equal(toolMsg.content, 'file body');
  // A3 二期：start 事件带解析后的参数（订阅方——计划进度条——据此读 update_plan）；
  // end 事件不带（结果已由工具返回值表达）。
  assert.deepEqual(toolEvents, [
    { phase: 'start', name: 'read_file', round: 1, args: { path: 'a' } },
    { phase: 'end', name: 'read_file', round: 1, ok: true },
  ]);
});

test('O0.2：计划有未完成步骤且连续 3 轮未更新 update_plan → 轮末注入 nag', async () => {
  fakeTools = [
    { type: 'function', function: { name: 'update_plan', description: '', parameters: {} } },
    { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
  ];
  // 轮 1：列计划（未完成）；轮 2-4：只读文件、不更新计划；轮 5：收尾。
  streamPlan = [
    { text: '', toolCalls: [{ id: 'p1', name: 'update_plan', arguments: '{"plan":[{"step":"A","status":"in_progress"}]}' }] },
    { text: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: '{"path":"1"}' }] },
    { text: '', toolCalls: [{ id: 'r2', name: 'read_file', arguments: '{"path":"2"}' }] },
    { text: '', toolCalls: [{ id: 'r3', name: 'read_file', arguments: '{"path":"3"}' }] },
    { text: 'done' },
  ];
  const { runAgentTurn } = loadLoop();
  await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read' });
  // 第 5 轮请求里应带上一轮末注入的 nag（round 4 结束时计数达到 3）。
  const last = streamCalls[4].messages;
  assert.ok(
    last.some(item => item.role === 'system' && /未完成步骤/.test(String(item.content))),
    '达到阈值应注入 nag'
  );
  // 更早一轮（第 3 轮请求）不应有 nag。
  const earlier = streamCalls[2].messages;
  assert.equal(earlier.some(item => item.role === 'system' && /未完成步骤/.test(String(item.content))), false);
});

test('O0.2：计划全 done 时不注入 nag', async () => {
  fakeTools = [
    { type: 'function', function: { name: 'update_plan', description: '', parameters: {} } },
    { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
  ];
  streamPlan = [
    { text: '', toolCalls: [{ id: 'p1', name: 'update_plan', arguments: '{"plan":[{"step":"A","status":"done"}]}' }] },
    { text: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: '{"path":"1"}' }] },
    { text: '', toolCalls: [{ id: 'r2', name: 'read_file', arguments: '{"path":"2"}' }] },
    { text: '', toolCalls: [{ id: 'r3', name: 'read_file', arguments: '{"path":"3"}' }] },
    { text: 'done' },
  ];
  const { runAgentTurn } = loadLoop();
  await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read' });
  const last = streamCalls[4].messages;
  assert.equal(last.some(item => item.role === 'system' && /未完成步骤/.test(String(item.content))), false);
});

test('O1：超限工具结果经 persistToolResult 落盘，消息里只留指针', async () => {
  const { runAgentTurn, TOOL_RESULT_LIMIT } = loadLoop();
  streamPlan = [
    { text: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: 'done' },
  ];
  const big = 'y'.repeat(TOOL_RESULT_LIMIT + 50);
  runHandler = () => ({ content: big, isError: false });
  const persisted = [];
  await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    persistToolResult: async (content, meta) => {
      persisted.push({ len: content.length, meta });
      return { path: '.task_outputs/tool-results/c1.txt' };
    },
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].len, big.length);
  assert.equal(persisted[0].meta.toolCallId, 'c1');
  const toolMsg = streamCalls[1].messages.find(item => item.role === 'tool');
  assert.match(String(toolMsg.content), /\.task_outputs\/tool-results\/c1\.txt/);
});

test('assistant 空文本带 tool_calls 时 content 置 null', async () => {
  streamPlan = [
    { text: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: '完成' },
  ];
  const { runAgentTurn } = loadLoop();
  await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read' });
  const assistant = streamCalls[1].messages.find(item => item.role === 'assistant' && item.tool_calls);
  assert.equal(assistant.content, null);
});

test('上限轮整体省略 tools 字段并注入系统提示', async () => {
  streamPlan = [
    { text: 't1', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: 'final' },
  ];
  const { runAgentTurn, CAP_NOTICE } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read', maxRounds: 1 });
  assert.equal(text, 't1final');
  assert.equal(streamCalls.length, 2);
  assert.equal('tools' in streamCalls[1].options, false);
  assert.equal('toolChoice' in streamCalls[1].options, false);
  assert.ok(streamCalls[1].messages.some(item => item.role === 'system' && item.content === CAP_NOTICE));
});

test('A1 轮次预算：默认 12 / 分档 16-10-12；剩 2 轮注入预警、到顶保留强插', async () => {
  const {
    DEFAULT_MAX_TOOL_ROUNDS,
    ROUND_BUDGET_WARNING,
    workspaceRoundBudget,
    CAP_NOTICE,
  } = loadLoop();
  assert.equal(DEFAULT_MAX_TOOL_ROUNDS, 12, '默认预算 5 → 12（管道早已存在，只改默认值）');
  assert.equal(workspaceRoundBudget('write'), 16, '写任务跑改-验循环，预算最长');
  assert.equal(workspaceRoundBudget('read'), 10);
  assert.equal(workspaceRoundBudget('ask'), 12);
  assert.equal(workspaceRoundBudget(undefined), 12);

  // maxRounds=4：每轮都调工具，逼到上限 → 第 5 次调用（无 tools）是强制收尾轮
  const toolCall = id => ({ id, name: 'read_file', arguments: '{}' });
  streamPlan = [
    { text: 'r1', toolCalls: [toolCall('c1')] },
    { text: 'r2', toolCalls: [toolCall('c2')] },
    { text: 'r3', toolCalls: [toolCall('c3')] },
    { text: 'r4', toolCalls: [toolCall('c4')] },
    { text: 'final' },
  ];
  const { runAgentTurn } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read', maxRounds: 4 });
  assert.equal(text, 'r1r2r3r4final');

  const systemHas = (index, content) => streamCalls[index].messages
    .some(item => item.role === 'system' && item.content === content);
  // 预警出现在第 maxRounds-2（=2）轮之后：第 3 次调用就能看到
  assert.equal(systemHas(1, ROUND_BUDGET_WARNING), false, '第 2 次调用还不到时候');
  assert.equal(systemHas(2, ROUND_BUDGET_WARNING), true, '第 3 次调用应看到「剩 2 轮」预警');
  assert.equal(systemHas(2, CAP_NOTICE), false, '预警阶段还不是强制收尾');
  // 到顶：强制收尾轮省略 tools + 注入 CAP_NOTICE
  assert.equal(systemHas(4, CAP_NOTICE), true);
  assert.equal('tools' in streamCalls[4].options, false);
});

test('A1 预警不打扰提前收尾：模型按时给出结论就只调一次', async () => {
  streamPlan = [{ text: '直接回答' }];
  const { runAgentTurn, ROUND_BUDGET_WARNING } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read', maxRounds: 4 });
  assert.equal(text, '直接回答');
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].messages.some(item => item.content === ROUND_BUDGET_WARNING), false);
});

test('E1 usage 透传：每轮 usage 经 onUsage 上抛（端点不返回时回调零次）', async () => {
  const toolCall = id => ({ id, name: 'read_file', arguments: '{}' });
  streamPlan = [
    { text: 'r1', toolCalls: [toolCall('c1')], usage: { promptTokens: 100, completionTokens: 5, cachedTokens: 80 } },
    { text: '完成', usage: { promptTokens: 200, completionTokens: 6, cachedTokens: 150 } },
  ];
  const { runAgentTurn } = loadLoop();
  const seen = [];
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    onUsage: entry => seen.push(entry),
  });
  assert.equal(text, 'r1完成');
  assert.equal(seen.length, 2, '两轮各上抛一次');
  assert.equal(seen[0].round, 1);
  assert.deepEqual(
    { p: seen[0].promptTokens, c: seen[0].completionTokens, k: seen[0].cachedTokens },
    { p: 100, c: 5, k: 80 }
  );
  assert.equal(seen[1].round, 2);
  assert.equal(seen[1].promptTokens, 200);

  // 端点不返回 usage（plan 不带 usage）→ 回调零次，主流程逐字不变
  streamCalls = []; // 计数从头开始（streamPlan 按 streamCalls.length 取下标）
  streamPlan = [{ text: 'ok' }];
  const seen2 = [];
  const text2 = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    onUsage: entry => seen2.push(entry),
  });
  assert.equal(text2, 'ok');
  assert.equal(seen2.length, 0, '没有 usage 就没有回调');
});

test('E2 toolCallSignature：参数稳定化（键序无关）+ 字符串/对象兼容', () => {
  const { toolCallSignature } = loadLoop();
  const a = toolCallSignature({ name: 'read', arguments: '{"b":2,"a":1}' });
  const b = toolCallSignature({ name: 'read', arguments: { a: 1, b: 2 } });
  assert.equal(a, b, '键序不同、载体不同（JSON 字符串 vs 对象）→ 同一签名');
  assert.notEqual(a, toolCallSignature({ name: 'read', arguments: { a: 1, b: 3 } }), '参数不同 → 不同签名');
  assert.notEqual(a, toolCallSignature({ name: 'write', arguments: { a: 1, b: 2 } }), '工具名不同 → 不同签名');
  assert.equal(typeof toolCallSignature(null), 'string', '坏输入不抛错');
  // 嵌套结构同样稳定化
  assert.equal(
    toolCallSignature({ name: 'x', arguments: { o: { b: 1, a: 2 } } }),
    toolCallSignature({ name: 'x', arguments: { o: { a: 2, b: 1 } } })
  );
});

test('E2 重复调用 nudge：上一轮同签名才注入（轮末一条、不刷屏）', async () => {
  const call = args => ({ id: 'c', name: 'read_file', arguments: args });
  streamPlan = [
    { text: 'r1', toolCalls: [call('{"path":"a.js"}')] },
    { text: 'r2', toolCalls: [call('{"path":"a.js"}')] }, // 与上一轮同签名 → 命中
    { text: 'r3', toolCalls: [call('{"path":"b.js"}')] }, // 换了参数 → 不再命中
    { text: '完成' },
  ];
  const { runAgentTurn, REPEAT_CALL_NUDGE } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read' });
  assert.equal(text, 'r1r2r3完成');
  const has = index => streamCalls[index].messages
    .some(item => item.role === 'system' && item.content === REPEAT_CALL_NUDGE);
  assert.equal(has(0), false, '首轮无历史可重复');
  assert.equal(has(1), false, '第 2 轮检测发生在轮末，发起时还看不到');
  assert.equal(has(2), true, '第 3 轮请求已带 nudge（上一轮命中重复）');
  const count = streamCalls[3].messages
    .filter(item => item.role === 'system' && item.content === REPEAT_CALL_NUDGE).length;
  assert.equal(count, 1, 'nudge 只注入一条（换参数后不追加）');
});

test('E1 usage 回调抛错不拖垮主循环（与 onToken 同款隔离）', async () => {
  streamPlan = [{ text: 'ok', usage: { promptTokens: 10, completionTokens: 1, cachedTokens: 0 } }];
  const { runAgentTurn } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    onUsage: () => { throw new Error('宿主回调炸了'); },
  });
  assert.equal(text, 'ok', '回调异常必须被吞掉');
});

test('工具失败以 ok:false + error 上报并回喂错误内容', async () => {
  runHandler = () => ({ content: '权限不足', isError: true });
  streamPlan = [
    { text: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: '知道了' },
  ];
  const { runAgentTurn } = loadLoop();
  const toolEvents = [];
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    onToolEvent: event => toolEvents.push(event),
  });
  assert.equal(text, '知道了');
  assert.deepEqual(toolEvents[1], { phase: 'end', name: 'read_file', round: 1, ok: false, error: '权限不足' });
  const toolMsg = streamCalls[1].messages.find(item => item.role === 'tool');
  assert.equal(toolMsg.content, '权限不足');
});

test('UI 回调抛错不打断循环', async () => {
  streamPlan = [
    { text: 'a', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: 'b' },
  ];
  const { runAgentTurn } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    onToken: () => { throw new Error('UI 崩了'); },
    onReasoning: () => { throw new Error('UI 崩了'); },
    onToolEvent: () => { throw new Error('UI 崩了'); },
  });
  assert.equal(text, 'ab');
});

test('signal 已中止时立即抛 AbortError，不发请求', async () => {
  const controller = new AbortController();
  controller.abort();
  const { runAgentTurn } = loadLoop();
  await assert.rejects(
    runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read', signal: controller.signal }),
    error => error && error.name === 'AbortError',
  );
  assert.equal(streamCalls.length, 0);
});

test('requestOptions 夹带的 tools/toolChoice 被剥离，其余透传', async () => {
  streamPlan = [{ text: 'ok' }];
  const { runAgentTurn } = loadLoop();
  await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    requestOptions: { expectedConfigId: 'cfg-1', tools: [{ bogus: true }], toolChoice: 'none' },
  });
  assert.equal(streamCalls[0].options.expectedConfigId, 'cfg-1');
  assert.deepEqual(streamCalls[0].options.tools, fakeTools);
  assert.equal(streamCalls[0].options.toolChoice, 'auto');
});

test('A3 二期 parseToolArgs：对象 / JSON 字符串 / 坏输入三态', () => {
  const { parseToolArgs } = loadLoop();
  assert.deepEqual(parseToolArgs({ arguments: { a: 1 } }), { a: 1 }, '对象原样返回');
  assert.deepEqual(
    parseToolArgs({ arguments: '{"plan":[{"step":"x"}]}' }),
    { plan: [{ step: 'x' }] },
    'JSON 字符串解析'
  );
  assert.equal(parseToolArgs({ arguments: '半截{' }), null, '坏 JSON → null（订阅方按无参数处理）');
  assert.equal(parseToolArgs({ arguments: '' }), null);
  assert.equal(parseToolArgs({}), null);
  assert.equal(parseToolArgs(null), null);
});

test('I1 Steering：补充指令在下一轮请求前注入（不打断当前工具链）+ 队列取空', async () => {
  const { createSteeringQueue } = await import('../src/agent/steering.js');
  const toolCall = id => ({ id, name: 'read_file', arguments: '{}' });
  streamPlan = [
    // 第 1 轮进行中：用户发送补充指令（模拟）
    { text: 'r1', toolCalls: [toolCall('c1')], onRound: () => { steering.push('先别改 UI，优先修数据层'); } },
    { text: 'r2', toolCalls: [toolCall('c2')] },
    { text: '完成' },
  ];
  const steering = createSteeringQueue();
  const { runAgentTurn } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read', steering });
  assert.equal(text, 'r1r2完成');
  const injected = (index) => streamCalls[index].messages
    .filter(item => item.role === 'system' && String(item.content).includes('用户中途补充'));
  assert.equal(injected(0).length, 0, '第 1 轮请求前队列为空（指令还没发）');
  assert.equal(injected(1).length, 1, '第 2 轮请求前已注入（下一轮生效——不打断第 1 轮的工具链）');
  assert.match(injected(1)[0].content, /先别改 UI/);
  assert.equal(injected(2).length, 1, '注入即取空：第 3 轮只是继承历史里的那一条，不重复注入');
  assert.equal(steering.size, 0);

  // 不注入 steering（旧行为）逐字不变
  streamCalls = [];
  streamPlan = [{ text: 'ok' }];
  const plain = await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read' });
  assert.equal(plain, 'ok');
  assert.equal(streamCalls[0].messages.some(item => String(item.content || '').includes('用户中途补充')), false);
});

test('I1 Steering 与轮次预算：新目标重置收束预警（允许再提醒一次）', async () => {
  const { createSteeringQueue } = await import('../src/agent/steering.js');
  const toolCall = id => ({ id, name: 'read_file', arguments: '{}' });
  const steering = createSteeringQueue();
  streamPlan = [
    { text: 'r1', toolCalls: [toolCall('c1')] },
    // 第 2 轮末（maxRounds=4 → 窗口起点）已有 warning；第 3 轮前注入新目标
    { text: 'r2', toolCalls: [toolCall('c2')], onRound: () => { steering.push('换个思路'); } },
    { text: 'r3', toolCalls: [toolCall('c3')] },
    { text: 'final' },
  ];
  const { runAgentTurn, ROUND_BUDGET_WARNING } = loadLoop();
  await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read', maxRounds: 4, steering });
  const warningCount = (index) => streamCalls[index].messages
    .filter(item => item.role === 'system' && item.content === ROUND_BUDGET_WARNING).length;
  assert.equal(warningCount(2), 1, '第 3 轮请求时已有一条预警');
  assert.equal(warningCount(3), 2, 'steering 注入重置标记 → 第 4 轮再提醒一次（新目标需重新收束）');
  const steerAt = streamCalls[3].messages.findIndex(item => String(item.content).includes('用户中途补充'));
  const warnIndexes = streamCalls[3].messages
    .map((item, i) => (item.role === 'system' && item.content === ROUND_BUDGET_WARNING ? i : -1))
    .filter(i => i >= 0);
  assert.ok(steerAt >= 0 && warnIndexes.some(i => i > steerAt), '顺序：先看到补充指令，再看到收束提醒');
});

test('P1：每轮请求前按预算清除旧工具结果（落盘 + 占位，配对不变）', async () => {
  fakeTools = [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }];
  runHandler = () => ({ content: 'X'.repeat(500), isError: false });
  streamPlan = [
    { text: 'r1', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: 'r2', toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{}' }] },
    { text: 'r3', toolCalls: [{ id: 'c3', name: 'read_file', arguments: '{}' }] },
    { text: 'r4', toolCalls: [{ id: 'c4', name: 'read_file', arguments: '{}' }] },
    { text: 'r5', toolCalls: [{ id: 'c5', name: 'read_file', arguments: '{}' }] },
    { text: 'done' },
  ];
  const persisted = [];
  const { runAgentTurn } = loadLoop();
  const text = await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    contextBudgetBytes: 200,
    persistToolResult: async (content, meta) => {
      persisted.push({ length: String(content).length, meta });
      return { path: `.task_outputs/${meta.toolCallId}` };
    },
  });
  assert.equal(text, 'r1r2r3r4r5done');
  assert.ok(persisted.length >= 1, '超预算时至少清了一条');
  // 第 5 轮请求（index 4）时 c1 已被占位（最近 3 条 c2/c3/c4 受保护，c1 已消费且超门槛）
  const round5 = streamCalls[4].messages;
  const c1 = round5.find(item => item.role === 'tool' && item.tool_call_id === 'c1');
  assert.match(String(c1.content), /已存至/, 'c1 内容被占位替换');
  assert.match(String(c1.content), /c1/, '占位里带回落路径');
  // 配对完整：tool 消息一条不少（只改 content，不拆散 tool_use↔tool_result）
  assert.deepEqual(
    round5.filter(item => item.role === 'tool').map(item => item.tool_call_id),
    ['c1', 'c2', 'c3', 'c4'],
  );
});

test('P1：无 persist 钩子时不清除（绝不写假指针）', async () => {
  fakeTools = [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }];
  runHandler = () => ({ content: 'X'.repeat(500), isError: false });
  streamPlan = [
    { text: 'r1', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: 'r2', toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{}' }] },
    { text: 'r3', toolCalls: [{ id: 'c3', name: 'read_file', arguments: '{}' }] },
    { text: 'r4', toolCalls: [{ id: 'c4', name: 'read_file', arguments: '{}' }] },
    { text: 'r5', toolCalls: [{ id: 'c5', name: 'read_file', arguments: '{}' }] },
    { text: 'done' },
  ];
  const { runAgentTurn } = loadLoop();
  await runAgentTurn([{ role: 'user', content: 'hi' }], { mode: 'read', contextBudgetBytes: 200 });
  const round5 = streamCalls[4].messages;
  const c1 = round5.find(item => item.role === 'tool' && item.tool_call_id === 'c1');
  assert.equal(c1.content, 'X'.repeat(500), '无 persist 钩子 → 原文保留');
});

test('P5：onTranscript 回抛本轮追加的 agent 消息（含 tool）', async () => {
  streamPlan = [
    { text: 'r1', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { text: 'done' },
  ];
  const { runAgentTurn } = loadLoop();
  let transcript = null;
  await runAgentTurn([{ role: 'user', content: 'hi' }], {
    mode: 'read',
    onTranscript: msgs => { transcript = msgs; },
  });
  assert.ok(Array.isArray(transcript), 'onTranscript 被调用');
  assert.equal(transcript.length, 3);
  assert.equal(transcript[0].role, 'assistant');
  assert.ok(Array.isArray(transcript[0].tool_calls) && transcript[0].tool_calls[0].id === 'c1');
  assert.equal(transcript[1].role, 'tool');
  assert.equal(transcript[1].tool_call_id, 'c1');
  assert.equal(transcript[2].role, 'assistant');
  assert.equal(transcript[2].content, 'done');
});