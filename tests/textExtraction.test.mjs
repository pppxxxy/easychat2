import test from 'node:test';
import assert from 'node:assert/strict';

import { containsHtml, messageCopyText, toPlainText } from '../src/plainText.js';
import { toSpeechText } from '../src/speechText.js';

test('toPlainText 移除 script 内容而不是只删标签', () => {
  const text = '<div>正文</div><script>window.secret = "x"</script><style>body { color: red }</style>';
  const plain = toPlainText(text);
  assert.equal(plain.includes('window.secret'), false);
  assert.equal(plain.includes('color: red'), false);
  assert.equal(plain.includes('正文'), true);
});

test('messageCopyText 对 HTML 走纯文本，对普通文本原样返回', () => {
  assert.equal(messageCopyText('<p>你好</p><script>bad()</script>'), '你好');
  assert.equal(messageCopyText('普通文本'), '普通文本');
  assert.equal(containsHtml('<b>粗体</b>'), true);
  assert.equal(containsHtml('普通文本'), false);
});

test('toSpeechText 不朗读脚本、样式与 HTML 注释', () => {
  const speech = toSpeechText('你好<script>alert(1)</script><style>.a{}</style><!--隐藏--><b>世界</b>');
  assert.equal(speech.includes('alert'), false);
  assert.equal(speech.includes('.a{}'), false);
  assert.equal(speech.includes('隐藏'), false);
  assert.equal(speech.includes('你好'), true);
  assert.equal(speech.includes('世界'), true);
  assert.equal(toSpeechText('正文<script>未闭合内容').includes('未闭合内容'), false);
});