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
