import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/network/api.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

let activeConfig = {
  id: 'cfg-1',
  baseUrl: 'https://example.test/v1',
  activeModel: 'model-a',
  apiKey: 'key-12345678',
  authHeader: 'Authorization',
  authScheme: 'Bearer ',
};
const originalLoad = Module._load;
const recordedDiagnostics = [];
Module._load = function patchedLoad(request, parent, isMain) {
  // 按 basename 匹配，兼容源码搬迁后 `./x.js` → `../x.js` 的相对路径变化。
  const base = String(request).split('/').pop();
  // 快赢1 后 api.js 直达 storage/apiConfigs.js 与 storage/settings.js（原经 storage.js
  // 门面），两个基名映射到同一份 mock（已含 getSamplingSettings/getThinkingSettings）。
  if (base === 'storage.js' || base === 'apiConfigs.js' || base === 'settings.js') {
    return {
      getActiveApiConfig: async () => activeConfig,
      getActiveModel: config => config.activeModel,
      // 能力按模型解析（与 storage/apiConfigs.capabilitiesForModel 同构的桩；
      // 真实现的迁移/归一覆盖在 apiConfig.test.mjs）。
      capabilitiesForModel: (config, model) => {
        const entry = (config && config.modelCapabilities && config.modelCapabilities[String(model || '')]) || {};
        return {
          supportsThinking: entry.supportsThinking === true,
          thinkingField: String(entry.thinkingField || 'reasoning_effort'),
          thinkingFormat: entry.thinkingFormat || 'effort',
          supportsVision: entry.supportsVision === true,
          supportsVideo: entry.supportsVideo === true,
          supportsAudio: entry.supportsAudio === true,
        };
      },
      getSamplingSettings: async () => ({}),
      getThinkingSettings: async () => ({ enabled: false }),
    };
  }
  if (base === 'secrets.js') {
    return { registerSecretValues: () => {} };
  }
  if (base === 'diagnostics.js') {
    return {
      recordDiagnostic: (kind, error, context) => {
        recordedDiagnostics.push({ kind, message: String((error && error.message) || error), context });
      },
    };
  }
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

class FakeXHR {
  static last = null;
  static autoRespond = true;
  static responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  constructor() {
    this.aborted = false;
    this.responseText = '';
    FakeXHR.last = this;
  }
  open() {}
  setRequestHeader() {}
  send(body) {
    this.body = body;
    this.responseText = FakeXHR.responseText;
    if (FakeXHR.autoRespond) {
      queueMicrotask(() => {
        if (this.onprogress) this.onprogress();
        if (this.onload) this.onload();
      });
    }
  }
  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }
}

test('SSE 收到 DONE 后完成并中止 XHR', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { sendChatMessage } = loadApi();
    const result = await sendChatMessage([{ role: 'user', content: 'hi' }]);
    assert.equal(result, '你好');
    assert.equal(FakeXHR.last.aborted, true);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('非流式数组正文会合并文本 part', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = JSON.stringify({
    choices: [{ message: { content: [{ type: 'text', text: '你好' }, { type: 'text', text: '世界' }] } }],
  });
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { sendChatMessage } = loadApi();
    const result = await sendChatMessage([{ role: 'user', content: 'hi' }], { stream: false });
    assert.equal(result, '你好世界');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  }
});

test('流式数组正文会合并文本 part', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":[{"type":"text","text":"你好"},{"type":"text","text":"世界"}]}}]}\n\ndata: [DONE]\n\n';
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { sendChatMessage } = loadApi();
    const result = await sendChatMessage([{ role: 'user', content: 'hi' }]);
    assert.equal(result, '你好世界');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  }
});

test('SSE 单个事件跨多个 data 行时按规范拼接后再解析', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  // 同一事件内 JSON 被拆到两行 data:（在 token 之间换行，JSON 视换行为空白），
  // 按规范用 \n 拼接后才能解析出完整增量。
  FakeXHR.responseText = 'data: {"choices":[{"delta":\n'
    + 'data: {"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { sendChatMessage } = loadApi();
    const result = await sendChatMessage([{ role: 'user', content: 'hi' }]);
    assert.equal(result, '你好');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  }
});

test('SSE 事件间无空行时逐条按完整事件解析', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  // 部分服务端不补空行，直接连发完整 data:：第一条能独立解析，应先派发再累积下一条。
  FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你"}}]}\n'
    + 'data: {"choices":[{"delta":{"content":"好"}}]}\n'
    + 'data: [DONE]\n';
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { sendChatMessage } = loadApi();
    const result = await sendChatMessage([{ role: 'user', content: 'hi' }]);
    assert.equal(result, '你好');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  }
});

test('请求结束前配置指纹变化时丢弃旧来源回复', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = false;
  globalThis.XMLHttpRequest = FakeXHR;
  const previous = activeConfig;
  try {
    const { getConfigFingerprint, sendChatMessage } = loadApi();
    const expected = getConfigFingerprint(previous);
    const pending = sendChatMessage(
      [{ role: 'user', content: 'hi' }],
      { expectedConfigId: previous.id, expectedConfigFingerprint: expected },
    );
    await new Promise(resolve => setImmediate(resolve));
    activeConfig = { ...previous, activeModel: 'model-b' };
    FakeXHR.last.onprogress();
    FakeXHR.last.onload();
    await assert.rejects(pending, /模型来源已切换/);
  } finally {
    activeConfig = previous;
    globalThis.XMLHttpRequest = originalXHR;
  }
});
test('主动中止不会把「请求已中断」误记进诊断日志', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = false;
  globalThis.XMLHttpRequest = FakeXHR;
  recordedDiagnostics.length = 0;
  try {
    const { sendChatMessage } = loadApi();
    const controller = new AbortController();
    const pending = sendChatMessage([{ role: 'user', content: 'hi' }], { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    // 用户停止：先触发 signal，再让 XHR 的 abort 事件到达（真实 RN 会两者都触发）。
    controller.abort();
    FakeXHR.last.onabort();
    await assert.rejects(pending, error => error && error.name === 'AbortError');
    assert.equal(
      recordedDiagnostics.some(item => item.message.includes('请求已中断')),
      false,
      '主动中止不应记录幽灵诊断'
    );
    assert.equal(recordedDiagnostics.length, 0);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  }
});

test('真正的接口失败仍会记录一次诊断', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = false;
  globalThis.XMLHttpRequest = FakeXHR;
  recordedDiagnostics.length = 0;
  try {
    const { sendChatMessage } = loadApi();
    const pending = sendChatMessage([{ role: 'user', content: 'hi' }]);
    await new Promise(resolve => setImmediate(resolve));
    FakeXHR.last.onerror();
    await assert.rejects(pending, /网络请求失败/);
    assert.equal(recordedDiagnostics.length, 1);
    assert.equal(recordedDiagnostics[0].context, '聊天接口请求失败');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  }
});

const TOOL_SSE_DEFAULT = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
const buildSse = events => `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

test('streamChatCompletion 累积流式 tool_calls 并按 index 归并 arguments 分片', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = buildSse([
    { choices: [{ delta: { content: '让我读一下。' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion } = loadApi();
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], {
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    });
    assert.equal(result.text, '让我读一下。');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(result.toolCalls[0], { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' });
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = TOOL_SSE_DEFAULT;
  }
});

test('streamChatCompletion 空文本 + tool_calls 返回原始空串而非占位文本', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = buildSse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'noop', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion, EMPTY_REPLY_TEXT } = loadApi();
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], {
      tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
    });
    assert.equal(result.text, '');
    assert.notEqual(result.text, EMPTY_REPLY_TEXT);
    assert.equal(result.toolCalls[0].name, 'noop');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = TOOL_SSE_DEFAULT;
  }
});

test('streamChatCompletion 非流式正文解析 message.tool_calls 与 finish_reason', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = JSON.stringify({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  });
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion } = loadApi();
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], { stream: false });
    assert.equal(result.text, '');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [{ id: 'call_9', name: 'search', arguments: '{"q":"x"}' }]);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = TOOL_SSE_DEFAULT;
  }
});

test('sendChatMessage 薄包装在空文本无工具时仍返回 EMPTY_REPLY_TEXT', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { sendChatMessage, EMPTY_REPLY_TEXT } = loadApi();
    const result = await sendChatMessage([{ role: 'user', content: 'hi' }]);
    assert.equal(result, EMPTY_REPLY_TEXT);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = TOOL_SSE_DEFAULT;
  }
});

test('streamChatCompletion 请求体在提供 tools 时携带 tools 与 tool_choice', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = TOOL_SSE_DEFAULT;
  let sentBody = null;
  const originalSend = FakeXHR.prototype.send;
  FakeXHR.prototype.send = function patchedSend(body) {
    sentBody = body;
    return originalSend.call(this, body);
  };
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion } = loadApi();
    const tools = [{ type: 'function', function: { name: 'noop', parameters: {} } }];
    await streamChatCompletion([{ role: 'user', content: 'hi' }], { tools, toolChoice: 'auto' });
    const parsed = JSON.parse(sentBody);
    assert.deepEqual(parsed.tools, tools);
    assert.equal(parsed.tool_choice, 'auto');
  } finally {
    FakeXHR.prototype.send = originalSend;
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('streamChatCompletion 省略 tools 时不携带 tools 字段', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = TOOL_SSE_DEFAULT;
  let sentBody = null;
  const originalSend = FakeXHR.prototype.send;
  FakeXHR.prototype.send = function patchedSend(body) {
    sentBody = body;
    return originalSend.call(this, body);
  };
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion } = loadApi();
    await streamChatCompletion([{ role: 'user', content: 'hi' }]);
    const parsed = JSON.parse(sentBody);
    assert.equal('tools' in parsed, false);
    assert.equal('tool_choice' in parsed, false);
  } finally {
    FakeXHR.prototype.send = originalSend;
    globalThis.XMLHttpRequest = originalXHR;
  }
});

// 用一个能记录 URL 与请求头的 FakeXHR 跑协议集成测试。
function withRecordingXhr(run, responseText) {
  return async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    FakeXHR.autoRespond = true;
    FakeXHR.responseText = responseText;
    const record = { url: '', headers: {}, body: null };
    const originalOpen = FakeXHR.prototype.open;
    const originalSetHeader = FakeXHR.prototype.setRequestHeader;
    const originalSend = FakeXHR.prototype.send;
    FakeXHR.prototype.open = function patchedOpen(method, url) { record.url = url; record.method = method; };
    FakeXHR.prototype.setRequestHeader = function patchedHeader(name, value) { record.headers[name] = value; };
    FakeXHR.prototype.send = function patchedSend(body) { record.body = body; return originalSend.call(this, body); };
    globalThis.XMLHttpRequest = FakeXHR;
    try {
      return await run(record);
    } finally {
      FakeXHR.prototype.open = originalOpen;
      FakeXHR.prototype.setRequestHeader = originalSetHeader;
      FakeXHR.prototype.send = originalSend;
      globalThis.XMLHttpRequest = originalXHR;
      FakeXHR.responseText = TOOL_SSE_DEFAULT;
    }
  };
}

test('Anthropic 协议：URL / 鉴权头 / system 顶层 / SSE 文本与思考解析', withRecordingXhr(async record => {
  const previous = activeConfig;
  activeConfig = { ...previous, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', activeModel: 'claude-x', apiKey: 'sk-ant-1', authHeader: 'x-api-key', authScheme: '' };
  try {
    const { streamChatCompletion } = loadApi();
    const events = [
      { type: 'message_start', message: { id: 'm' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    FakeXHR.responseText = `${events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
    const result = await streamChatCompletion([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'hi' },
    ], { onChunk: () => {} });
    assert.equal(record.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(record.headers['x-api-key'], 'sk-ant-1');
    assert.equal(record.headers.Authorization, undefined);
    assert.equal(record.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(record.body);
    // P1-1 起默认打断点：system 是块数组（文本不变，多一个 cache_control）。
    assert.deepEqual(body.system, [{ type: 'text', text: '你是助手', cache_control: { type: 'ephemeral' } }]);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.stream, true);
    assert.equal(result.text, '你好');
    assert.equal(result.reasoning, '想');
    assert.equal(result.finishReason, 'stop');
  } finally {
    activeConfig = previous;
  }
}, TOOL_SSE_DEFAULT));

test('Anthropic 协议非流式：tool_use → toolCalls', withRecordingXhr(async () => {
  const previous = activeConfig;
  activeConfig = { ...previous, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', activeModel: 'claude-x' };
  try {
    const { streamChatCompletion } = loadApi();
    FakeXHR.responseText = JSON.stringify({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '让我看看' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
      ],
    });
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], { stream: false });
    assert.equal(result.text, '让我看看');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [{ id: 'tu_1', name: 'read_file', arguments: '{"path":"a.txt"}' }]);
  } finally {
    activeConfig = previous;
  }
}, TOOL_SSE_DEFAULT));

test('OpenAI Responses 协议：URL / reasoning / input 形态 / SSE 解析', withRecordingXhr(async record => {
  const previous = activeConfig;
  activeConfig = { ...previous, protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', activeModel: 'gpt-5', apiKey: 'sk-1' };
  try {
    const { streamChatCompletion } = loadApi();
    const events = [
      { type: 'response.output_item.added', item: { type: 'reasoning' }, output_index: 0 },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '推' },
      { type: 'response.output_text.delta', output_index: 1, delta: '你好' },
      { type: 'response.completed', response: { status: 'completed' } },
    ];
    FakeXHR.responseText = `${events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
    const result = await streamChatCompletion([
      { role: 'system', content: '系统' },
      { role: 'user', content: 'hi' },
    ], { onChunk: () => {} });
    assert.equal(record.url, 'https://api.openai.com/v1/responses');
    assert.equal(record.headers.Authorization, 'Bearer sk-1');
    const body = JSON.parse(record.body);
    assert.equal(body.instructions, '系统');
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(result.text, '你好');
    assert.equal(result.reasoning, '推');
    assert.equal(result.finishReason, 'stop');
  } finally {
    activeConfig = previous;
  }
}, TOOL_SSE_DEFAULT));

test('OpenAI Responses 协议非流式：output 数组解析', withRecordingXhr(async () => {
  const previous = activeConfig;
  activeConfig = { ...previous, protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', activeModel: 'gpt-5' };
  try {
    const { streamChatCompletion } = loadApi();
    FakeXHR.responseText = JSON.stringify({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ text: '想' }] },
        { type: 'message', content: [{ type: 'output_text', text: '答复' }] },
      ],
    });
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], { stream: false });
    assert.equal(result.text, '答复');
    assert.equal(result.reasoning, '想');
    assert.deepEqual(result.toolCalls, []);
  } finally {
    activeConfig = previous;
  }
}, TOOL_SSE_DEFAULT));

test('配置切换协议会改变指纹（旧来源回复被丢弃）', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = false;
  globalThis.XMLHttpRequest = FakeXHR;
  const previous = activeConfig;
  try {
    const { getConfigFingerprint } = loadApi();
    const before = getConfigFingerprint({ ...previous, protocol: 'openai' });
    const after = getConfigFingerprint({ ...previous, protocol: 'anthropic' });
    assert.notEqual(before, after);
  } finally {
    activeConfig = previous;
    globalThis.XMLHttpRequest = originalXHR;
  }
});

test('overrides 仅覆盖本次请求的 temperature 与 max_tokens', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { sendChatMessage } = loadApi();
    await sendChatMessage([{ role: 'user', content: 'hi' }], {
      stream: false,
      overrides: { temperature: 0.3, maxTokens: 8192 },
    });
    const withOverrides = JSON.parse(FakeXHR.last.body);
    assert.equal(withOverrides.temperature, 0.3);
    assert.equal(withOverrides.max_tokens, 8192);

    // 不传 overrides 时沿用全局采样（stub 为空），不出现制卡参数
    await sendChatMessage([{ role: 'user', content: 'hi' }], { stream: false });
    const withoutOverrides = JSON.parse(FakeXHR.last.body);
    assert.equal(withoutOverrides.temperature, undefined);
    assert.equal(withoutOverrides.max_tokens, undefined);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  }
});

test('trimOnlineMessages（F4）：未声明窗口不裁剪，声明后丢弃最旧非系统消息', () => {
  const { trimOnlineMessages } = loadApi();
  const system = { role: 'system', content: '人设' };
  const history = [];
  for (let i = 0; i < 40; i += 1) history.push({ role: 'user', content: `第${i}条`.repeat(50) });
  const messages = [system, ...history];

  // 未声明窗口（0）：原样返回，绝不裁剪
  assert.equal(trimOnlineMessages(messages, { contextWindow: 0 }).length, messages.length);
  // 显式关闭：即便声明了也不裁剪
  assert.equal(trimOnlineMessages(messages, { contextWindow: 2000, enabled: false }).length, messages.length);

  // 声明小窗口：触发裁剪，且系统提示保留
  const trimmed = trimOnlineMessages(messages, { contextWindow: 2000, reserveOutputTokens: 512 });
  assert.ok(trimmed.length < messages.length, '应丢弃最旧的非系统消息');
  assert.ok(trimmed.some(item => item.role === 'system' && item.content === '人设'), '系统提示恒保留');
  assert.equal(trimmed[trimmed.length - 1].content, history[history.length - 1].content, '保留最新消息');
});

// —— E1：usage 宽容解析（缓存经济学的地基——没有它就没有命中观测）——

test('E1 extractUsage：三方言归一（OpenAI/DeepSeek/Anthropic）+ 坏输入 null', () => {
  const { extractUsage } = loadApi();
  // OpenAI 系：prompt_tokens_details.cached_tokens
  assert.deepEqual(
    extractUsage({
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
    }),
    { promptTokens: 1000, completionTokens: 50, cachedTokens: 800 }
  );
  // DeepSeek：prompt_cache_hit_tokens（prompt_tokens 已含命中部分，直接同口径）
  assert.deepEqual(
    extractUsage({ usage: { prompt_tokens: 900, completion_tokens: 40, prompt_cache_hit_tokens: 700 } }),
    { promptTokens: 900, completionTokens: 40, cachedTokens: 700 }
  );
  // Anthropic：input_tokens **不含**缓存部分 → 并入 prompt，统一成 prompt ⊇ cached
  assert.deepEqual(
    extractUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 300,
      },
    }),
    { promptTokens: 1000, completionTokens: 20, cachedTokens: 600 }
  );
  // Anthropic 流式：usage 在 message.usage 位置（与 OpenAI 顶层 usage 不同）
  assert.equal(
    extractUsage({ message: { usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } } }).cachedTokens,
    5
  );
  // 坏输入 / 无 usage → null（解析不出绝不抛错、绝不影响主流程）
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage('nope'), null);
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage({ usage: {} }), null, '空 usage 视为没有');
});

test('E1 流式 usage 端到端：最后一个 chunk 的 usage 被带进返回值', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  const originalText = FakeXHR.responseText;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    '',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":120,"completion_tokens":8,"prompt_cache_hit_tokens":100}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion } = loadApi();
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }]);
    assert.equal(result.text, '你好');
    assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 8, cachedTokens: 100 });
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = originalText;
  }
});

test('E1 非流式 usage：body 里的 usage 同样被带回（同一口径）', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  const originalText = FakeXHR.responseText;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = JSON.stringify({
    choices: [{ message: { content: '你好' } }],
    usage: { prompt_tokens: 60, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 50 } },
  });
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion } = loadApi();
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], { stream: false });
    assert.equal(result.text, '你好');
    assert.deepEqual(result.usage, { promptTokens: 60, completionTokens: 4, cachedTokens: 50 });
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = originalText;
  }
});

test('E1 无 usage 的端点：usage 为 null，主流程零影响', async () => {
  const originalXHR = globalThis.XMLHttpRequest;
  const originalText = FakeXHR.responseText;
  FakeXHR.autoRespond = true;
  FakeXHR.responseText = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const { streamChatCompletion } = loadApi();
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }]);
    assert.equal(result.text, '你好');
    assert.equal(result.usage, null, '端点不返回 usage → null（调用方必须容忍）');
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    FakeXHR.responseText = originalText;
  }
});
