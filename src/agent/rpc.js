// JSON-RPC 2.0 映射层——差距 #3「程序化接口 / SDK」的协议切面。
//
// 现状：`agent/protocol.js` 是 JSONL 事件流（run_start / text / tool_start / …），
// `agent/agentEndpoint.js` 是 HTTP `POST /v1/agent` 的请求/响应契约。本模块把两者**映射到
// JSON-RPC 2.0**——于是任何 JSON-RPC 客户端（含 ACP 风格的编辑器/IDE）都能驱动 agent，
// 而不必理解我们内部的 JSONL 事件名。
//
// 纯函数、零 IO、可 Node 直测。传输层（HTTP / stdio / WebSocket）不在这里。

import { AGENT_PROTOCOL_VERSION } from './protocol.js';

export const JSONRPC_VERSION = '2.0';

// 对外方法名（稳定契约）。agent.run 是程序化入口；cancel 中止；models 列模型。
export const AGENT_RPC_METHODS = Object.freeze(['agent.run', 'agent.cancel', 'agent.models']);

export const RPC_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

// 把内部 JSONL 事件 → JSON-RPC **通知**（method = agent.<type>，params = 事件本体）。
export function toRpcNotification(event) {
  const type = String((event && event.type) || 'event');
  return {
    jsonrpc: JSONRPC_VERSION,
    method: `agent.${type}`,
    params: { ...(event || {}), protocolVersion: AGENT_PROTOCOL_VERSION },
  };
}

// 构造一个请求。
export function toRpcRequest({ id, method, params } = {}) {
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, method: String(method || ''), params: params || {} };
}

// 构造成功响应 / 错误响应。
export function buildRpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, result: result === undefined ? null : result };
}

export function buildRpcError(id, code, message, data) {
  const error = { code: Number(code) || RPC_ERROR_CODES.INTERNAL_ERROR, message: String(message || '') };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, error };
}

// 解析一行 JSON-RPC 文本 → 归一消息对象。永不抛。
// 返回 { kind: 'request'|'notification'|'response'|'error'|'invalid', id?, method?, params?, result?, error? }
export function parseRpcMessage(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text == null ? '' : text));
  } catch (error) {
    return { kind: 'invalid', error: { code: RPC_ERROR_CODES.PARSE_ERROR, message: 'JSON 解析失败' } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: '消息不是对象' } };
  }
  // JSON-RPC 2.0 允许响应带 `id: null`（对无法解析 id 的请求的应答）——所以「有没有 id」
  // 看**属性是否存在**，而不是值是否非 null。
  const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id') && parsed.id !== undefined;
  if (parsed.error && hasId) {
    return { kind: 'error', id: parsed.id, error: parsed.error };
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'result') && hasId) {
    return { kind: 'response', id: parsed.id, result: parsed.result };
  }
  if (typeof parsed.method === 'string') {
    if (hasId) return { kind: 'request', id: parsed.id, method: parsed.method, params: parsed.params || {} };
    return { kind: 'notification', method: parsed.method, params: parsed.params || {} };
  }
  return { kind: 'invalid', error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: '既无 method 也无 result/error' } };
}

// 分发一个请求到 handlers（{ [method]: async (params) => result }）。返回响应对象。
// 未知方法 → METHOD_NOT_FOUND；handler 抛错 → INTERNAL_ERROR（消息脱敏留给调用方）。
export async function handleRpcRequest(message, handlers = {}) {
  if (!message || message.kind !== 'request') {
    const id = message && message.id !== undefined ? message.id : null;
    return buildRpcError(id, RPC_ERROR_CODES.INVALID_REQUEST, '不是合法请求');
  }
  if (!AGENT_RPC_METHODS.includes(message.method)) {
    return buildRpcError(message.id, RPC_ERROR_CODES.METHOD_NOT_FOUND, `未知方法：${message.method}`);
  }
  const handler = handlers[message.method];
  if (typeof handler !== 'function') {
    return buildRpcError(message.id, RPC_ERROR_CODES.METHOD_NOT_FOUND, `未注册方法：${message.method}`);
  }
  try {
    const result = await handler(message.params || {});
    return buildRpcResult(message.id, result);
  } catch (error) {
    return buildRpcError(message.id, RPC_ERROR_CODES.INTERNAL_ERROR, String((error && error.message) || error));
  }
}
