import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractStickerDirectives,
  resolveStickerNames,
} from '../src/stickerDirectives.js';

test('名称清单去重、trim、过滤空串并保持顺序', () => {
  const names = resolveStickerNames([
    { name: ' 开心 ' },
    { name: '惊讶' },
    { name: '开心' },
    { name: '' },
    null,
    { name: 42 },
  ]);
  assert.deepEqual(names, ['开心', '惊讶', '42']);
  assert.deepEqual(resolveStickerNames(null), []);
});

test('命中白名单的标记被剥离并收集', () => {
  const result = extractStickerDirectives(
    '今天真开心呀\n[[表情包:开心]]\n我们出去玩吧',
    ['开心', '惊讶']
  );
  assert.deepEqual(result.stickers, ['开心']);
  assert.equal(result.text.includes('[[表情包'), false);
  assert.ok(result.text.includes('今天真开心呀'));
  assert.ok(result.text.includes('我们出去玩吧'));
});

test('白名单外的标记被丢弃且保留原样', () => {
  const result = extractStickerDirectives('看这个 [[表情包:不存在]]', ['开心']);
  assert.deepEqual(result.stickers, []);
  assert.ok(result.text.includes('[[表情包:不存在]]'));
});

test('一条回复可含多个标记，各自收集', () => {
  const result = extractStickerDirectives(
    '[[表情包:开心]]\n然后又\n[[表情包:惊讶]]',
    ['开心', '惊讶']
  );
  assert.deepEqual(result.stickers, ['开心', '惊讶']);
  assert.equal(result.text.includes('[[表情包'), false);
});

test('全角冒号与空格容错', () => {
  const result = extractStickerDirectives('[[ 表情包 ： 开心 ]]', ['开心']);
  assert.deepEqual(result.stickers, ['开心']);
  assert.equal(result.text, '');
});

test('白名单为空时不做解析，原样返回', () => {
  const input = '文字 [[表情包:开心]]';
  const result = extractStickerDirectives(input, []);
  assert.deepEqual(result.stickers, []);
  assert.equal(result.text, input);
});

test('剥离后收敛多余空行', () => {
  const result = extractStickerDirectives('A\n\n[[表情包:开心]]\n\nB', ['开心']);
  assert.equal(result.text, 'A\n\nB');
});
