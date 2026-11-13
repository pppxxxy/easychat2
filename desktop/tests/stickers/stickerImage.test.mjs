// 表情包缩放尺寸（与 Android 0.5 倍口径一致）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { STICKER_SCALE, base64ToBytes, defaultStickerName, stickerSize } from '../../src/stickers/stickerImage.js';

test('stickerSize：按 0.5 缩放并至少 1px', () => {
  assert.deepEqual(stickerSize(200, 120), { width: 100, height: 60 });
  assert.deepEqual(stickerSize(1, 1), { width: 1, height: 1 });
  assert.deepEqual(stickerSize(0, 0), { width: 1, height: 1 });
  assert.equal(STICKER_SCALE, 0.5);
});

test('base64ToBytes：还原字节', () => {
  const bytes = base64ToBytes('aGVsbG8=');
  assert.deepEqual([...bytes], [...Buffer.from('hello')]);
});

test('defaultStickerName：去扩展名并截断', () => {
  assert.equal(defaultStickerName('开心.png'), '开心');
  assert.equal(defaultStickerName('a.b.jpeg'), 'a.b');
  assert.equal(defaultStickerName(''), '');
  assert.equal(defaultStickerName('x'.repeat(80)).length, 40);
});
