import test from 'node:test';
import assert from 'node:assert/strict';

import { clampMarkdownText, MAX_MARKDOWN_CHARS } from '../src/chat/markdownGuard.js';

test('未超长时原样返回', () => {
  const text = '普通回复';
  const result = clampMarkdownText(text);
  assert.equal(result.text, text);
  assert.equal(result.truncated, false);
});

test('超过上限时截断并附提示', () => {
  const text = 'a'.repeat(MAX_MARKDOWN_CHARS + 500);
  const result = clampMarkdownText(text);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length < text.length);
  assert.ok(result.text.startsWith('a'.repeat(100)));
  assert.ok(result.text.includes('已截断'));
  // 截断后的可渲染正文不含超出的部分
  const body = result.text.split('\n\n…')[0];
  assert.equal(body, 'a'.repeat(MAX_MARKDOWN_CHARS));
});

test('恰好等于上限不截断', () => {
  const text = 'a'.repeat(MAX_MARKDOWN_CHARS);
  assert.equal(clampMarkdownText(text).truncated, false);
});

test('自定义上限生效', () => {
  const result = clampMarkdownText('abcdef', 3);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith('abc'));
});

test('空值/非字符串安全处理', () => {
  assert.equal(clampMarkdownText(null).text, '');
  assert.equal(clampMarkdownText(undefined).text, '');
  assert.equal(clampMarkdownText(42).text, '42');
});
