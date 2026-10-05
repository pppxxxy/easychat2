// MCP Streamable HTTP 客户端测试：握手/会话头/SSE 应答/401/404 重试/JSON-RPC 错误。
// 用 node:http 起真实桩服务器，走 createMcpSession 的完整请求路径。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createMcpSession, parseSseFrames, MCP_PROTOCOL_VERSION } from '../src/mcp/client.js';

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function listenPort(server) {
  return server.address().port;
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

function jsonResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

test('parseSseFrames：多帧/CRLF/多行 data', () => {
  const frames = parseSseFrames('event: message\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\n');
  assert.deepEqual(frames, [
    { event: 'message', data: '{"a":1}' },
    { event: 'message', data: 'line1\nline2' },
  ]);
  assert.deepEqual(parseSseFrames(''), []);
});

test('完整握手：initialize 会话头 + 协议版本 + tools/list + tools/call', async () => {
  const seen = [];
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    seen.push({
      method: body.method,
      session: req.headers['mcp-session-id'] || '',
      protocol: req.headers['mcp-protocol-version'] || '',
      auth: req.headers.authorization || '',
    });
    if (body.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(jsonResult(body.id, { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'stub' } }));
    } else if (body.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
    } else if (body.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResult(body.id, { tools: [{ name: 'get_file_contents' }] }));
    } else if (body.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResult(body.id, { content: [{ type: 'text', text: `ok:${body.params.name}` }], isError: false }));
    } else {
      res.writeHead(400); res.end();
    }
  });
  try {
    const endpoint = `http://127.0.0.1:${listenPort(server)}/mcp/`;
    const session = createMcpSession({ endpoint, token: 'tok-1' });
    const tools = await session.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'get_file_contents');
    const call = await session.callTool('get_file_contents', { path: 'README.md' });
    assert.equal(call.content[0].text, 'ok:get_file_contents');
    // initialize 是第一条：无会话头无版本头；之后必须带上会话与协议版本。
    assert.equal(seen[0].method, 'initialize');
    assert.equal(seen[0].session, '');
    assert.ok(seen[0].auth.endsWith('tok-1'));
    assert.equal(seen[2].session, 'sess-1');
    assert.equal(seen[2].protocol, MCP_PROTOCOL_VERSION);
    session.close();
  } finally {
    server.close();
  }
});

test('event-stream 应答按 SSE 解析并取回匹配 id 的那条', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (body.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's' });
      res.end(jsonResult(body.id, { protocolVersion: MCP_PROTOCOL_VERSION }));
    } else if (body.method === 'notifications/initialized') {
      res.writeHead(202); res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 先来一条无关帧，再给匹配 id 的应答：客户端必须按 id 挑。
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { wrong: true } })}\n\n`
        + `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'sse-ok' }] } })}\n\n`);
    }
  });
  try {
    const endpoint = `http://127.0.0.1:${listenPort(server)}/mcp/`;
    const session = createMcpSession({ endpoint, token: 't' });
    const call = await session.callTool('get_me', {});
    assert.equal(call.content[0].text, 'sse-ok');
    session.close();
  } finally {
    server.close();
  }
});

test('401 映射为认证失败错误并带稳定 code', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (req.headers.authorization !== 'Bearer good') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    if (body.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResult(body.id, { protocolVersion: MCP_PROTOCOL_VERSION }));
    } else if (body.method === 'notifications/initialized') {
      res.writeHead(202); res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResult(body.id, { tools: [] }));
    }
  });
  try {
    const endpoint = `http://127.0.0.1:${listenPort(server)}/mcp/`;
    const bad = createMcpSession({ endpoint, token: 'bad' });
    await assert.rejects(() => bad.listTools(), error => error.code === 'MCP_AUTH_FAILED');
    const good = createMcpSession({ endpoint, token: 'good' });
    assert.deepEqual(await good.listTools(), []);
    bad.close(); good.close();
  } finally {
    server.close();
  }
});

test('会话过期（404）自动重初始化并重试一次', async () => {
  let initCount = 0;
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (body.method === 'initialize') {
      initCount += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `sess-${initCount}` });
      res.end(jsonResult(body.id, { protocolVersion: MCP_PROTOCOL_VERSION }));
    } else if (body.method === 'notifications/initialized') {
      res.writeHead(202); res.end();
    } else if (req.headers['mcp-session-id'] === 'sess-1') {
      // 服务端重启：旧会话一律 404
      res.writeHead(404); res.end('session expired');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResult(body.id, { tools: [{ name: 'get_me' }] }));
    }
  });
  try {
    const endpoint = `http://127.0.0.1:${listenPort(server)}/mcp/`;
    const session = createMcpSession({ endpoint, token: 't' });
    const tools = await session.listTools();
    assert.equal(tools[0].name, 'get_me');
    assert.ok(initCount >= 2, '404 后必须重新 initialize');
    session.close();
  } finally {
    server.close();
  }
});

test('JSON-RPC error 应答转为异常', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (body.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResult(body.id, { protocolVersion: MCP_PROTOCOL_VERSION }));
    } else if (body.method === 'notifications/initialized') {
      res.writeHead(202); res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'tool exploded' } }));
    }
  });
  try {
    const endpoint = `http://127.0.0.1:${listenPort(server)}/mcp/`;
    const session = createMcpSession({ endpoint, token: 't' });
    await assert.rejects(() => session.callTool('create_branch', {}), /tool exploded/);
    session.close();
  } finally {
    server.close();
  }
});
