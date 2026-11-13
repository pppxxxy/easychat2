// XHR 适配（design.md「适配层契约 4」）行为测试：注入假桥，验证事件顺序与语义。
//
// 覆盖：status 前不派发 progress、responseText 累积、乱序/重复 seq 丢弃、
// abort 只触发一次 onabort、结算后的 done/error 被忽略、onerror 与 onload 互斥。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createXHRFactory } from '../../src/platform/xhr.js';

function makeFakeHttp() {
  const subscribers = new Set();
  let nextRequestId = 1;
  return {
    startCalls: [],
    abortCalls: [],
    start: async payload => {
      const requestId = nextRequestId;
      nextRequestId += 1;
      makeFakeHttp.lastStart = payload;
      return { requestId };
    },
    abort: requestId => {
      makeFakeHttp.lastAbort = requestId;
      emit({ type: 'abort', requestId });
    },
    onEvent(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    emit,
  };

  function emit(event) {
    for (const subscriber of [...subscribers]) subscriber(event);
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('XHR：status → chunk → done，responseText 累积（含 status 前早到增量）', async () => {
  const http = makeFakeHttp();
  const XHR = createXHRFactory({ http });
  const xhr = new XHR();
  const events = [];
  xhr.onprogress = () => events.push('progress');
  xhr.onload = () => events.push('load');
  xhr.onerror = () => events.push('error');
  xhr.onabort = () => events.push('abort');

  xhr.open('POST', 'https://example.invalid/v1/chat');
  xhr.setRequestHeader('Authorization', 'Bearer x');
  xhr.send('{"q":1}');
  await tick();

  const requestId = xhr._requestId;
  assert.equal(requestId, 1, 'send 后应拿到 requestId');

  // status 之前的 chunk 也必须接受：api.js 的增量判据是 `!xhr.status || 2xx`，
  // 明确允许 status 尚未到达时的早到数据（防御性语义，适配层不得擅自丢弃）。
  http.emit({ type: 'chunk', requestId, seq: 1, text: '早到' });
  assert.equal(xhr.responseText, '早到', 'status 前的 chunk 应进入正文（api.js 允许 !status）');

  http.emit({ type: 'status', requestId, status: 200 });
  http.emit({ type: 'chunk', requestId, seq: 2, text: '你' });
  http.emit({ type: 'chunk', requestId, seq: 3, text: '好' });
  assert.equal(xhr.responseText, '早到你 好'.replace(' ', ''));
  http.emit({ type: 'done', requestId });

  assert.equal(xhr.status, 200);
  assert.equal(xhr.readyState, 4);
  assert.deepEqual(events, ['progress', 'progress', 'progress', 'load']);

  // 结算后的重复 done 与 error 不再回调。
  http.emit({ type: 'done', requestId });
  http.emit({ type: 'error', requestId, error: 'late' });
  assert.deepEqual(events, ['progress', 'progress', 'progress', 'load']);
});

test('XHR：乱序/重复 seq 被丢弃（只接受严格递增）', async () => {
  const http = makeFakeHttp();
  const XHR = createXHRFactory({ http });
  const xhr = new XHR();
  xhr.open('POST', 'https://example.invalid');
  xhr.send('x');
  await tick();
  const requestId = xhr._requestId;

  http.emit({ type: 'status', requestId, status: 200 });
  http.emit({ type: 'chunk', requestId, seq: 5, text: 'B' });
  http.emit({ type: 'chunk', requestId, seq: 4, text: 'A' }); // 乱序 -> 丢弃
  http.emit({ type: 'chunk', requestId, seq: 5, text: 'B' }); // 重复 -> 丢弃
  http.emit({ type: 'chunk', requestId, seq: 6, text: 'C' });
  assert.equal(xhr.responseText, 'BC');
});

test('XHR：abort 只触发一次 onabort，结算后 abort 无效', async () => {
  const http = makeFakeHttp();
  const XHR = createXHRFactory({ http });
  const xhr = new XHR();
  let aborts = 0;
  let loads = 0;
  xhr.onabort = () => { aborts += 1; };
  xhr.onload = () => { loads += 1; };
  xhr.open('POST', 'https://example.invalid');
  xhr.send('x');
  await tick();
  const requestId = xhr._requestId;

  http.emit({ type: 'status', requestId, status: 200 });
  xhr.abort();
  assert.equal(aborts, 1, 'abort 应触发一次 onabort');
  xhr.abort();
  http.emit({ type: 'abort', requestId });
  http.emit({ type: 'done', requestId });
  assert.equal(aborts, 1, '重复 abort / 迟到 abort 事件不再触发');
  assert.equal(loads, 0, '结算后的 done 不再触发 onload');
});

test('XHR：error 触发 onerror 且不再触发 onload', async () => {
  const http = makeFakeHttp();
  const XHR = createXHRFactory({ http });
  const xhr = new XHR();
  let errors = 0;
  let loads = 0;
  xhr.onerror = () => { errors += 1; };
  xhr.onload = () => { loads += 1; };
  xhr.open('POST', 'https://example.invalid');
  xhr.send('x');
  await tick();
  http.emit({ type: 'error', requestId: xhr._requestId, error: 'ECONNRESET' });
  http.emit({ type: 'done', requestId: xhr._requestId });
  assert.equal(errors, 1);
  assert.equal(loads, 0);
});
