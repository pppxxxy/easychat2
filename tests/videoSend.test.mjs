// 视频附件预处理（src/chat/videoSend.js）：行为测试。
//
// 这段编排 2026-10 从 useChatSend 外提（该文件顶到行数基线），所以这里要把抽出前的
// 行为逐条钉住——尤其是**独立 base64 预算**：视频请求体大得多，与图片共用一份额度
// 会让一条视频把图片的额度连带吃光。
//
// 打桩方式：真实模块 + Module._load 注入假的 attachments/chatMedia（避免 expo-file-system）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const MAX_VIDEO_BASE64_BYTES = 16 * 1024 * 1024;

let readResult = '';
let readError = null;
let readCalls = 0;
const attachmentsStub = {
  MAX_VIDEO_BASE64_BYTES,
  readVideoDataUri: async () => {
    readCalls += 1;
    if (readError) throw readError;
    return readResult;
  },
};
const chatMediaStub = {
  createMediaMessage: ({ id, kind, uri, mime, name, width, height, timestamp }) => ({
    id, role: 'user', kind, text: '', image: { uri, mime, name, width, height }, timestamp,
  }),
};

const stubs = {
  [path.resolve('src/chat/attachments.js')]: attachmentsStub,
  [path.resolve('src/chat/chatMedia.js')]: chatMediaStub,
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  if (typeof request === 'string' && request.startsWith('.') && parent && parent.filename) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (Object.prototype.hasOwnProperty.call(stubs, resolved)) return stubs[resolved];
  }
  return originalLoad.call(this, request, parent, isMain);
};

const sourcePath = path.resolve('src/chat/videoSend.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const runtime = new Module(sourcePath);
runtime.filename = sourcePath;
runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
runtime._compile(transformed, sourcePath);
const { prepareVideoMessages } = runtime.exports;

const okInfo = size => async () => ({ exists: true, size });

function reset() {
  readResult = 'data:video/mp4;base64,AAAA';
  readError = null;
  readCalls = 0;
}

test('正常：每条视频读成 data URI 并建 video 消息，时间戳按 offset 递增', async () => {
  reset();
  const prepared = await prepareVideoMessages(
    [{ uri: 'file:///v1.mp4', mime: 'video/mp4', name: '一' }, { uri: 'file:///v2.mp4', mime: 'video/mp4', name: '二' }],
    { now: 1000, indexOffset: 3, maxVideoBytes: 100 * 1024 * 1024, getFileInfo: okInfo(1024) }
  );
  assert.equal(prepared.ok, true);
  assert.equal(prepared.messages.length, 2);
  assert.equal(prepared.messages[0].message.kind, 'video');
  assert.equal(prepared.messages[0].message.id, '1000-video-0');
  assert.equal(prepared.messages[0].message.timestamp, 1003, '时间戳从 indexOffset 起算');
  assert.equal(prepared.messages[1].message.timestamp, 1004);
  assert.ok(prepared.messages[0].dataUri.startsWith('data:video/mp4;base64,'));
  assert.equal(readCalls, 2);
});

test('文件不存在：reason=missing（由调用方给「视频已失效」提示）', async () => {
  reset();
  const prepared = await prepareVideoMessages([{ uri: 'file:///gone.mp4' }], {
    maxVideoBytes: 100 * 1024 * 1024,
    getFileInfo: async () => ({ exists: false }),
  });
  assert.deepEqual({ ok: prepared.ok, reason: prepared.reason }, { ok: false, reason: 'missing' });
  assert.equal(readCalls, 0, '文件不存在不该去读内容');
});

test('getFileInfo 抛错：也按 missing 处理（不把异常抛给发送流程）', async () => {
  reset();
  const prepared = await prepareVideoMessages([{ uri: 'file:///x.mp4' }], {
    maxVideoBytes: 100 * 1024 * 1024,
    getFileInfo: async () => { throw new Error('boom'); },
  });
  assert.equal(prepared.reason, 'missing');
});

test('单条超限：reason=too-large', async () => {
  reset();
  const prepared = await prepareVideoMessages([{ uri: 'file:///big.mp4' }], {
    maxVideoBytes: 1024,
    getFileInfo: okInfo(2048),
  });
  assert.equal(prepared.reason, 'too-large');
  assert.equal(readCalls, 0);
});

test('独立 base64 预算：总量超限即中止（不与图片共用额度）', async () => {
  reset();
  // 估算 = size * 4/3。让第一条就超过预算。
  const huge = Math.ceil(MAX_VIDEO_BASE64_BYTES * 0.8);
  const prepared = await prepareVideoMessages([{ uri: 'file:///v.mp4' }], {
    maxVideoBytes: huge + 1,
    getFileInfo: okInfo(huge),
  });
  assert.equal(prepared.reason, 'total-too-large');
  assert.equal(readCalls, 0, '预算不够时不该读内容');
});

test('读内容失败：reason=read-failed（由调用方给「视频读取失败」提示）', async () => {
  reset();
  readError = new Error('io');
  const prepared = await prepareVideoMessages([{ uri: 'file:///v.mp4' }], {
    maxVideoBytes: 100 * 1024 * 1024,
    getFileInfo: okInfo(1024),
  });
  assert.equal(prepared.reason, 'read-failed');
});

test('取消 / 会话已切换：返回对应 reason，调用方据此静默中止', async () => {
  reset();
  const canceled = await prepareVideoMessages([{ uri: 'file:///v.mp4' }], {
    maxVideoBytes: 100 * 1024 * 1024,
    getFileInfo: okInfo(1024),
    isCanceled: () => true,
  });
  assert.equal(canceled.reason, 'canceled');

  reset();
  const changed = await prepareVideoMessages([{ uri: 'file:///v.mp4' }], {
    maxVideoBytes: 100 * 1024 * 1024,
    getFileInfo: okInfo(1024),
    isGuardCurrent: () => false,
  });
  assert.equal(changed.reason, 'guard-changed');
});

test('实际 base64 比估算大时按真实值补记（估算不能成为绕过预算的口子）', async () => {
  reset();
  // 估算很小（size=1 → 2 字节），但真实 data URI 超出预算 → 必须被真实值拦下。
  // 预算判据比的是**解码后的字节数**（base64Length * 3/4），所以这里要构造解码后
  // 超过预算的 base64：长度取 4/3 * 预算 + 余量。
  readResult = `data:video/mp4;base64,${'A'.repeat(Math.ceil(MAX_VIDEO_BASE64_BYTES * 4 / 3) + 64)}`;
  const prepared = await prepareVideoMessages([{ uri: 'file:///v.mp4' }], {
    maxVideoBytes: 100 * 1024 * 1024,
    getFileInfo: okInfo(1),
  });
  assert.equal(prepared.reason, 'total-too-large');
});

test('空列表：ok=true 且没有消息（调用方不必特判）', async () => {
  reset();
  const prepared = await prepareVideoMessages([], { maxVideoBytes: 1024 });
  assert.deepEqual({ ok: prepared.ok, count: prepared.messages.length }, { ok: true, count: 0 });
});
