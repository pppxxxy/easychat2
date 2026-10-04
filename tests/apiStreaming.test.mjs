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
  if (base === 'storage.js') {
    return {
      getActiveApiConfig: async () => activeConfig,
      getActiveModel: config => config.activeModel,
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
  send() {
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
