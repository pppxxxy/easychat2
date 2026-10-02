// XHR 基础请求器：集中各厂商适配器（生图/播报/向量/搜索）共用的
// 「signal 预检 + settled 守卫 + 中止/超时 + 头部设置 + 错误文案」骨架。
//
// 只抽象骨架，不统一差异：HTTP 错误文案、成功解析、网络/超时/中断文案、
// 请求体编码、responseType、响应读取方式（responseText / response）、
// abort 触发时机（超时先 finish 再 abort 还是先 abort 再 reject）都由调用方
// 通过 options 传入，保证逐条行为不变。
//
// 说明：真正的流式 SSE（src/api.js 的 onprogress + cumulative responseText）
// 不在此列，单独保留。

function safeAbort(xhr) {
  try {
    xhr.abort();
  } catch (error) {}
}

function setHeaders(xhr, headers) {
  Object.entries(headers || {}).forEach(([key, value]) => {
    try {
      xhr.setRequestHeader(key, value);
    } catch (error) {}
  });
}

/**
 * @param {object} options
 * @param {string} [options.method] 默认 'GET'
 * @param {string} options.url
 * @param {object} [options.headers]
 * @param {*} [options.body] 传给 xhr.send 的内容；空值时发 null
 * @param {number} [options.timeoutMs]
 * @param {number} options.defaultTimeoutMs 兜底超时（调用方各自的常量）
 * @param {AbortSignal} [options.signal]
 * @param {() => Error} options.onTimeoutError 超时错误构造
 * @param {(canceled?:boolean) => Error} options.onAbortError 中断（含 signal 取消）
 *        错误构造；参数为「是否由 signal 取消触发」，imageGen 用它区分用户取消与服务端中断。
 * @param {(canceled?:boolean) => Error} [options.onAbortEventError] 原生 xhr.abort
 *        事件（可能由超时/外部 abort 触发）的错误构造，默认同 onAbortError。
 *        tts 用它区分「signal 取消=AbortError」与「服务端中断=播报已中断」。
 * @param {() => Error} options.onNetworkError onerror 错误构造
 * @param {(status:number) => Error} options.onHttpError 非 2xx 错误构造
 * @param {(xhr) => *} options.parse 200 时从 xhr 解析成功值，可抛错
 * @param {() => Error} options.onParseError parse 抛错时的错误构造
 * @param {'finishThenAbort'|'abortThenReject'} [options.timeoutAbortOrder]
 *        超时处理顺序：'finishThenAbort' 先 finish(reject) 再 xhr.abort()（imageGen）；
 *        默认 'abortThenReject' 先 abort 再 reject（webSearch/vector/tts）。
 * @param {boolean} [options.abortFlagOnSignal] imageGen 在 signal 取消时置 canceled
 *        标记供 onabort 区分「用户取消」与「服务端中断」。
 * @param {string} [options.responseType] 设置 xhr.responseType（如 'arraybuffer'）。
 */
export default function xhrRequest(options) {
  const {
    method = 'GET',
    url,
    headers,
    body,
    timeoutMs,
    defaultTimeoutMs,
    signal = null,
    onTimeoutError,
    onAbortError,
    onAbortEventError = onAbortError,
    onNetworkError,
    onHttpError,
    parse,
    onParseError,
    timeoutAbortOrder = 'abortThenReject',
    abortFlagOnSignal = false,
    responseType,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(onAbortError(false));
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    let canceled = false;
    let removeAbortListener = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (removeAbortListener) {
        removeAbortListener();
        removeAbortListener = null;
      }
      fn(value);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortFlagOnSignal) canceled = true;
      safeAbort(xhr);
      reject(onAbortError(canceled));
    };

    const timer = setTimeout(() => {
      if (timeoutAbortOrder === 'finishThenAbort') {
        finish(reject, onTimeoutError());
        safeAbort(xhr);
        return;
      }
      if (settled) return;
      settled = true;
      safeAbort(xhr);
      reject(onTimeoutError());
    }, timeoutMs || defaultTimeoutMs);

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }

    xhr.open(method, url);
    if (responseType !== undefined) {
      try {
        xhr.responseType = responseType;
      } catch (error) {}
    }
    setHeaders(xhr, headers);

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(reject, onHttpError(xhr.status));
        return;
      }
      try {
        finish(resolve, parse(xhr));
      } catch (error) {
        finish(reject, onParseError(error));
      }
    };
    xhr.onerror = () => finish(reject, onNetworkError());
    xhr.onabort = () => finish(reject, onAbortEventError(canceled));

    try {
      xhr.send(body || null);
    } catch (error) {
      finish(reject, error);
    }
  });
}
