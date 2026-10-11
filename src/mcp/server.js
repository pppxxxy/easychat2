// 内置 MCP Server 的协议层（纯 JS、零原生依赖、Node 可直测）。
//
// 分工：传输在原生侧（plugins/mcpServer：NanoHTTPD + Bearer 鉴权 + 事件桥），本模块只做
// 「HTTP 语义 → MCP 语义」的翻译——入参是解析好的 HTTP 请求（method / sessionId / headers /
// body），出参是 { status, headers, body }，原生照这个结果写回。**所有 MCP 判断都在这一个
// 文件里**，Kotlin 那边保持哑管道：协议能单测，原生不需要为了改协议重新编译验证。
//
// 传输形态与 Tavo 的「direct HTTP JSON-RPC」一致：POST /mcp 带 JSON-RPC 请求体，
// 应答就是 application/json。规范允许服务端不用 SSE，工具类服务器也不需要服务端推送，
// 所以这里**不实现** GET /mcp 的 SSE 长连接（返回 405 并给出 Allow），DELETE /mcp
// 用来结束会话（规范里的可选能力，顺手实现，客户端想清理也不会 404）。

import { MCP_PROTOCOL_VERSION } from './client.js';
import { parseRpcMessage } from '../agent/rpc.js';

export const MCP_ENDPOINT_PATH = '/mcp';
export const MCP_SERVER_NAME = 'easychat2';
export const MCP_SERVER_VERSION = '1.0.0';

// 本服务器支持的协议版本：与内置 MCP 客户端同一版（client.js 的 MCP_PROTOCOL_VERSION），
// 这样「我们当客户端」和「我们当服务端」不会漂移出两个版本号。
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([MCP_PROTOCOL_VERSION]);

const JSONRPC = '2.0';

// 错误码：JSON-RPC 标准码 + MCP 的「资源不存在」。
export const MCP_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RESOURCE_NOT_FOUND: -32002,
});

export function toResult(id, result) {
  return { jsonrpc: JSONRPC, id: id === undefined ? null : id, result: result === undefined ? {} : result };
}

export function toError(id, code, message) {
  return { jsonrpc: JSONRPC, id: id === undefined ? null : id, error: { code, message: String(message || '') } };
}

// 会话 id：MCP 规范里服务端可在 initialize 时下发 Mcp-Session-Id，客户端之后必须回带。
// 用随机串即可（不是安全凭据——鉴权是 Bearer token，这个只用来分辨会话与触发重新握手）。
export function createSessionId(random = Math.random) {
  const bytes = [];
  for (let i = 0; i < 16; i += 1) bytes.push(Math.floor(random() * 256));
  return bytes.map(value => value.toString(16).padStart(2, '0')).join('');
}

function acceptsJson(headers) {
  const raw = String((headers && (headers.accept || headers.Accept)) || '').trim();
  // 没写 Accept 一律放行（很多客户端不带）；写了就必须包含 json 或 event-stream。
  if (!raw) return true;
  return raw.includes('application/json') || raw.includes('text/event-stream') || raw.includes('*/*');
}

function httpResponse(status, body, headers = {}) {
  return { status, headers, body: body === undefined ? null : body };
}

// 建一个 MCP 服务器实例。所有能力（列工具/调工具/读文档）都由调用方注入——
// 于是这个模块可以在 Node 里用假能力直测，桥接层负责接真实注册表与工作区。
export function createMcpServer({
  serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  instructions = '',
  listTools = () => [],
  callTool = async () => ({ content: '', isError: false }),
  listResources = () => [],
  readResource = async () => null,
  random = Math.random,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const sessions = new Map();

  function createSession() {
    const id = createSessionId(random);
    sessions.set(id, { id, createdAt: now(), initialized: true });
    return id;
  }

  function buildInitializeResult(params) {
    const requested = String((params && params.protocolVersion) || '');
    return {
      // 回我们支持的版本；客户端若不支持会自行断开（规范如此），不在这里猜。
      protocolVersion: requested && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        // 不声明 logging/prompts 能力：没有实现就不宣称，免得客户端来调再吃 METHOD_NOT_FOUND。
      },
      serverInfo,
      ...(instructions ? { instructions } : {}),
    };
  }

  async function dispatch(message) {
    const { id, method, params } = message;
    switch (method) {
      case 'initialize':
        return toResult(id, buildInitializeResult(params));
      case 'ping':
        return toResult(id, {});
      case 'tools/list':
        return toResult(id, { tools: await listTools(params || {}) });
      case 'tools/call': {
        const name = String((params && params.name) || '');
        if (!name) return toError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'tools/call 缺少 name');
        const result = await callTool({ name, args: (params && params.arguments) || {}, params: params || {} });
        // 工具级失败（含「档位未开」「只给预览」「工具自己报错」）走 result.isError，
        // 不用 JSON-RPC error——协议错误与工具失败必须分得开，否则客户端会把
        // 「工具跑完但失败」当成「服务器不支持」。
        return toResult(id, {
          content: [{ type: 'text', text: String((result && result.content) || '') }],
          isError: result && result.isError === true,
          ...(result && result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        });
      }
      case 'resources/list':
        return toResult(id, { resources: await listResources(params || {}) });
      case 'resources/templates/list':
        return toResult(id, { resourceTemplates: [] });
      case 'resources/read': {
        const uri = String((params && params.uri) || '');
        if (!uri) return toError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'resources/read 缺少 uri');
        const found = await readResource({ uri, params: params || {} });
        if (!found) {
          return toError(id, MCP_ERROR_CODES.RESOURCE_NOT_FOUND, `没有这个资源：${uri}`);
        }
        return toResult(id, {
          contents: [{ uri, mimeType: found.mimeType || 'text/plain', text: String(found.text || '') }],
        });
      }
      case 'prompts/list':
        // 没实现提示词库：如实返回空表（比返回 METHOD_NOT_FOUND 更好——客户端可以照常初始化）。
        return toResult(id, { prompts: [] });
      default:
        return toError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `未实现的方法：${method}`);
    }
  }

  // 处理一个已解析的 HTTP 请求，返回 { status, headers, body }。
  // body 是 JS 对象（由调用方序列化）；202/204 时 body 为 null。
  async function handle({ method = 'POST', sessionId = '', headers = {}, body = null } = {}) {
    const httpMethod = String(method || 'POST').toUpperCase();
    if (httpMethod === 'GET') {
      // 不提供服务端推送：按规范回 405 并声明允许的方法。
      return httpResponse(405, toError(null, MCP_ERROR_CODES.INVALID_REQUEST, 'GET 不受支持：本服务器不提供服务端 SSE 推送，请用 POST。'), { Allow: 'POST, DELETE' });
    }
    if (httpMethod === 'DELETE') {
      const had = sessions.delete(String(sessionId || ''));
      return httpResponse(200, { ok: true, removed: had }, had ? {} : {});
    }
    if (httpMethod !== 'POST') {
      return httpResponse(405, toError(null, MCP_ERROR_CODES.INVALID_REQUEST, `不支持的 HTTP 方法：${httpMethod}`), { Allow: 'POST, DELETE' });
    }
    if (!acceptsJson(headers)) {
      return httpResponse(406, toError(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Accept 必须包含 application/json。'));
    }
    const sid = String(sessionId || '');
    // 会话 id 是「有就必须认得」：认不得说明 App 重启或会话被清，规范要求 404，
    // 客户端据此重新 initialize（我们自己的客户端就是这么实现的）。
    if (sid && !sessions.has(sid)) {
      return httpResponse(404, toError(null, MCP_ERROR_CODES.INVALID_REQUEST, '会话不存在，请重新 initialize。'));
    }

    let message;
    try {
      const raw = typeof body === 'string' ? body : JSON.stringify(body === null || body === undefined ? {} : body);
      message = parseRpcMessage(raw);
    } catch (error) {
      return httpResponse(400, toError(null, MCP_ERROR_CODES.PARSE_ERROR, '请求体不是合法 JSON。'));
    }
    if (!message || message.kind === 'invalid') {
      // parseRpcMessage 永不抛：它把「JSON 坏了」和「结构不对」分成两个码（-32700 / -32600）。
      // 这里必须原样保留那个码——客户端靠它区分「我发的东西不是 JSON」与「我的 JSON-RPC 不合法」。
      const parsedCode = message && message.error && Number(message.error.code);
      const code = Number.isFinite(parsedCode) ? parsedCode : MCP_ERROR_CODES.INVALID_REQUEST;
      return httpResponse(400, toError(null, code, (message && message.error && message.error.message) || '不是合法的 JSON-RPC 消息。'));
    }

    // 通知（无 id）：做完就 202，不产生应答体。
    if (message.kind === 'notification') {
      if (message.method === 'notifications/initialized' && !sid) {
        // 有些客户端不带会话 id 直接发初始化通知：这里不报错，保持宽容。
      }
      log('notification', message.method);
      return httpResponse(202, null, sid ? {} : {});
    }
    if (message.kind !== 'request') {
      return httpResponse(400, toError(null, MCP_ERROR_CODES.INVALID_REQUEST, '客户端不该向服务器发应答。'));
    }

    const isInitialize = message.method === 'initialize';
    let nextSessionId = sid;
    if (isInitialize) nextSessionId = createSession();

    let response;
    try {
      response = await dispatch(message);
    } catch (error) {
      response = toError(message.id, MCP_ERROR_CODES.INTERNAL_ERROR, (error && error.message) || '服务器内部错误');
    }
    return httpResponse(200, response, nextSessionId ? { 'Mcp-Session-Id': nextSessionId } : {});
  }

  return { handle, sessions, createSession };
}
