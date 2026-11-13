// 流式 HTTP 代理（design.md「适配层契约 4」）：主进程用 node:https/http 代发请求，
// 渲染层的 XHR 适配器只收事件。动机：渲染进程直连用户任意端点会撞 CORS 预检；
// 主进程可统一超时、证书与代理（首版直接沿用 Electron 默认的系统证书/代理）。
//
// 事件顺序契约（XHR 适配器依赖它）：
//   http:status -> 若干 http:chunk（seq 单调递增）-> 恰好一次 http:done 或 http:error
// 跨块多字节：必须用 TextDecoder({ stream: true }) 手动解码。res.setEncoding('utf8')
// 与逐块 Buffer.toString() 都会在块边界把多字节字符切成 U+FFFD（仓库已有同类教训）。
import { TextDecoder } from 'node:util';
import http from 'node:http';
import https from 'node:https';

const CONNECT_TIMEOUT_MS = 20000;
const FIRST_BYTE_TIMEOUT_MS = 60000;

export function createHttpProxy({ sendEvent, httpModule = http, httpsModule = https } = {}) {
  const active = new Map();
  let nextRequestId = 1;

  function start({ method = 'GET', url, headers = {}, body = null } = {}) {
    const requestId = nextRequestId;
    nextRequestId += 1;
    const parsed = new URL(String(url));
    const mod = parsed.protocol === 'http:' ? httpModule : httpsModule;
    const decoder = new TextDecoder('utf-8');
    let seq = 0;
    let settled = false;
    let firstByteTimer = null;

    const settle = (kind, error) => {
      if (settled) return false;
      settled = true;
      if (firstByteTimer) clearTimeout(firstByteTimer);
      active.delete(requestId);
      sendEvent({ type: kind, requestId, ...(error ? { error: String((error && error.message) || error) } : {}) });
      return true;
    };

    const request = mod.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: String(method).toUpperCase(),
      headers,
    });

    request.setTimeout(CONNECT_TIMEOUT_MS, () => {
      request.destroy(new Error('connect timeout'));
    });
    firstByteTimer = setTimeout(() => request.destroy(new Error('first byte timeout')), FIRST_BYTE_TIMEOUT_MS);

    request.on('response', response => {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = null;
      }
      sendEvent({ type: 'status', requestId, status: response.statusCode || 0 });
      response.on('data', chunk => {
        if (settled) return;
        const text = decoder.decode(chunk, { stream: true });
        if (!text) return;
        seq += 1;
        sendEvent({ type: 'chunk', requestId, seq, text });
      });
      response.on('end', () => {
        // flush 尾部残留字节（跨块截断的最后一个多字节字符）。
        const tail = decoder.decode();
        if (tail) {
          seq += 1;
          sendEvent({ type: 'chunk', requestId, seq, text: tail });
        }
        settle('done');
      });
      response.on('error', error => settle('error', error));
    });
    request.on('error', error => settle('error', error));

    if (body != null) request.write(String(body));
    request.end();
    active.set(requestId, { request, settled: () => settled });
    return { requestId };
  }

  function abort(requestId) {
    const entry = active.get(requestId);
    if (!entry) return;
    // destroy 会触发 request 的 error 事件，但 settled 已由 abort 抢先置位，
    // XHR 侧只会看到一次 http:abort。
    if (!entry.settled()) {
      entry.request.destroy();
      active.delete(requestId);
      sendEvent({ type: 'abort', requestId });
    }
  }

  function closeAll() {
    for (const { request, settled } of active.values()) {
      if (!settled()) request.destroy();
    }
    active.clear();
  }

  return { start, abort, closeAll };
}

export function registerHttpIpc(ipcMain, proxy) {
  ipcMain.handle('http:start', (event, payload) => proxy.start(payload));
  ipcMain.handle('http:abort', (event, requestId) => proxy.abort(requestId));
}
