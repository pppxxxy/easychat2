// 稳健性小修包 P1：工具调用请求构造的回归用例（防御性）。
//
// 背景：竞品 v2.10.0 实锤「DeepSeek 等部分 API 在工具调用期间遭遇 HTTP 400」，本仓无
// 复现记录，故先做回归加固。加固过程中**发现并修掉一个真实缺陷**（不是臆造的厂商适配）：
// 工具调用中途被中止，agent 循环会留下**没有 tool 结果的 assistant(tool_calls)**，
// 而配对修复此前只在「真的发生上下文裁剪」时才跑，于是默认配置（contextWindow=0）下
// 原样上链 → 违反协议通用配对规则 → 400。本案的用例即钉住这条。
//
// 加载**真实现**（apiProtocols/body + messages + tools、localModel/localContext、
// network/api 的 trimOnlineMessages），只桩掉原生与存储边界。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { buildRequestBody } from '../src/apiProtocols.js';
import { toOpenAiMessages } from '../src/apiProtocols/messages.js';
import { repairToolPairing } from '../src/localModel/localContext.js';
// 判据本体在 agent/resultClearing.js（localContext 内部复用它，但不转出）。
import { findOrphanToolMessages } from '../src/agent/resultClearing.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/network/api.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const base = String(request).split('/').pop();
  if (base === 'storage.js' || base === 'apiConfigs.js' || base === 'settings.js') {
    return {
      getActiveApiConfig: async () => ({}),
      getActiveModel: () => 'model-a',
      capabilitiesForModel: () => ({}),
      getSamplingSettings: async () => ({}),
      getThinkingSettings: async () => ({ enabled: false }),
    };
  }
  if (base === 'secrets.js') return { registerSecretValues: () => {} };
  if (base === 'diagnostics.js') return { recordDiagnostic: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

function loadApi() {
  const filename = path.resolve('src/network/api.js');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

const TOOL_DEFS = [
  { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } },
];

// 一轮「带工具调用历史」的对话：assistant 请求调用 → tool 回结果 → assistant 收尾。
function toolHistory() {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '帮我读文件' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_abc',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_abc', content: 'file body' },
    { role: 'assistant', content: '读到了' },
  ];
}

// ---- 已知 400 坑型：(a) 空 tools 数组 -----------------------------------

test('P1：有工具时请求体带 tools 与 tool_choice', () => {
  const body = buildRequestBody({
    protocol: 'openai',
    model: 'm',
    messages: toolHistory(),
    stream: true,
    tools: TOOL_DEFS,
    toolChoice: 'auto',
  });
  assert.ok(Array.isArray(body.tools), 'tools 必须是数组');
  assert.equal(body.tools.length, 1);
  assert.equal(body.tool_choice, 'auto');
});

test('P1 已知 400 坑型：tools 为空/缺省时**不得**发送 tools 与 tool_choice 字段', () => {
  for (const tools of [undefined, null, [], 'not-an-array', 0]) {
    const body = buildRequestBody({
      protocol: 'openai',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      tools,
      toolChoice: 'auto',
    });
    assert.equal('tools' in body, false, `tools=${JSON.stringify(tools)} 时不得出现 tools 键（空数组是已知 400 坑型）`);
    assert.equal('tool_choice' in body, false, 'tool_choice 不能在没有 tools 时单独出现');
  }
});

// ---- 已知 400 坑型：(b) tool 消息的 content 编码 -------------------------

test('P1：tool 消息 content 为 null / 空串时均保留键，不被丢弃或改写', () => {
  const converted = toOpenAiMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: null },
    { role: 'tool', tool_call_id: 'c2', content: '' },
  ]);
  const tools = converted.filter(item => item.role === 'tool');
  assert.equal(tools.length, 2, '两条 tool 消息都必须留下（丢掉会让配对不完整）');
  assert.equal(tools[0].tool_call_id, 'c1');
  assert.equal(tools[0].content, null, 'null 原样保留，不擅自改成空串');
  assert.equal(tools[1].content, '', '空串原样保留');
});

// ---- 已知 400 坑型：(c) tool_calls 与 id 配对完整 -----------------------

test('P1：带 tool_calls 历史的请求体里，tool 消息与 assistant.tool_calls 配对完整、id 不丢', () => {
  const body = buildRequestBody({
    protocol: 'openai',
    model: 'm',
    messages: toolHistory(),
    stream: true,
    tools: TOOL_DEFS,
  });
  const assistant = body.messages.find(item => Array.isArray(item.tool_calls));
  const tool = body.messages.find(item => item.role === 'tool');
  assert.ok(assistant, 'assistant(tool_calls) 必须在请求体里');
  assert.ok(tool, 'tool 结果必须在请求体里');
  assert.equal(assistant.tool_calls[0].id, 'call_abc', 'id 不得被改写');
  assert.equal(tool.tool_call_id, 'call_abc', 'tool_call_id 必须与 assistant 的 id 对上');
  assert.equal(
    tool.tool_call_id,
    assistant.tool_calls[0].id,
    '配对关系必须完整 —— 这是协议通用规则，破了就是 400',
  );
  // 参数与名字也要原样
  assert.equal(assistant.tool_calls[0].function.name, 'read_file');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"path":"a.txt"}');
});

test('P1：真实缺陷回归 —— 中止留下孤立的 assistant(tool_calls) 必须被修掉', () => {
  // 这就是中止在「工具执行中途」时落盘的历史：assistant 已入栈，tool 结果永远没到。
  const aborted = [
    { role: 'user', content: '读文件' },
    {
      role: 'assistant',
      content: 'r1',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
  ];
  assert.ok(findOrphanToolMessages(aborted).length > 0, '前置：这段历史确实含孤儿 tool_calls');

  const repaired = repairToolPairing(aborted);
  assert.equal(
    findOrphanToolMessages(repaired).length,
    0,
    '修完之后不得再有孤儿 —— 否则下一轮原样上链就是 400',
  );
});

test('P1：默认配置（未声明 contextWindow=0）也必须修配对，不能原样透传', () => {
  const { trimOnlineMessages } = loadApi();
  const aborted = [
    { role: 'user', content: '读文件' },
    {
      role: 'assistant',
      content: 'r1',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
  ];
  // 默认（不传 contextWindow）与显式 0 都是「未声明窗口」的常见形态：
  // 修复前这两条都会原样返回，孤儿 tool_calls 直接上网。
  for (const options of [{}, { contextWindow: 0 }, { contextWindow: 0, enabled: true }]) {
    const sent = trimOnlineMessages(aborted, options);
    assert.equal(
      findOrphanToolMessages(sent).length,
      0,
      `options=${JSON.stringify(options)} 下仍上链了孤儿 tool_calls（会让服务商回 400）`,
    );
  }
});

test('P1：声明了窗口但内容没超预算时（removedCount=0）也必须修配对', () => {
  const { trimOnlineMessages } = loadApi();
  const aborted = [{ role: 'user', content: 'x' }, {
    role: 'assistant',
    content: 'r',
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'f', arguments: '{}' } }],
  }];
  const sent = trimOnlineMessages(aborted, { contextWindow: 100000 });
  assert.ok(sent.length > 0, '短历史不该被裁空');
  assert.equal(findOrphanToolMessages(sent).length, 0, '没触发裁剪时也要修配对（否则默认模型全中）');
});

test('P1：正常配对的历史不得被修坏（修复必须是幂等的无损操作）', () => {
  const { trimOnlineMessages } = loadApi();
  const history = toolHistory();
  const sent = trimOnlineMessages(history, { contextWindow: 0 });
  assert.equal(sent.length, history.length, '配对完整时不得删任何消息');
  const assistant = sent.find(item => Array.isArray(item.tool_calls));
  const tool = sent.find(item => item.role === 'tool');
  assert.equal(assistant.tool_calls[0].id, 'call_abc');
  assert.equal(tool.tool_call_id, 'call_abc');
  assert.equal(sent[sent.length - 1].content, '读到了', '结尾回复不得丢');
});

// ---- 已知 400 坑型：(d) 流式 + 工具 + 中断后续发的组合轮次 ---------------

test('P1：流式 + 工具 + 中断后续发的组合轮次，请求体里配对依然完整', () => {
  const { trimOnlineMessages } = loadApi();
  // 第 1 轮：流式带工具；第 2 轮：中断留下孤立 tool_calls；第 3 轮：用户续发。
  const afterAbort = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'ok1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'ok1', content: 'body' },
    { role: 'assistant', content: '读到了' },
    { role: 'user', content: '再读一个' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'dangling', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  ];
  const streamed = trimOnlineMessages(afterAbort, { contextWindow: 0 });
  const body = buildRequestBody({
    protocol: 'openai',
    model: 'm',
    messages: streamed,
    stream: true,
    tools: TOOL_DEFS,
  });
  assert.equal(findOrphanToolMessages(body.messages).length, 0, '组合轮次上链前必须无孤儿');
  // 正常那一对必须原样保留（修复不能把好的也删了）
  const kept = body.messages.find(item => item.role === 'tool');
  assert.ok(kept, '正常配对的 tool 结果必须留下');
  assert.equal(kept.tool_call_id, 'ok1');
  assert.ok(body.messages.some(item => item.content === '再读一个'), '用户的续发消息必须留下');
});

test('P1：多协议下工具定义都能正确落到请求体（openai / anthropic / responses）', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const openai = buildRequestBody({ protocol: 'openai', model: 'm', messages, stream: true, tools: TOOL_DEFS });
  assert.equal(openai.tools[0].function.name, 'read_file');

  const anthropic = buildRequestBody({ protocol: 'anthropic', model: 'm', messages, stream: true, tools: TOOL_DEFS });
  assert.ok(Array.isArray(anthropic.tools) && anthropic.tools.length === 1, 'anthropic 的 tools 形态不同但必须存在');

  const responses = buildRequestBody({ protocol: 'openai-responses', model: 'm', messages, stream: true, tools: TOOL_DEFS });
  assert.ok(Array.isArray(responses.tools) && responses.tools.length === 1);

  // 三协议在「无工具」时都不得出现 tools 键
  for (const protocol of ['openai', 'anthropic', 'openai-responses']) {
    const bare = buildRequestBody({ protocol, model: 'm', messages, stream: true, tools: [] });
    assert.equal('tools' in bare, false, `${protocol}：空 tools 不得上链`);
  }
});

test('P1：孤儿判定为双向（tool 无 call 也算），修复后不留任一侧', () => {
  const danglingResult = [
    { role: 'user', content: 'q' },
    { role: 'tool', tool_call_id: 'ghost', content: 'x' },
  ];
  assert.ok(findOrphanToolMessages(danglingResult).length > 0, '前置：孤立的 tool 结果');
  assert.equal(findOrphanToolMessages(repairToolPairing(danglingResult)).length, 0);
});
