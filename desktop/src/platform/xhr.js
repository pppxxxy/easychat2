// XMLHttpRequest 适配（design.md「适配层契约 4」）：只实现 src/network/api.js 用到的子集。
//
// 用到的成员（逐项核对过 api.js）：open / setRequestHeader / send / abort /
// status / responseText（getter）/ onprogress / onload / onerror / onabort。
//
// 事件顺序保证：主进程保证 status -> 若干 chunk -> 恰好一次 done/error；
// 这里再用单调递增 seq 丢弃乱序/重复块（IPC 理论上保序，但崩溃恢复与多通道不担保）。
// 语义细节：chunk 与 onprogress 不依赖 status——api.js 的 drainIncremental 判据是
// `!xhr.status || 2xx`，明确允许 status 尚未到达时的早到增量；abort 在已结算后
// 不再触发 onabort（对齐 RN 的 XHR 行为，见 api.js:491 注释）。
import { createLazyDefault } from './bridge.js';

export function createXHRFactory(bridge) {
  return class DesktopXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.onprogress = null;
      this.onload = null;
      this.onerror = null;
      this.onabort = null;
      this._text = '';
      this._headers = {};
      this._method = 'GET';
      this._url = '';
      this._requestId = null;
      this._unsubscribe = null;
      this._settled = false;
      this._aborted = false;
      this._lastSeq = 0;
    }

    get responseText() {
      return this._text;
    }

    open(method, url) {
      this._method = String(method || 'GET');
      this._url = String(url || '');
      this.readyState = 1;
    }

    setRequestHeader(name, value) {
      this._headers[String(name)] = String(value);
    }

    send(body) {
      if (this._settled || this._requestId !== null) return;
      this._unsubscribe = bridge.http.onEvent(event => this._onEvent(event));
      bridge.http.start({
        method: this._method,
        url: this._url,
        headers: this._headers,
        body: body == null ? null : String(body),
      }).then(result => {
        this._requestId = result && result.requestId;
        // 极端竞态：abort 在 start 返回前被调用 —— 补发中止。
        if (this._aborted) bridge.http.abort(this._requestId);
      }).catch(error => this._fail(error));
    }

    abort() {
      if (this._settled) return;
      this._aborted = true;
      if (this._requestId !== null) bridge.http.abort(this._requestId);
      // 主进程会回 http:abort；若请求尚未建立（start 前），这里直接结算。
      if (this._requestId === null) this._emitAbort();
    }

    _onEvent(event) {
      if (!event || event.requestId !== this._requestId) return;
      switch (event.type) {
        case 'status':
          this.status = Number(event.status) || 0;
          break;
        case 'chunk': {
          if (this._settled) return;
          if (typeof event.seq === 'number') {
            if (event.seq <= this._lastSeq) return; // 乱序/重复块丢弃
            this._lastSeq = event.seq;
          }
          this._text += String(event.text || '');
          if (typeof this.onprogress === 'function') this.onprogress();
          break;
        }
        case 'done':
          if (this._settle()) {
            this.readyState = 4;
            if (typeof this.onload === 'function') this.onload();
          }
          break;
        case 'error':
          this._fail(new Error((event && event.error) || 'xhr error'));
          break;
        case 'abort':
          this._emitAbort();
          break;
        default:
          break;
      }
    }

    _settle() {
      if (this._settled) return false;
      this._settled = true;
      if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
      }
      return true;
    }

    _fail(error) {
      if (!this._settle()) return;
      this.readyState = 4;
      if (typeof this.onerror === 'function') this.onerror(error);
    }

    _emitAbort() {
      if (!this._settle()) return;
      this.readyState = 4;
      if (typeof this.onabort === 'function') this.onabort();
    }
  };
}

export default createLazyDefault(createXHRFactory);
