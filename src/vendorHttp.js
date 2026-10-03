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
 * @param {boolean} [options.nativeTimeout] 用 XHR 原生 `xhr.timeout` + `ontimeout`
 *        计时（设置页模型检测），替代模块内的 setTimeout 空闲计时。
 * @param {{ cancel: (() => void) | null }} [options.cancelHandle] 外部取消句柄：
 *        模块在 open 后写入 `cancelHandle.cancel`（触发取消并 reject），结算时清为 null。
 *        供不经 AbortSignal、而是由调用方持有取消入口的场景（设置页模型检测）复用。
 * @param {() => Error} [options.onCancelError] 外部句柄取消时的错误构造，默认同 onAbortError。
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
    nativeTimeout = false,
    cancelHandle = null,
    onCancelError = onAbortError,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(onAbortError(true));
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
      if (cancelHandle) cancelHandle.cancel = null;
      fn(value);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortFlagOnSignal) canceled = true;
      if (cancelHandle) cancelHandle.cancel = null;
      safeAbort(xhr);
      reject(onAbortError(canceled));
    };

    // 原生超时模式不挂 JS 计时器，改由 xhr.timeout/ontimeout 处理（clearTimeout(undefined) 为 no-op）。
    const timer = nativeTimeout ? undefined : setTimeout(() => {
      if (timeoutAbortOrder === 'finishThenAbort') {
        finish(reject, onTimeoutError());
        safeAbort(xhr);
        return;
      }
      if (settled) return;
      // 默认顺序 abortThenReject：先置 settled 让 xhr.onabort 触发时 finish 成为 no-op，
      // 再 abort，最后 reject 超时错误。同时补齐 finish 的清理（移除 abort 监听、
      // 清空 cancelHandle），否则超时后监听器会残留、cancelHandle 仍指向已结算闭包。
      settled = true;
      clearTimeout(timer);
      if (removeAbortListener) {
        removeAbortListener();
        removeAbortListener = null;
      }
      if (cancelHandle) cancelHandle.cancel = null;
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
    if (nativeTimeout) {
      xhr.timeout = timeoutMs || defaultTimeoutMs;
      xhr.ontimeout = () => finish(reject, onTimeoutError());
    }
    if (cancelHandle) {
      cancelHandle.cancel = () => {
        finish(reject, onCancelError());
        safeAbort(xhr);
      };
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
