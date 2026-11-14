// fetch 适配层（platform/fetch.js）行为测试。
//
// 这层是「语音转写能否在桌面跑通」的唯一障碍点：共享层 src/transcription.js 用
// `fetch` + RN 形态的 `form.append('file', { uri, name, type })`。原生的
// Chromium fetch 装不下那种文件项（只认 Blob），且渲染层直连会撞 CSP/CORS。
//
// 用假 bridge 钉住：形状翻译、multipart 传递、事件时序（早到块不能丢）、
// 非 2xx 也要给出响应体（调用方要读服务端错误文案）、Abort 语义。
import test from 'node:test';
import assert from 'node:assert/strict';

import { formDataToMultipart, createFetch } from '../../src/platform/fetch.js';

// RN 形态的 FormData 最小替身：真实 RN 实现就是 `_parts` 数组。
function makeRNFormData(parts) {
  return { _parts: parts };
}

function makeBridge({ script = [] } = {}) {
  const starts = [];
  const emitted = [];
  let subscriber = null;
  let nextId = 1;
  const bridge = {
    http: {
      onEvent: fn => {
        subscriber = fn;
        return () => { subscriber = null; };
      },
      start: async payload => {
        const requestId = nextId;
        nextId += 1;
        starts.push({ requestId, payload });
        // 按脚本顺序发事件；默认一个成功响应。
        const events = script.length ? script : [
          { type: 'status', status: 200 },
          { type: 'chunk', seq: 1, text: '{"text":"' },
          { type: 'chunk', seq: 2, text: 'hello"}' },
          { type: 'done' },
        ];
        for (const event of events) {
          emitted.push({ ...event, requestId });
          if (subscriber) subscriber({ ...event, requestId });
        }
        return { requestId };
      },
      abort: () => {},
    },
  };
  return { bridge, starts, emitted };
}

test('formDataToMultipart：文件项翻成 {path}，其余当文本字段', () => {
  const form = makeRNFormData([
    ['file', { uri: 'file:///docs/voice/a.m4a', name: 'a.m4a', type: 'audio/m4a' }],
    ['model', 'whisper-1'],
  ]);
  const part = formDataToMultipart(form);
  assert.deepEqual(part.file, {
    path: 'file:///docs/voice/a.m4a',
    fieldName: 'file',
    name: 'a.m4a',
    mime: 'audio/m4a',
  });
  assert.deepEqual(part.fields, [{ name: 'model', value: 'whisper-1' }]);
});

test('formDataToMultipart：枚举不出来的 FormData 明确报错（不静默发空请求）', () => {
  // 浏览器原生 FormData（没有 _parts）：必须抛，而不是发一个「服务端说没收到文件」的空请求。
  assert.throws(() => formDataToMultipart({ append() {} }), /cannot enumerate/);
});

test('desktopFetch：FormData 走 multipart，普通字符串体原样传', async () => {
  const { bridge, starts } = makeBridge();
  const desktopFetch = createFetch(bridge);

  const form = makeRNFormData([
    ['file', { uri: 'file:///a.m4a', name: 'a.m4a', type: 'audio/m4a' }],
    ['model', 'whisper-1'],
  ]);
  const response = await desktopFetch('https://api.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer k', 'Content-Type': 'multipart/form-data' },
    body: form,
  });
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'hello' });

  const payload = starts[0].payload;
  assert.equal(payload.method, 'POST');
  assert.ok(payload.body.multipart, '应转成 multipart 载荷');
  assert.equal(payload.body.multipart.file.path, 'file:///a.m4a');
  // Content-Type 必须交给主进程按 boundary 重设，渲染层那个会与 boundary 冲突。
  assert.equal(payload.headers['Content-Type'], undefined);

  // 普通字符串体保持原样（api.js 的 JSON 请求全走这条，不能被改坏）。
  const { bridge: bridge2, starts: starts2 } = makeBridge();
  await createFetch(bridge2)('https://api.test/x', { method: 'POST', body: '{"a":1}' });
  assert.equal(starts2[0].payload.body, '{"a":1}');
});

test('desktopFetch：status 与 chunk 早于 start() 返回也不能丢', async () => {
  // 主进程可能先发事件、后回 requestId。丢了 status 会让 response.ok 永远 false。
  const starts = [];
  let subscriber = null;
  const bridge = {
    http: {
      onEvent: fn => { subscriber = fn; return () => { subscriber = null; }; },
      start: async payload => {
        starts.push(payload);
        // 先发（此时 requestId 还没回到渲染层），再返回 id。
        subscriber({ type: 'status', requestId: 42, status: 201 });
        subscriber({ type: 'chunk', requestId: 42, seq: 1, text: 'ok' });
        subscriber({ type: 'done', requestId: 42 });
        return { requestId: 42 };
      },
      abort: () => {},
    },
  };
  const response = await createFetch(bridge)('https://api.test/x');
  assert.equal(response.status, 201, '早到的 status 必须被回放');
  assert.equal(await response.text(), 'ok');
});

test('desktopFetch：非 2xx 也返回响应体（调用方要读服务端错误文案）', async () => {
  const { bridge } = makeBridge({
    script: [
      { type: 'status', status: 400 },
      { type: 'chunk', seq: 1, text: '{"error":{"message":"model not found"}}' },
      { type: 'done' },
    ],
  });
  const response = await createFetch(bridge)('https://api.test/x', { method: 'POST', body: '{}' });
  assert.equal(response.ok, false);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { message: 'model not found' } });
});

test('desktopFetch：AbortError 语义（转写靠它做超时兜底）', async () => {
  let abortedId = null;
  const bridge = {
    http: {
      onEvent: () => () => {},
      start: async () => ({ requestId: 7 }),
      abort: id => { abortedId = id; },
    },
  };
  const controller = new AbortController();
  const promise = createFetch(bridge)('https://api.test/x', {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
  });
  // 让 start() 的 then 先跑，确保 requestId 已就位。
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(promise, error => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(abortedId, 7, 'abort 必须转达给主进程');
});