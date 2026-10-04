import test from 'node:test';
import assert from 'node:assert/strict';
import vendorXhr from '../src/network/vendorHttp.js';

function installXhr(Impl) {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Impl;
  return () => { globalThis.XMLHttpRequest = original; };
}

function baseOptions(overrides = {}) {
  return {
    method: 'GET',
    url: 'https://example.test/api',
    defaultTimeoutMs: 1000,
    onTimeoutError: () => new Error('timeout'),
    onAbortError: () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      return e;
    },
    onNetworkError: () => new Error('network'),
    onHttpError: status => new Error(`http ${status}`),
    parse: xhr => JSON.parse(xhr.responseText || '{}'),
    onParseError: () => new Error('parse'),
    ...overrides,
  };
}

test('vendorXhr 成功解析并设置头部', async () => {
  const seen = { headers: {}, method: null, body: undefined };
  class Xhr {
    open(method) { seen.method = method; }
    setRequestHeader(k, v) { seen.headers[k] = v; }
    send(body) {
      seen.body = body;
      this.status = 200;
      this.responseText = JSON.stringify({ ok: 1 });
      queueMicrotask(() => this.onload && this.onload());
    }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    const data = await vendorXhr(baseOptions({ headers: { Authorization: 'Bearer x' } }));
    assert.deepEqual(data, { ok: 1 });
    assert.equal(seen.method, 'GET');
    assert.equal(seen.headers.Authorization, 'Bearer x');
    assert.equal(seen.body, null);
  } finally {
    restore();
  }
});

test('vendorXhr 非 2xx 走 onHttpError', async () => {
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 503;
      queueMicrotask(() => this.onload && this.onload());
    }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    await assert.rejects(vendorXhr(baseOptions()), /http 503/);
  } finally {
    restore();
  }
});

test('vendorXhr parse 抛错走 onParseError', async () => {
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = 'not-json';
      queueMicrotask(() => this.onload && this.onload());
    }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    await assert.rejects(vendorXhr(baseOptions()), /parse/);
  } finally {
    restore();
  }
});

test('vendorXhr onerror 走 onNetworkError', async () => {
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onerror && this.onerror()); }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    await assert.rejects(vendorXhr(baseOptions()), /network/);
  } finally {
    restore();
  }
});

test('vendorXhr 原生 onabort 走 onAbortEventError（可区分 canceled）', async () => {
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onabort && this.onabort()); }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    await assert.rejects(
      vendorXhr(baseOptions({
        onAbortEventError: canceled => new Error(canceled ? 'canceled' : 'server-abort'),
      })),
      /server-abort/,
    );
  } finally {
    restore();
  }
});

test('vendorXhr signal 已中止时立即 reject', async () => {
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() { throw new Error('不应发送'); }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(vendorXhr(baseOptions({ signal: controller.signal })), { name: 'AbortError' });
  } finally {
    restore();
  }
});

test('vendorXhr signal 触发时中止请求并 reject AbortError', async () => {
  let aborted = false;
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() {}
    abort() {
      aborted = true;
      if (this.onabort) this.onabort();
    }
  }
  const restore = installXhr(Xhr);
  try {
    const controller = new AbortController();
    const promise = vendorXhr(baseOptions({
      signal: controller.signal,
      abortFlagOnSignal: true,
      onAbortEventError: canceled => new Error(canceled ? 'canceled' : 'server-abort'),
    }));
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(aborted, true);
  } finally {
    restore();
  }
});

test('vendorXhr 超时顺序：abortThenReject 默认', async () => {
  const order = [];
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { order.push('abort'); if (this.onabort) this.onabort(); }
  }
  const restore = installXhr(Xhr);
  try {
    await assert.rejects(
      vendorXhr(baseOptions({
        timeoutMs: 5,
        onTimeoutError: () => { order.push('reject'); return new Error('timeout'); },
      })),
      /timeout/,
    );
    assert.deepEqual(order.slice(0, 2), ['abort', 'reject']);
  } finally {
    restore();
  }
});

test('vendorXhr 超时顺序：finishThenAbort', async () => {
  const order = [];
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { order.push('abort'); if (this.onabort) this.onabort(); }
  }
  const restore = installXhr(Xhr);
  try {
    await assert.rejects(
      vendorXhr(baseOptions({
        timeoutMs: 5,
        timeoutAbortOrder: 'finishThenAbort',
        onTimeoutError: () => { order.push('reject'); return new Error('timeout'); },
      })),
      /timeout/,
    );
    assert.deepEqual(order.slice(0, 2), ['reject', 'abort']);
  } finally {
    restore();
  }
});

test('vendorXhr responseType 在 open 后设置', async () => {
  let responseType;
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() {
      responseType = this.responseType;
      this.status = 200;
      this.response = new ArrayBuffer(0);
      queueMicrotask(() => this.onload && this.onload());
    }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    await vendorXhr(baseOptions({ responseType: 'arraybuffer', parse: () => 'ok' }));
    assert.equal(responseType, 'arraybuffer');
  } finally {
    restore();
  }
});

test('vendorXhr send 抛错时 reject 原始错误', async () => {
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() { throw new Error('boom'); }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    await assert.rejects(vendorXhr(baseOptions()), /boom/);
  } finally {
    restore();
  }
});

test('vendorXhr nativeTimeout：设置 xhr.timeout 并由 ontimeout 拒绝（不挂 JS 计时器）', async () => {
  let instance = null;
  class Xhr {
    constructor() { instance = this; }
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { if (this.onabort) this.onabort(); }
  }
  const restore = installXhr(Xhr);
  try {
    const promise = vendorXhr(baseOptions({
      nativeTimeout: true,
      timeoutMs: 15000,
      onTimeoutError: () => new Error('超时'),
    }));
    await Promise.resolve();
    assert.equal(instance.timeout, 15000);
    instance.ontimeout();
    await assert.rejects(promise, /超时/);
  } finally {
    restore();
  }
});

test('vendorXhr cancelHandle：外部调用 cancel 触发拒绝并在结算后清空', async () => {
  let instance = null;
  class Xhr {
    constructor() { instance = this; }
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { if (this.onabort) this.onabort(); }
  }
  const restore = installXhr(Xhr);
  try {
    const handle = { cancel: null };
    const promise = vendorXhr(baseOptions({
      nativeTimeout: true,
      timeoutMs: 1000,
      cancelHandle: handle,
      onCancelError: () => new Error('检测已取消'),
    }));
    await Promise.resolve();
    assert.equal(typeof handle.cancel, 'function');
    handle.cancel();
    await assert.rejects(promise, /检测已取消/);
    // 结算后句柄被清空，重复取消不会二次生效
    assert.equal(handle.cancel, null);
    assert.ok(instance);
  } finally {
    restore();
  }
});

test('vendorXhr cancelHandle：成功结算后清空句柄', async () => {
  class Xhr {
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = 'ok';
      queueMicrotask(() => this.onload && this.onload());
    }
    abort() {}
  }
  const restore = installXhr(Xhr);
  try {
    const handle = { cancel: null };
    const value = await vendorXhr(baseOptions({
      cancelHandle: handle,
      parse: xhr => xhr.responseText,
    }));
    assert.equal(value, 'ok');
    assert.equal(handle.cancel, null);
  } finally {
    restore();
  }
});
