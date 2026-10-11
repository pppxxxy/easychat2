// 程序化接口/SDK（差距 #3）——JSON-RPC 映射与 JS SDK 的行为测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JSONRPC_VERSION,
  AGENT_RPC_METHODS,
  RPC_ERROR_CODES,
  toRpcNotification,
  toRpcRequest,
  buildRpcResult,
  buildRpcError,
  parseRpcMessage,
  handleRpcRequest,
} from '../src/agent/rpc.js';
import {
  parseSseText,
  chunkText,
  createAgentClient,
  AGENT_RUN_OBJECT,
} from '../src/agent/sdk.js';
import { attachLocalApiServerRpc, RPC_ENDPOINT_PATH } from '../src/localModel/localApiServer.js';

test('rpc：JSONL 事件 → JSON-RPC 通知', () => {
  const note = toRpcNotification({ type: 'text', text: 'hi' });
  assert.equal(note.jsonrpc, JSONRPC_VERSION);
  assert.equal(note.method, 'agent.text');
  assert.equal(note.params.text, 'hi');
  assert.equal(typeof note.params.protocolVersion, 'number');
});

test('rpc：parseRpcMessage 分派 request/notification/response/error/invalid', () => {
  assert.deepEqual(parseRpcMessage('{bad json').kind, 'invalid');
  assert.equal(parseRpcMessage('[]').kind, 'invalid');
  const req = parseRpcMessage(JSON.stringify(toRpcRequest({ id: 1, method: 'agent.run', params: { prompt: 'x' } })));
  assert.equal(req.kind, 'request');
  assert.equal(req.id, 1);
  assert.equal(req.method, 'agent.run');
  const note = parseRpcMessage(JSON.stringify(toRpcNotification({ type: 'usage' })));
  assert.equal(note.kind, 'notification');
  assert.equal(note.method, 'agent.usage');
  const res = parseRpcMessage(JSON.stringify(buildRpcResult(2, { ok: true })));
  assert.equal(res.kind, 'response');
  assert.deepEqual(res.result, { ok: true });
  const err = parseRpcMessage(JSON.stringify(buildRpcError(3, RPC_ERROR_CODES.METHOD_NOT_FOUND, 'x')));
  assert.equal(err.kind, 'error');
  assert.equal(err.error.code, RPC_ERROR_CODES.METHOD_NOT_FOUND);
  // JSON-RPC 2.0：`id: null` 的响应（对无法解析 id 的请求的应答）应识别为 response
  const nullId = parseRpcMessage(JSON.stringify({ jsonrpc: '2.0', id: null, result: { ok: true } }));
  assert.equal(nullId.kind, 'response');
  assert.equal(nullId.id, null);
});

test('rpc：handleRpcRequest 分发 / 未知方法 / handler 抛错', async () => {
  const handlers = { 'agent.run': async params => ({ echoed: params.prompt }) };
  const ok = await handleRpcRequest(parseRpcMessage(JSON.stringify(toRpcRequest({ id: 1, method: 'agent.run', params: { prompt: 'p' } }))), handlers);
  assert.deepEqual(ok.result, { echoed: 'p' });
  const unknown = await handleRpcRequest(parseRpcMessage(JSON.stringify(toRpcRequest({ id: 2, method: 'agent.nope' }))), handlers);
  assert.equal(unknown.error.code, RPC_ERROR_CODES.METHOD_NOT_FOUND);
  const boom = await handleRpcRequest(parseRpcMessage(JSON.stringify(toRpcRequest({ id: 3, method: 'agent.models' }))), { 'agent.models': async () => { throw new Error('kaboom'); } });
  assert.equal(boom.error.code, RPC_ERROR_CODES.INTERNAL_ERROR);
  assert.match(boom.error.message, /kaboom/);
  assert.ok(AGENT_RPC_METHODS.includes('agent.run'));
});

test('sdk：parseSseText 解析事件块并保留未闭合尾部', () => {
  const { events, rest } = parseSseText('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].data, { a: 1 });
  assert.equal(rest, 'data: {"c"');
  const done = parseSseText('data: [DONE]\n\n');
  assert.equal(done.events[0].data, '[DONE]');
});

test('sdk：chunkText 取增量文本（chunk / responses / delta）', () => {
  assert.equal(chunkText({ choices: [{ delta: { content: 'a' } }] }), 'a');
  assert.equal(chunkText({ choices: [{ text: 'b' }] }), 'b');
  assert.equal(chunkText({ delta: 'c' }), 'c');
  assert.equal(chunkText(null), '');
});

test('sdk：createAgentClient 走注入的 fetch（listModels / runAgent / streamChat）', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, method: (options && options.method) || 'GET' });
    if (url.endsWith('/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ object: 'list', data: [{ id: 'm' }] }) };
    }
    if (url.endsWith('/v1/agent')) {
      return { ok: true, status: 200, json: async () => ({ object: AGENT_RUN_OBJECT, content: 'done' }) };
    }
    if (url.endsWith('/v1/chat/completions')) {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      let i = 0;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                if (i >= chunks.length) return { done: true, value: undefined };
                const value = new TextEncoder().encode(chunks[i]);
                i += 1;
                return { done: false, value };
              },
            };
          },
        },
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = createAgentClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch });
  assert.equal((await client.listModels()).object, 'list');
  const run = await client.runAgent({ prompt: 'p' });
  assert.equal(run.object, AGENT_RUN_OBJECT);
  const pieces = [];
  const full = await client.streamChat({ messages: [{ role: 'user', content: 'hi' }], onToken: t => pieces.push(t) });
  assert.equal(full, '你好');
  assert.deepEqual(pieces, ['你', '好']);
  assert.ok(calls.some(c => c.url.endsWith('/v1/agent') && c.method === 'POST'));
});

test('sdk：baseUrl 归一（去尾斜杠）', () => {
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:8686/', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(client.baseUrl, 'http://127.0.0.1:8686');
});

test('localApiServer：/rpc 端点分发 JSON-RPC 并回写响应', async () => {
  const sent = [];
  let listener = null;
  const detach = attachLocalApiServerRpc({
    handlers: { 'agent.run': async params => ({ echoed: params.prompt }) },
    addListener: cb => { listener = cb; return () => {}; },
    respond: async (requestId, response) => { sent.push({ requestId, response }); return true; },
  });
  await listener({ requestId: 'r1', path: RPC_ENDPOINT_PATH, body: { jsonrpc: '2.0', id: 1, method: 'agent.run', params: { prompt: 'p' } } });
  assert.equal(sent[0].response.result.echoed, 'p');
  const before = sent.length;
  await listener({ requestId: 'r2', path: '/v1/chat/completions', body: {} });
  assert.equal(sent.length, before, '非 /rpc 路径不处理');
  detach();
});
