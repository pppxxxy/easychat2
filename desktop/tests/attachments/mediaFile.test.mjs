// 桌面附件命名（与主进程 mediaPick 同口径）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachmentFileName,
  extensionOf,
  imageExtension,
  videoExtension,
} from '../../src/attachments/mediaFile.js';

test('imageExtension：按扩展名/ MIME 归一为可落盘后缀', () => {
  assert.equal(imageExtension('a.JPEG'), 'jpg');
  assert.equal(imageExtension('a.png'), 'png');
  assert.equal(imageExtension('blob', 'image/webp'), 'webp');
  assert.equal(imageExtension('no-ext', ''), 'jpg');
});

test('videoExtension：覆盖常见容器', () => {
  assert.equal(videoExtension('a.mov'), 'mov');
  assert.equal(videoExtension('a.webm'), 'webm');
  assert.equal(videoExtension('blob', 'video/x-matroska'), 'mkv');
  assert.equal(videoExtension('a.bin', 'video/mp4'), 'mp4');
});

test('attachmentFileName：kind 前缀 + 时间戳 + 随机后缀', () => {
  assert.equal(attachmentFileName('image', 'a.png', '', 1700000000000, 0.123456), 'image-1700000000000-123456.png');
  assert.equal(attachmentFileName('video', 'a.MOV', '', 1, 0.5), 'video-1-5.mov');
  assert.equal(attachmentFileName('image', '无名', 'image/jpeg', 2, 0.9), 'image-2-9.jpg');
});

test('extensionOf：无扩展名返回空串', () => {
  assert.equal(extensionOf('a.b.c'), 'c');
  assert.equal(extensionOf('a.'), '');
  assert.equal(extensionOf(''), '');
});
