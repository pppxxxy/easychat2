import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMediaMessage,
  getMessagePromptText,
} from '../src/chatMedia.js';

test('媒体消息保留空正文并生成名称提示', () => {
  const image = createMediaMessage({
    id: 'image-1',
    uri: 'file:///image.jpg',
    name: '照片.jpg',
  });
  assert.equal(image.text, '');
  assert.match(getMessagePromptText(image), /照片\.jpg/);

  const sticker = createMediaMessage({
    id: 'sticker-1',
    kind: 'sticker',
    uri: 'file:///sticker.jpg',
    stickerId: 'sticker-1',
    stickerName: '开心',
  });
  assert.match(getMessagePromptText(sticker), /表情包：开心/);
  const renamedSticker = {
    ...sticker,
    image: { ...sticker.image, name: '原始文件.jpg' },
  };
  assert.match(getMessagePromptText(renamedSticker), /表情包：开心/);
});
