import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/api.js');
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
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './storage') {
    return {
      getActiveApiConfig: async () => activeConfig,
      getActiveModel: config => config.activeModel,
      getSamplingSettings: async () => ({}),
      getThinkingSettings: async () => ({ enabled: false }),
    };
  }
  if (request === './secrets') {
    return { registerSecretValues: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadApi() {
  const filename = path.resolve('src/api.test-runtime.cjs');
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