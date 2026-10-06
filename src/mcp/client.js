// MCP Streamable HTTP 客户端（纯 JS，零 RN 依赖，Node 直测）。
//
// 用途：把 GitHub 的远程 MCP 服务器（默认 https://api.githubcopilot.com/mcp/）
// 接进工作区 agent——模型看到的是一组 github_* 工具，实际经 JSON-RPC 2.0 转发。
//
// 传输口径（MCP 2025-06-18 Streamable HTTP）：
//   - 全部走 POST；Accept 同时声明 json 与 event-stream，服务端二选一；
//   - initialize 后可能下发 Mcp-Session-Id 响应头，后续请求必须带回；
//   - 之后每次请求带 MCP-Protocol-Version 头（值取服务端 initialize 应答里的版本）；
//   - event-stream 应答在 RN 的 fetch 里只能整段缓冲，因此按 SSE 帧解析文本，
//     取与请求 id 匹配的那条 data（没有匹配取最后一条）。
//
// 安全约定：token 只进 Authorization 头，绝不进错误消息与日志；
// 会话过期（404）自动重初始化并重试一次；请求级超时用 AbortController。

import { tActive } from '../i18n/index.js';

export const DEFAULT_GITHUB_MCP_ENDPOINT = 'https://api.githubcopilot.com/mcp/';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
// 单请求超时：GitHub MCP 冷启动（initialize）偶尔要十几秒，20s 会误杀成
// 「Aborted」——用户看到的就是一个无意义的英文单词。放宽到 30s，
// 并把超时转成可诊断的错误码（见 isAbortError）。
const DEFAULT_TIMEOUT_MS = 30000;

// AbortController 触发的超时在 RN 上表现为 AbortError / 消息 "Aborted"。
function isAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  return /aborted/i.test(String(error.message || ''));
}

// 错误统一带稳定 code：用户可读文案由消费层（设置页/mcpTools）按 code 映射，
// 本模块保持零 i18n 依赖（纯模块要在 Node 直测）。
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// SSE 文本 → [{event, data}]。容忍 CRLF 与行尾空白；data 多行按 SSE 规范拼接。
export function parseSseFrames(text) {
  const frames = [];
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  let dataLines = null;
  const flush = () => {
    if (current && dataLines !== null) frames.push({ event: current.event || 'message', data: dataLines.join('\n') });
    current = null;
    dataLines = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '') { flush(); continue; }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      if (!current) current = {};
      current.event = value;
    } else if (field === 'data') {
      if (!current) current = {};
      if (dataLines === null) dataLines = [];
      dataLines.push(value);
    }
  }
  flush();
  return frames;
}

function authError(status) {
  if (status === 401 || status === 403) {
    return fail('MCP_AUTH_FAILED', `GitHub authentication failed: token invalid/expired or insufficient permissions (HTTP ${status}).`);
  }
  return fail('MCP_HTTP_ERROR', `GitHub MCP request failed (HTTP ${status}).`);
}

export function createMcpSession({
  endpoint = DEFAULT_GITHUB_MCP_ENDPOINT,
  token = '',
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clientInfo = { name: 'easychat2', version: '1.0.0' },
} = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') throw fail('MCP_NO_FETCH', 'fetch is unavailable in this environment');
  const state = {
    sessionId: '',
    protocolVersion: '',
    initialized: false,
    nextId: 1,
  };
  // MCP 会话是有状态的（initialize → 之后才能 list/call），并发请求会踩乱初始化
  // 时序：所有交互串行排队，一次只发一个请求。
  let chain = Promise.resolve();

  function rawRequest(method, params, { notification = false } = {}) {
    return (async () => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => {
        if (controller) controller.abort();
      }, timeoutMs);
      try {
        const id = notification ? undefined : state.nextId++;
        const body = { jsonrpc: '2.0', method };
        if (id !== undefined) body.id = id;
        if (params !== undefined) body.params = params;
        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (state.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
        if (state.protocolVersion) headers['MCP-Protocol-Version'] = state.protocolVersion;
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        });
        const headerSessionId = response.headers && typeof response.headers.get === 'function'
          ? (response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id') || '')
          : '';
        if (headerSessionId) state.sessionId = headerSessionId;
        if (!response.ok) {
          let detail = '';
          try { detail = (await response.text()).slice(0, 300); } catch (error) {}
          const error = authError(response.status);
          error.status = response.status;
          if (detail) error.message = `${error.message} ${detail}`;
          throw error;
        }
        if (response.status === 202) return null;
        const contentType = String(response.headers && response.headers.get
          ? response.headers.get('content-type') || ''
          : '');
        const text = await response.text();
        let payload = null;
        if (contentType.includes('text/event-stream')) {
          const frames = parseSseFrames(text);
          const dataFrames = frames.map(frame => frame.data).filter(Boolean);
          let parsed = dataFrames.map(line => {
            try { return JSON.parse(line); } catch (error) { return null; }
          }).filter(Boolean);
          if (id !== undefined) {
            const matched = parsed.find(item => item && item.id === id);
            if (matched) parsed = [matched];
          }
          payload = parsed.length > 0 ? parsed[parsed.length - 1] : null;
        } else {
          try { payload = JSON.parse(text); } catch (error) { payload = null; }
        }
        if (!payload) {
          // 通知类（无 id）允许空应答；请求类必须拿到 JSON-RPC 应答。
          if (notification) return null;
          throw fail('MCP_INVALID_RESPONSE', 'GitHub MCP returned an invalid JSON-RPC response.');
        }
        if (payload.error) {
          throw new Error(tActive('error.mcp.githubError', {
            code: payload.error.code,
            message: payload.error.message || tActive('error.mcp.unknown'),
          }));
        }
        if (notification) return null;
        return payload.result !== undefined ? payload.result : null;
      } catch (error) {
        // 超时（我们自己的 AbortController）必须转成可诊断的错误码：
        // 否则原始 "Aborted" 会一路漏到界面，用户完全不知道发生了什么。
        if (isAbortError(error)) {
          throw fail('MCP_TIMEOUT', `GitHub MCP request timed out after ${Math.round(timeoutMs / 1000)}s.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
  }

  async function initialize() {
    const result = await rawRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    state.protocolVersion = (result && result.protocolVersion) || MCP_PROTOCOL_VERSION;
    state.initialized = true;
    // 规范要求 initialize 后补一条 initialized 通知才算握手完成；失败不回滚——
    // 很多无状态实现不区分。
    await rawRequest('notifications/initialized', undefined, { notification: true }).catch(() => {});
  }

  function ensureInitialized() {
    if (state.initialized) return Promise.resolve();
    return initialize();
  }

  function reset() {
    state.sessionId = '';
    state.protocolVersion = '';
    state.initialized = false;
  }

  function dispatch(method, params, options = {}) {
    const run = async () => {
      try {
        await ensureInitialized();
        return await rawRequest(method, params, options);
      } catch (error) {
        // 会话失效（服务端重启/过期表现为 404）：重置并整段重来一次。
        if (error && error.status === 404 && state.initialized) {
          reset();
          await ensureInitialized();
          return rawRequest(method, params, options);
        }
        throw error;
      }
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  return {
    async listTools() {
      const result = await dispatch('tools/list', {});
      return result && Array.isArray(result.tools) ? result.tools : [];
    },
    async callTool(name, args) {
      const result = await dispatch('tools/call', {
        name: String(name || ''),
        arguments: args && typeof args === 'object' ? args : {},
      });
      return result || { content: [], isError: false };
    },
    async ping() {
      await ensureInitialized();
      return true;
    },
    close() {
      reset();
    },
  };
}
