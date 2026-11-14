// 流式 HTTP 代理（design.md「适配层契约 4」）：主进程用 node:https/http 代发请求，
// 渲染层的 XHR 适配器只收事件。动机：渲染进程直连用户任意端点会撞 CORS 预检；
// 主进程可统一超时、证书与代理（首版直接沿用 Electron 默认的系统证书/代理）。
//
// 事件顺序契约（XHR 适配器依赖它）：
//   http:status -> 若干 http:chunk（seq 单调递增）-> 恰好一次 http:done 或 http:error
// 跨块多字节：必须用 TextDecoder({ stream: true }) 手动解码。res.setEncoding('utf8')
// 与逐块 Buffer.toString() 都会在块边界把多字节字符切成 U+FFFD（仓库已有同类教训）。
import fs from 'node:fs';
import { TextDecoder } from 'node:util';
import http from 'node:http';
import https from 'node:https';

const CONNECT_TIMEOUT_MS = 20000;
const FIRST_BYTE_TIMEOUT_MS = 60000;

/**
 * 识别「多部分上传」请求体。渲染层用 `{ multipart: { fields, file } }` 表达：
 *   fields: [{ name, value }]      普通文本字段
 *   file:   { path, fieldName, name, mime }   本地文件字段（主进程读盘）
 * 不是这个形状就返回 null，走原来的字符串/空体分支（既有调用完全不受影响）。
 */
export function normalizeMultipart(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const source = body.multipart;
  if (!source || typeof source !== 'object') return null;
  const file = source.file && typeof source.file === 'object' ? source.file : null;
  const fields = (Array.isArray(source.fields) ? source.fields : [])
    .filter(item => item && typeof item === 'object' && item.name)
    .map(item => ({ name: String(item.name), value: String(item.value === undefined ? '' : item.value) }));
  if (!file || !file.path) return { fields, file: null };
  return {
    fields,
    file: {
      path: String(file.path),
      fieldName: String(file.fieldName || 'file'),
      name: String(file.name || 'upload.bin'),
      mime: String(file.mime || 'application/octet-stream'),
    },
  };
}

/**
 * 组 multipart/form-data 字节与 Content-Type。
 *
 * 为什么不用现成的 FormData：主进程要读本地文件并精确控制边界与字段顺序
 *（与手机端 RN FormData 的字段顺序一致：file 先、model 后），
 * 而 node 的 FormData 走全局 fetch 而非 http.request，与这条流式通道不兼容。
 *
 * boundary 由调用方注入（默认随机），便于测试固定输出。
 */
export function buildMultipart(part, { boundary = null, readFile = fs.readFileSync } = {}) {
  const marker = String(boundary || `----easychat2${Math.random().toString(36).slice(2)}`);
  const chunks = [];
  const push = text => chunks.push(Buffer.from(text, 'utf8'));
  if (part && part.file) {
    push(`--${marker}\r\n`);
    // 文件名/字段名里出现引号或换行会破坏头部：剥掉控制字符，引号转义成同义的安全写法。
    const safeName = String(part.file.name).replace(/[\r\n"]/g, '_');
    push(
      `Content-Disposition: form-data; name="${String(part.file.fieldName).replace(/[\r\n"]/g, '_')}"; filename="${safeName}"\r\n`
    );
    push(`Content-Type: ${part.file.mime}\r\n\r\n`);
    chunks.push(readFile(part.file.path));
    push('\r\n');
  }
  for (const field of (part && Array.isArray(part.fields) ? part.fields : [])) {
    push(`--${marker}\r\n`);
    push(`Content-Disposition: form-data; name="${String(field.name).replace(/[\r\n"]/g, '_')}"\r\n\r\n`);
    push(String(field.value));
    push('\r\n');
  }
  push(`--${marker}--\r\n`);
  return {
    buffer: Buffer.concat(chunks),
    headers: { 'Content-Type': `multipart/form-data; boundary=${marker}` },
  };
}

export function createHttpProxy({ sendEvent, httpModule = http, httpsModule = https, resolver = null } = {}) {
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

    // 请求体三种形态：
    //   1. 字符串（api.js 的 JSON 请求，唯一既有用法）；
    //   2. multipart —— 语音转写要把本地音频文件当文件字段上传（见 buildMultipart）；
    //   3. 无体。
    // 这里**不接收渲染层传来的任意 Blob/binary**：二进制只允许以 {filePath} 形式
    // 出现，主进程自己读盘（渲染层拿不到可绕开白名单的文件句柄）。
    const multipart = normalizeMultipart(body);
    if (multipart) {
      // 白名单：文件路径必须落在 resolver 允许的目录内（documents/cache）。
      // 没有 resolver 就**拒绝**——宁可让转写失败，也不让渲染层指定任意路径读盘。
      if (multipart.file) {
        if (!resolver) throw new Error('multipart file upload requires a path resolver');
        multipart.file.path = resolver.resolve(multipart.file.path);
      }
      const encoded = buildMultipart(multipart);
      for (const [name, value] of Object.entries(encoded.headers)) {
        request.setHeader(name, value);
      }
      request.write(encoded.buffer);
    } else if (body != null) {
      request.write(String(body));
    }
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
