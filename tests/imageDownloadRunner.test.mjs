import test from 'node:test';
import assert from 'node:assert/strict';

import { runImageDownloads } from '../src/chat/imageDownloadRunner.js';

test('成功：逐张下载并追加图片消息（role=assistant）', async () => {
  const appended = [];
  const downloaded = [];
  await runImageDownloads({
    urls: ['https://a.com/1.png', 'https://a.com/2.png'],
    isCurrentSession: () => true,
    download: async url => {
      downloaded.push(url);
      return { uri: `file:///chat-images/${url.slice(-5)}`, mime: 'image/png', width: 10, height: 20 };
    },
    appendMessage: message => appended.push(message),
    failedText: url => `失败 ${url}`,
  });
  assert.deepEqual(downloaded, ['https://a.com/1.png', 'https://a.com/2.png']);
  assert.equal(appended.length, 2);
  assert.ok(appended.every(item => item.kind === 'image' && item.role === 'assistant' && item.image.uri));
});

test('失败：追加一条失败提示文本', async () => {
  const appended = [];
  await runImageDownloads({
    urls: ['https://a.com/x.png'],
    isCurrentSession: () => true,
    download: async () => { throw new Error('boom'); },
    appendMessage: message => appended.push(message),
    failedText: url => `图片下载失败：${url}`,
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].role, 'assistant');
  assert.equal(appended[0].kind, undefined);
  assert.match(appended[0].text, /图片下载失败/);
});

test('切走会话：下载完成但已非当前会话时不再追加', async () => {
  let alive = true;
  const appended = [];
  await runImageDownloads({
    urls: ['https://a.com/1.png', 'https://a.com/2.png'],
    isCurrentSession: () => alive,
    download: async () => {
      alive = false;
      return { uri: 'u', mime: 'image/png', width: 1, height: 1 };
    },
    appendMessage: message => appended.push(message),
    failedText: () => 'fail',
  });
  assert.equal(appended.length, 0);
});

test('空 urls：什么都不做', async () => {
  const appended = [];
  await runImageDownloads({
    urls: [],
    isCurrentSession: () => true,
    download: async () => ({}),
    appendMessage: message => appended.push(message),
    failedText: () => '',
  });
  assert.equal(appended.length, 0);
});
