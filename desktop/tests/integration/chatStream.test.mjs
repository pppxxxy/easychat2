// 桌面聊天链路集成测试（无 Electron 窗口）：
//   src/network/api.js（共享层）
//     -> platform/xhr.js（渲染层 XHR 适配器）
//     -> electron/ipc/http.js（主进程流式代理，node:http/https）
//     -> 本地 SSE 服务器（本测试启动）
//
// 这是 S3 的前置验收：整条「发请求 / 收流」链路里最容易坏的一段（跨进程事件序、
// 跨包多字节解码、SSE 增量解析）全部走真实实现，不 mock 传输层。
//
// 存储依赖用与 tests/apiStreaming.test.mjs 相同的 Module._load 打桩（api.js 经
// storage/apiConfigs.js 取当前配置）；其余模块（协议、超时、i18n）都是纯逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createHttpProxy } from '../../electron/ipc/http.js';
import { createXHRFactory } from '../../src/platform/xhr.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sourcePath = path.join(REPO_ROOT, 'src', 'network', 'api.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

let activeConfig = null;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const base = String(request).split('/').pop();
  if (base === 'storage.js' || base === 'apiConfigs.js' || base === 'settings.js') {
    return {
      getActiveApiConfig: async () => activeConfig,
      getActiveModel: config => config.activeModel,
      capabilitiesForModel: () => ({
        supportsThinking: false,
        thinkingField: 'reasoning_effort',
        thinkingFormat: 'effort',
        supportsVision: false,
        supportsVideo: false,
        supportsAudio: false,
      }),
      getSamplingSettings: async () => ({}),
      getThinkingSettings: async () => ({ enabled: false }),
    };
  }
  if (base === 'secrets.js') return { registerSecretValues: () => {} };
  if (base === 'diagnostics.js') return { recordDiagnostic: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

function loadApi() {
  const filename = path.join(REPO_ROOT, 'src', 'network', 'api.js');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

// 一个最小的 OpenAI 兼容 SSE 服务器：故意把「你好世界」的 UTF-8 字节在第一个
// 字符中间切开（TCP 包边界），验证跨包多字节解码。
function startSseServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const payload = Buffer.from(
        'data: {"choices":[{"delta":{"content":"你好世界"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
        'utf8'
      );
      // 在第一个「你」的三字节中间断开：0xE4 | 0xBD A0。跨包解码错误会得到 U+FFFD。
      res.write(payload.subarray(0, 1));
      setTimeout(() => {
        res.write(payload.subarray(1, 26));
        setTimeout(() => {
          res.write(payload.subarray(26));
          res.end();
        }, 10);
      }, 10);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

// 把「XHR 适配器 <-> 主进程 http 服务」直接接线（与 preload 暴露的通道形状一致）。
function installDesktopXhr() {
  const subscribers = new Set();
  const proxy = createHttpProxy({
    sendEvent: payload => {
      for (const subscriber of [...subscribers]) subscriber(payload);
    },
  });
  const bridge = {
    http: {
      start: async payload => proxy.start(payload),
      abort: requestId => proxy.abort(requestId),
      onEvent(subscriber) {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      },
    },
  };
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = createXHRFactory(bridge);
  return () => {
    proxy.closeAll();
    globalThis.XMLHttpRequest = original;
  };
}

test('集成：SSE 流式回复经主进程代理完整到达（跨包多字节字符不破损）', async () => {
  const server = await startSseServer();
  const restoreXhr = installDesktopXhr();
  activeConfig = {
    id: 'cfg-desktop',
    baseUrl: server.url,
    activeModel: 'mock-model',
    apiKey: 'key-desktop-123',
    authHeader: 'Authorization',
    authScheme: 'Bearer ',
    protocol: 'openai',
  };
  try {
    const { streamChatCompletion } = loadApi();
    const deltas = [];
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], {
      onChunk: delta => deltas.push(delta),
    });

    assert.equal(result.text, '你好世界', '跨 TCP 包的多字节字符必须完整还原');
    assert.equal(deltas.join(''), '你好世界', '增量顺序与拼接结果一致');
    assert.equal(server.requests.length, 1, '恰好一次请求');
    assert.equal(server.requests[0].url, '/v1/chat/completions');
    assert.equal(server.requests[0].headers.authorization, 'Bearer key-desktop-123');
    assert.match(String(server.requests[0].body), /mock-model/);
    assert.match(String(server.requests[0].body), /"stream":true/);
  } finally {
    restoreXhr();
    await server.close();
    activeConfig = null;
  }
});

test('集成：请求中止后主进程代理停止读流，api.js 抛 abort 错误', async () => {
  // 服务器只发一个块就挂住：保证中止发生在流中途。
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
    // 不 end：等待客户端 abort。
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const restoreXhr = installDesktopXhr();
  activeConfig = {
    id: 'cfg-desktop-abort',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    activeModel: 'mock-model',
    apiKey: 'key-desktop-123',
    authHeader: 'Authorization',
    authScheme: 'Bearer ',
    protocol: 'openai',
  };
  try {
    const { streamChatCompletion } = loadApi();
    const controller = new AbortController();
    const pending = streamChatCompletion([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
      onChunk: () => controller.abort(),
    });
    await assert.rejects(pending, error => {
      const code = String((error && error.name) || (error && error.code) || '');
      const message = String((error && error.message) || '');
      return /abort/i.test(code) || /abort/i.test(message);
    });
  } finally {
    restoreXhr();
    await new Promise(resolve => server.close(resolve));
    activeConfig = null;
  }
});
