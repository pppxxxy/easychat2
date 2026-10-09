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
    for (const chunk of plan.chunks || []) {
      if (typeof options.onChunk === 'function') options.onChunk(chunk);
    }
    return {
      text: typeof plan.text === 'string' ? plan.text : '',
      reasoning: plan.reasoning || '',
      toolCalls: plan.toolCalls || [],
      finishReason: plan.finishReason || null,
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
  assert.deepEqual(toolEvents, [
    { phase: 'start', name: 'read_file', round: 1 },
    { phase: 'end', name: 'read_file', round: 1, ok: true },
  ]);
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