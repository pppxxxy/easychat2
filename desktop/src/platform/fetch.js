// fetch 适配（渲染层 → 主进程代理）：共享层用 fetch 的少数几处需要绕开 CORS，
// 并且其中一处（语音转写）要上传本地音频文件。
//
// 为什么必须覆写而不是用 Chromium 原生 fetch：
//   · 渲染进程直连用户任意端点会撞 CSP connect-src 'self' 与 CORS 预检（design.md
//     「网络」决策：唯一出口是主进程代理）；
//   · 更关键：原生 FormData 只能装 Blob，而共享层 src/transcription.js 按 RN 约定
//     `form.append('file', { uri, name, type })` 传**本地文件路径**。渲染层既拿不到
//     文件句柄，也不该被允许读任意路径——所以只把形状翻译成 {path}，由主进程读盘
//     （并过目录白名单，见 electron/ipc/http.js）。
//
// 只实现共享层实际用到的子集：POST/GET + JSON 响应 + headers.get + text/json/ok/status。
// 流式响应不在本文件范围（那走 XMLHttpRequest 适配，见 platform/xhr.js）。
/** 从 RN 形态的 FormData 里抽出字段与文件项（唯一被支持的上传形态）。 */
export function formDataToMultipart(body) {
  const entries = [];
  // RN 的 FormData 是 `_parts`；浏览器实现是内部槽位，读不到就明确报错，
  // 而不是悄悄发一个空请求（那会变成「服务端说没收到文件」的怪错误）。
  if (Array.isArray(body && body._parts)) {
    for (const part of body._parts) {
      if (!Array.isArray(part) || part.length < 2) continue;
      entries.push({ name: String(part[0]), value: part[1] });
    }
  } else {
    throw new Error('fetch(FormData): cannot enumerate this FormData implementation on desktop');
  }
  const fields = [];
  let file = null;
  for (const entry of entries) {
    const value = entry.value;
    // RN 文件项：{ uri, name, type }
    if (value && typeof value === 'object' && typeof value.uri === 'string') {
      file = {
        path: String(value.uri),
        fieldName: String(entry.name || 'file'),
        name: String(value.name || 'upload.bin'),
        mime: String(value.type || 'application/octet-stream'),
      };
      continue;
    }
    fields.push({ name: String(entry.name), value: String(value === undefined ? '' : value) });
  }
  if (typeof Blob !== 'undefined' && body && !file) {
    // 没有文件项、却是真 FormData：本适配不支持 Blob 上传。明确拒绝，
    // 避免把 Blob 变成 "[object Object]" 发出去。
    const hasBlob = entries.some(entry => typeof Blob !== 'undefined' && entry.value instanceof Blob);
    if (hasBlob) throw new Error('fetch(FormData): Blob uploads are not supported on desktop');
  }
  return { fields, file };
}

function headersToObject(headers) {
  const result = {};
  if (!headers) return result;
  // 用行为判据而不是 `instanceof Headers`：Headers 在 Node 测试环境不存在，
// `instanceof` 右侧的裸标识符会触发 no-undef（且 typeof 守卫并不能救它）。
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    headers.forEach((value, key) => { result[String(key)] = String(value); });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2) result[String(pair[0])] = String(pair[1]);
    }
    return result;
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) result[String(key)] = String(value);
  }
  return result;
}

/**
 * 用主进程的流式 http 通道发一次请求，把全部响应块拼成文本。
 * 返回一个最小 Response 形状（status/ok/text()/json()/headers.get）。
 */
export function createFetch(bridge) {
  return function desktopFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input && input.url ? input.url : '');
    const options = init && typeof init === 'object' ? init : {};
    const method = String(options.method || 'GET').toUpperCase();
    const headers = headersToObject(options.headers);
    const rawBody = options.body;

    let payloadBody = null;
    if (rawBody != null) {
      // 两种识别方式：
      //   1. 真 FormData（浏览器/我们的 polyfill）；
      //   2. 带 `_parts` 的对象——RN 的 FormData 就是这个形状，共享层按 RN 约定构造
      //      （transcription.js）。桌面没有 RN runtime，所以形状判据是必需的，
      //      否则上传会在「既不是 FormData 也不是字符串」的缝隙里被 String() 成
      //      "[object Object]" 发出去。
      const isFormData = (typeof FormData !== 'undefined' && rawBody instanceof FormData)
        || Array.isArray(rawBody._parts);
      if (isFormData) {
        payloadBody = { multipart: formDataToMultipart(rawBody) };
        // Content-Type 由主进程按 boundary 重设：这里删掉渲染层可能设的那个。
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-type') delete headers[key];
        }
      } else {
        payloadBody = String(rawBody);
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let status = 0;
      const chunks = [];
      let requestId = null;
      let unsubscribe = null;
      const cleanup = () => {
        if (unsubscribe) unsubscribe();
        unsubscribe = null;
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const text = chunks.join('');
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url,
          text: async () => text,
          json: async () => JSON.parse(text),
          headers: { get: name => headers[String(name).toLowerCase()] || null },
        });
      };

      // 早到事件不能丢：status/chunk 可能先于 start() 的返回值到达（主进程先发事件、
// 后回 requestId 是允许的）。XHR 垫片用 seq 去重，这里用同样的思路：
// requestId 为 null 时先缓存事件，拿到 id 后只回放属于该 id 的那些。
      let pending = [];
      unsubscribe = bridge.http.onEvent(event => {
        if (!event) return;
        if (requestId === null) {
          pending.push(event);
          return;
        }
        if (event.requestId !== requestId) return;
        switch (event.type) {
          case 'status':
            status = Number(event.status) || 0;
            break;
          case 'chunk':
            chunks.push(String(event.text || ''));
            break;
          case 'done':
            finish();
            break;
          case 'error':
            fail(new Error(event.error || 'network error'));
            break;
          case 'abort': {
            const abortError = new Error('request aborted');
            abortError.name = 'AbortError';
            fail(abortError);
            break;
          }
          default:
            break;
        }
      });

      // ABORT 支持：共享层的转写用 AbortController 做超时兜底。
      if (options.signal) {
        if (options.signal.aborted) {
          fail(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
          return;
        }
        options.signal.addEventListener('abort', () => {
          if (requestId !== null) bridge.http.abort(requestId);
          fail(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
        }, { once: true });
      }

      bridge.http.start({ method, url, headers, body: payloadBody })
        .then(result => {
          requestId = result && result.requestId;
          // 回放早到的事件（只处理属于本次请求的）。
          const early = pending;
          pending = [];
          for (const event of early) {
            if (!event || event.requestId !== requestId) continue;
            if (event.type === 'status') status = Number(event.status) || 0;
            else if (event.type === 'chunk') chunks.push(String(event.text || ''));
            else if (event.type === 'done') finish();
            else if (event.type === 'error') fail(new Error(event.error || 'network error'));
            else if (event.type === 'abort') {
              const abortError = new Error('request aborted');
              abortError.name = 'AbortError';
              fail(abortError);
            }
          }
        })
        .catch(error => fail(error));
    });
  };
}

export default { createFetch, formDataToMultipart };