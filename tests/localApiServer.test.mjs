import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addLocalApiServerRequestListener,
  attachLocalApiServerInference,
  getLocalApiServerStatus,
  isLocalApiServerAvailable,
  parseLocalApiServerRequest,
  respondLocalApiServer,
  startLocalApiServer,
  stopLocalApiServer,
} from '../src/localModel/localApiServer.js';

test('parseLocalApiServerRequest：解析 JSON 字符串与对象', () => {
  const fromString = parseLocalApiServerRequest(JSON.stringify({
    requestId: 'r1',
    path: '/v1/chat/completions',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
  }));
  assert.equal(fromString.requestId, 'r1');
  assert.equal(fromString.path, '/v1/chat/completions');
  assert.equal(fromString.body.stream, true);
  assert.equal(fromString.body.messages[0].content, 'hi');

  const fromObject = parseLocalApiServerRequest({ requestId: 'r2', body: { messages: [] } });
  assert.equal(fromObject.requestId, 'r2');
  assert.deepEqual(fromObject.body.messages, []);
});

test('parseLocalApiServerRequest：非法输入返回 null', () => {
  assert.equal(parseLocalApiServerRequest('not-json'), null);
  assert.equal(parseLocalApiServerRequest(null), null);
  assert.equal(parseLocalApiServerRequest([]), null);
  assert.equal(parseLocalApiServerRequest({ body: {} }), null);
  assert.equal(parseLocalApiServerRequest({ requestId: '  ' }), null);
});

test('parseLocalApiServerRequest：body 非法时回退空对象', () => {
  const event = parseLocalApiServerRequest({ requestId: 'r3', body: 'not-json' });
  assert.deepEqual(event.body, {});
});

test('无原生模块时：不可用、启停与状态安全降级', async () => {
  assert.equal(isLocalApiServerAvailable(), false);
  await assert.rejects(() => startLocalApiServer({ port: 8081, apiKey: 'k' }), /仅 Android 原生构建可用/);
  assert.equal(await stopLocalApiServer(), true);
  const status = await getLocalApiServerStatus();
  assert.equal(status.running, false);
  assert.equal(status.host, '127.0.0.1');
  assert.equal(await respondLocalApiServer('r1', { text: 'x' }), false);
  const unsubscribe = addLocalApiServerRequestListener(() => {});
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(typeof attachLocalApiServerInference({ runInference: () => {} }), 'function');
  assert.equal(typeof attachLocalApiServerInference({}), 'function');
});

test('attachLocalApiServerInference：请求进推理并回写文本（可注入）', async () => {
  let handler = null;
  const replies = [];
  const calls = [];
  const detach = attachLocalApiServerInference({
    model: { id: 'qwen-local' },
    runInference: async (messages, model) => {
      calls.push({ messages, model });
      return '本地回复';
    },
    addListener: cb => {
      handler = cb;
      return () => {};
    },
    respond: async (requestId, response) => {
      replies.push({ requestId, response });
      return true;
    },
  });
  assert.equal(typeof detach, 'function');
  await handler({
    requestId: 'req-1',
    path: '/v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(replies[0], { requestId: 'req-1', response: { text: '本地回复', model: 'qwen-local' } });
});

test('attachLocalApiServerInference：推理失败回写空文本且不抛', async () => {
  let handler = null;
  const replies = [];
  attachLocalApiServerInference({
    runInference: async () => {
      throw new Error('boom');
    },
    addListener: cb => {
      handler = cb;
      return () => {};
    },
    respond: async (requestId, response) => {
      replies.push({ requestId, response });
    },
  });
  await handler({ requestId: 'req-2', body: { messages: [] } });
  assert.deepEqual(replies[0], { requestId: 'req-2', response: { text: '', model: 'local-model' } });
});

test('generateLocalApiKey：前缀稳定、长度充足、不重复', async () => {
  const { generateLocalApiKey } = await import('../src/localModel/localApiServer.js');
  const a = generateLocalApiKey();
  const b = generateLocalApiKey();
  assert.ok(a.startsWith('local-'), '应有 local- 前缀');
  assert.ok(a.length >= 30, '长度应充足');
  assert.notEqual(a, b, '两次生成不得相同');
});

test('startLocalApiServer：空密钥时生成并传非空密钥（旧原生构建一并堵上）', async () => {
  // 用 Module 打桩注入 react-native NativeModules.LocalApiServer，验证：
  // ① 传给原生的 apiKey 永不为空；② 结果回显 apiKey（原生无该字段时回落 JS 生成值）。
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const require2 = createRequire(import.meta.url);
  const CjsModule = require2('module');
  const babel = require2('@babel/core');
  const sourcePath = path.resolve('src/localModel/localApiServer.js');
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[require2.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;

  const seen = {};
  const fakeNative = {
    start: async (host, port, apiKey) => {
      seen.apiKey = apiKey;
      seen.port = port;
      return { running: true, host, port }; // 旧构建：不回显 apiKey
    },
  };
  const originalLoad = CjsModule._load;
  CjsModule._load = function patched(request) {
    if (request === 'react-native') {
      return { Platform: { OS: 'android' }, NativeModules: { LocalApiServer: fakeNative } };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const runtime = new CjsModule(sourcePath);
    runtime.filename = sourcePath;
    runtime.paths = CjsModule._nodeModulePaths(path.dirname(sourcePath));
    runtime._compile(transformed, sourcePath);
    const { startLocalApiServer } = runtime.exports;
    const result = await startLocalApiServer({ port: 8080, apiKey: '' });
    assert.ok(seen.apiKey && seen.apiKey.length > 10, '传给原生的密钥不得为空');
    assert.equal(result.apiKey, seen.apiKey, '结果应回显生效密钥（回落 JS 生成值）');
    // 显式密钥时原样传递
    const result2 = await startLocalApiServer({ port: 8081, apiKey: 'my-key' });
    assert.equal(seen.apiKey, 'my-key');
    assert.equal(result2.apiKey, 'my-key');
  } finally {
    CjsModule._load = originalLoad;
  }
});

test('面板与引导：留空自动生成的接线与文案（源码守护）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const panel = fs.readFileSync(path.join(HERE, '..', 'src', 'LocalModelPanel.js'), 'utf8');
  assert.ok(panel.includes('keyWasEmpty'), '启动时应检测密钥是否为空');
  assert.ok(panel.includes('persistApiServer({ enabled: true, apiKey: effectiveKey })'), '生成的密钥应幂等持久化');
  assert.ok(panel.includes('留空将自动生成随机密钥'), '占位文案应说明自动生成');
  assert.ok(panel.includes('Authorization: Bearer'), '复制提示应说明鉴权方式');
  const onboarding = fs.readFileSync(path.join(HERE, '..', 'src', 'onboarding', 'onboardingContent.js'), 'utf8');
  assert.ok(onboarding.includes('留空会自动生成随机密钥'), '引导章节文案应更新');
});
