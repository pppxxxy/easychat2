import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAssistantReplyParts } from '../src/chat/assistantReply.js';

const stickers = [
  { id: 's1', name: '开心', uri: 'file:///stickers/a.jpg', mime: 'image/jpeg', width: 100, height: 100 },
];

test('纯文本：只产出文字消息，无图片下载', () => {
  const { parts, imageDownloads } = buildAssistantReplyParts({ replyText: '你好呀', stickers: [] });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].role, 'assistant');
  assert.equal(parts[0].text, '你好呀');
  assert.deepEqual(imageDownloads, []);
});

test('表情包指令：开关开启且命中白名单时产出表情包媒体消息（role 覆盖为 assistant）', () => {
  const { parts } = buildAssistantReplyParts({
    replyText: '[[表情包:开心]]',
    stickers,
    sticker: { enabled: true, chance: 1 },
  });
  const media = parts.find(item => item.kind === 'sticker');
  assert.ok(media, '应有表情包消息');
  assert.equal(media.role, 'assistant');
  assert.equal(media.image.uri, 'file:///stickers/a.jpg');
});

test('表情包开关关闭：指令被剥离但不产出表情包消息', () => {
  const { parts } = buildAssistantReplyParts({
    replyText: '你好 [[表情包:开心]]',
    stickers,
    sticker: { enabled: false, chance: 1 },
  });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].text, '你好');
  assert.equal(parts.some(item => item.kind === 'sticker'), false);
});

test('概率未命中：指令被剥离但不产出表情包消息', () => {
  const { parts } = buildAssistantReplyParts({
    replyText: '你好 [[表情包:开心]]',
    stickers,
    sticker: { enabled: true, chance: 0.5 },
    random: 0.9,
  });
  assert.equal(parts.some(item => item.kind === 'sticker'), false);
  assert.equal(parts[0].text, '你好');
});

test('位置「上方」：表情包排在文字消息之前；默认在文字之后', () => {
  const above = buildAssistantReplyParts({
    replyText: '你好 [[表情包:开心]]',
    stickers,
    sticker: { enabled: true, chance: 1, position: 'above' },
  }).parts;
  assert.equal(above[0].kind, 'sticker');
  assert.equal(above[above.length - 1].text, '你好');

  const below = buildAssistantReplyParts({
    replyText: '你好 [[表情包:开心]]',
    stickers,
    sticker: { enabled: true, chance: 1 },
  }).parts;
  assert.equal(below[0].text, '你好');
  assert.equal(below[below.length - 1].kind, 'sticker');
});

test('开关关闭：图片指令不解析，原样留在正文', () => {
  const text = '看这个 <download_image:https://a.com/x.png>';
  const { parts, imageDownloads } = buildAssistantReplyParts({ replyText: text, stickers: [], downloadEnabled: false });
  assert.equal(parts[0].text, text);
  assert.deepEqual(imageDownloads, []);
});

test('开关开启：剥离指令、收集 URL', () => {
  const { parts, imageDownloads } = buildAssistantReplyParts({
    replyText: '看这个 <download_image:https://a.com/x.png> 好看吗',
    stickers: [],
    downloadEnabled: true,
  });
  assert.equal(parts[0].text, '看这个  好看吗');
  assert.deepEqual(imageDownloads, ['https://a.com/x.png']);
});

test('表情包 + 图片下载可同时解析', () => {
  const { parts, imageDownloads } = buildAssistantReplyParts({
    replyText: '[[表情包:开心]] <download_image:https://a.com/y.jpg>',
    stickers,
    downloadEnabled: true,
    sticker: { enabled: true, chance: 1 },
  });
  assert.ok(parts.some(item => item.kind === 'sticker'));
  assert.deepEqual(imageDownloads, ['https://a.com/y.jpg']);
});

test('无正文且无媒体：返回空 parts', () => {
  const { parts } = buildAssistantReplyParts({ replyText: '   ', stickers: [] });
  assert.deepEqual(parts, []);
});
