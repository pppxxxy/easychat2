// 主进程 multipart 组装（语音转写上传通道）行为测试。
//
// 这条通道是新增的：既有 HTTP 代理只写字符串体（api.js 全用 JSON）。转写要把本地
// 音频当文件字段发出去，所以多了两条分支。这里钉住三件安全/正确性要紧的事：
//   1. 字节格式必须是合法 multipart（边界、CRLF、字段顺序）；
//   2. 文件路径必须过白名单（否则渲染层能借这条通道读任意文件）；
//   3. 非 multipart 的请求体完全不受影响（既有 JSON 请求不能被改坏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildMultipart,
  createHttpProxy,
  normalizeMultipart,
} from '../../electron/ipc/http.js';

test('normalizeMultipart：只认 { multipart: {...} }，其余返回 null', () => {
  assert.equal(normalizeMultipart('{"a":1}'), null);
  assert.equal(normalizeMultipart(null), null);
  assert.equal(normalizeMultipart({ multipart: null }), null);
  // 无文件的 multipart（纯字段）也成立：返回 file: null。
  const noFile = normalizeMultipart({ multipart: { fields: [{ name: 'model', value: 'whisper-1' }] } });
  assert.deepEqual(noFile, { fields: [{ name: 'model', value: 'whisper-1' }], file: null });
  // 文件字段补默认值。
  const withFile = normalizeMultipart({
    multipart: { fields: [], file: { path: 'C:/docs/a.m4a' } },
  });
  assert.equal(withFile.file.fieldName, 'file');
  assert.equal(withFile.file.mime, 'application/octet-stream');
});

test('buildMultipart：字节格式正确（边界、CRLF、字段顺序 file 先 model 后）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-mp-'));
  const audio = path.join(dir, 'a.m4a');
  fs.writeFileSync(audio, Buffer.from([1, 2, 3]));

  const encoded = buildMultipart(
    {
      fields: [{ name: 'model', value: 'whisper-1' }],
      file: { path: audio, fieldName: 'file', name: 'a.m4a', mime: 'audio/m4a' },
    },
    { boundary: 'BOUND' }
  );
  assert.equal(encoded.headers['Content-Type'], 'multipart/form-data; boundary=BOUND');
  const text = encoded.buffer.toString('latin1');
  // 文件段在前，model 段在后（与手机端 FormData 的 append 顺序一致）。
  assert.ok(text.indexOf('name="file"; filename="a.m4a"') < text.indexOf('name="model"'));
  assert.ok(text.startsWith('--BOUND\r\n'), '必须以边界开头');
  assert.ok(text.endsWith('--BOUND--\r\n'), '必须以结束边界结尾');
  assert.ok(text.includes('Content-Type: audio/m4a'), '缺文件 MIME');
  // 文件字节必须原样嵌入。
  const head = encoded.buffer.indexOf(Buffer.from([1, 2, 3]));
  assert.ok(head > 0, '文件内容未嵌入');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildMultipart：文件名里的引号/换行被剥掉（不能破坏头部）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-mp-'));
  const audio = path.join(dir, 'x.bin');
  fs.writeFileSync(audio, Buffer.from([9]));
  const encoded = buildMultipart({
    fields: [],
    file: {
      path: audio,
      fieldName: 'file',
      name: 'bad"name\r\nInjected: 1.bin',
      mime: 'application/octet-stream',
    },
  }, { boundary: 'B' });
  const lines = encoded.buffer.toString('latin1').split('\r\n');
  // 判定看**头部结构**，不看子串：注入文本被中和后仍会留在 filename 值里
  //（变成 "bad_name__Injected: 1.bin"，本身无害）；危险的是它变成独立的头部行。
  const disposition = lines[1] || '';
  assert.ok(disposition.startsWith('Content-Disposition: form-data;'), '第 2 行应是 Content-Disposition');
  assert.equal(lines[2], 'Content-Type: application/octet-stream', '头部只应有这两行');
  // 引号必须成对闭合，不能被文件名里的引号提前截断。
  assert.equal((disposition.match(/"/g) || []).length, 4, '引号应成对（fieldName 与 filename 各一对）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start：文件路径必须过 resolver，未提供 resolver 时拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-mp-'));
  const outside = path.join(os.tmpdir(), 'outside-secret.txt');
  fs.writeFileSync(outside, 'secret');
  fs.writeFileSync(path.join(dir, 'inside.m4a'), Buffer.from([1]));

  const writes = [];
  const fakeRequest = {
    setTimeout() {},
    on() {},
    setHeader() {},
    write: chunk => writes.push(chunk),
    end() {},
    destroy() {},
  };
  const fakeHttp = { request: () => fakeRequest };
  const events = [];
  const proxy = createHttpProxy({
    sendEvent: event => events.push(event),
    httpModule: fakeHttp,
    httpsModule: fakeHttp,
    resolver: {
      resolve: uri => {
        const resolved = path.resolve(uri);
        if (!resolved.startsWith(path.resolve(dir))) throw new Error('outside root');
        return resolved;
      },
    },
  });

  proxy.start({
    method: 'POST',
    url: 'http://localhost/x',
    body: {
      multipart: {
        fields: [{ name: 'model', value: 'whisper-1' }],
        file: { path: path.join(dir, 'inside.m4a'), fieldName: 'file', name: 'a.m4a', mime: 'audio/m4a' },
      },
    },
  });
  assert.ok(writes.length >= 1, '应写出 multipart 体');

  // 白名单外：必须抛错（渲染层不得借这条通道读任意文件）。
  assert.throws(() => proxy.start({
    method: 'POST',
    url: 'http://localhost/x',
    body: {
      multipart: {
        fields: [],
        file: { path: outside, fieldName: 'file', name: 's.txt', mime: 'text/plain' },
      },
    },
  }), /outside root/);

  // 没有 resolver 的代理：带文件的 multipart 一律拒绝。
  const bareProxy = createHttpProxy({ sendEvent: () => {}, httpModule: fakeHttp, httpsModule: fakeHttp });
  assert.throws(() => bareProxy.start({
    method: 'POST',
    url: 'http://localhost/x',
    body: { multipart: { fields: [], file: { path: path.join(dir, 'inside.m4a') } } },
  }), /path resolver/);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test('start：字符串体仍按原样写（既有 JSON 请求不受影响）', () => {
  const writes = [];
  const fakeRequest = {
    setTimeout() {},
    on() {},
    setHeader() {},
    write: chunk => writes.push(chunk),
    end() {},
    destroy() {},
  };
  const fakeHttp = { request: () => fakeRequest };
  const proxy = createHttpProxy({ sendEvent: () => {}, httpModule: fakeHttp, httpsModule: fakeHttp });
  proxy.start({ method: 'POST', url: 'http://localhost/x', body: '{"a":1}' });
  assert.deepEqual(writes, ['{"a":1}']);
});