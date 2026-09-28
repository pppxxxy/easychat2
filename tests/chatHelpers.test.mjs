import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildErrorRawText,
  buildGreetingMessage,
  buildInlineImagePrompt,
  buildQuotePayload,
  formatScrubberTime,
  getHttpStatus,
  messageTimestamp,
  settlePendingMessage,
} from '../src/chat/chatHelpers.js';
import {
  ASSISTANT_ID,
  INLINE_IMAGE_PROMPT_MAX,
  NO_BODY_TEXT,
  QUOTE_TEXT_MAX,
  THINKING_PLACEHOLDER,
  USER_ID,
} from '../src/chat/chatConstants.js';

test('常量与既有值一致', () => {
  assert.equal(USER_ID, 'user');
  assert.equal(ASSISTANT_ID, 'assistant');
  assert.equal(THINKING_PLACEHOLDER, '正在思考...');
  assert.equal(INLINE_IMAGE_PROMPT_MAX, 400);
  assert.equal(QUOTE_TEXT_MAX, 200);
  assert.equal(NO_BODY_TEXT, '（未生成正文）');
});

test('buildInlineImagePrompt：拼接风格前缀、压缩空白、按上限截断', () => {
  assert.equal(buildInlineImagePrompt('  雨中  的街道 ', '动漫风'), '动漫风, 雨中 的街道');
  assert.equal(buildInlineImagePrompt('场景', ''), '场景');
  assert.equal(buildInlineImagePrompt('', '只有前缀'), '只有前缀');
  assert.equal(buildInlineImagePrompt('', ''), '');
  const long = buildInlineImagePrompt('啊'.repeat(500), '', 10);
  assert.equal(long.length, 10);
});

test('buildQuotePayload：无 id 或空文本返回 null，超长截断加省略号', () => {
  assert.equal(buildQuotePayload(null, 'x'), null);
  assert.equal(buildQuotePayload({ text: 'hi' }, 'x'), null);
  assert.equal(buildQuotePayload({ id: '1', text: '   ' }, 'x'), null);
  const payload = buildQuotePayload({ id: 'm1', role: USER_ID, text: '你好' }, ' 甲 ');
  assert.deepEqual(payload, { id: 'm1', name: '甲', role: USER_ID, text: '你好' });
  const longText = '字'.repeat(QUOTE_TEXT_MAX + 50);
  const clipped = buildQuotePayload({ id: 'm2', text: longText }, '甲');
  assert.equal(clipped.text.length, QUOTE_TEXT_MAX + 1);
  assert.ok(clipped.text.endsWith('…'));
});

test('getHttpStatus：多来源取值，兜底 null', () => {
  assert.equal(getHttpStatus({ status: 500 }), 500);
  assert.equal(getHttpStatus({ statusCode: 404 }), 404);
  assert.equal(getHttpStatus({ response: { status: 401 } }), 401);
  assert.equal(getHttpStatus({}), null);
  assert.equal(getHttpStatus(null), null);
});

test('buildErrorRawText：拼接消息、状态码与堆栈', () => {
  const text = buildErrorRawText({ message: '失败', status: 503, stack: 'at foo' });
  assert.ok(text.includes('失败'));
  assert.ok(text.includes('HTTP 状态码: 503'));
  assert.ok(text.includes('at foo'));
  assert.equal(buildErrorRawText({}), '请检查 API 配置或网络连接。');
});

test('buildGreetingMessage：替换 {{user}} 占位，空文本返回 null', () => {
  assert.equal(buildGreetingMessage('s1', '', '甲'), null);
  assert.equal(buildGreetingMessage('s1', '   ', '甲'), null);
  const greeting = buildGreetingMessage('s1', '你好，{{user}}', '小明');
  assert.equal(greeting.id, 'greeting-s1');
  assert.equal(greeting.role, ASSISTANT_ID);
  assert.equal(greeting.text, '你好，小明');
  assert.equal(greeting.greetingTemplate, '你好，{{user}}');
  assert.equal(greeting.kind, 'greeting');
  // 无用户名时不替换
  assert.equal(buildGreetingMessage('s2', '你好，{{user}}', '').text, '你好，{{user}}');
});

test('formatScrubberTime：合法时间格式化，非法输入空串', () => {
  const value = new Date(2026, 0, 2, 9, 5).getTime();
  assert.equal(formatScrubberTime(value), '1月2日 09:05');
  assert.equal(formatScrubberTime(0), '');
  assert.equal(formatScrubberTime(-1), '');
  assert.equal(formatScrubberTime('abc'), '');
});

test('settlePendingMessage：有正文保留、纯占位移除、有思考保留并补正文', () => {
  const list = [
    { id: 'a', text: '正常' },
    { id: 'target', text: THINKING_PLACEHOLDER, pending: true, waitingForResponse: true },
  ];
  // 纯占位（无思考）整条移除
  assert.deepEqual(settlePendingMessage(list, 'target').map(m => m.id), ['a']);
  // 有正文：结算并清除 pending
  const settled = settlePendingMessage(
    [{ id: 'target', text: '回复', pending: true }],
    'target'
  );
  assert.equal(settled[0].pending, false);
  assert.equal(settled[0].waitingForResponse, false);
  assert.equal(settled[0].text, '回复');
  // 只有思考内容：保留并补“未生成正文”
  const reasoningOnly = settlePendingMessage(
    [{ id: 'target', text: THINKING_PLACEHOLDER, reasoning: '推理中', pending: true }],
    'target'
  );
  assert.equal(reasoningOnly[0].text, NO_BODY_TEXT);
  assert.equal(reasoningOnly[0].pending, false);
  // 非数组安全
  assert.deepEqual(settlePendingMessage(null, 'x'), []);
});

test('messageTimestamp：显式字段优先，退化为 id 前缀，否则 0', () => {
  assert.equal(messageTimestamp({ timestamp: 1700000000000 }), 1700000000000);
  assert.equal(messageTimestamp({ id: '1712345678901-abc' }), 1712345678901);
  assert.equal(messageTimestamp({ id: 'greeting-s1' }), 0);
  assert.equal(messageTimestamp(null), 0);
  // 显式字段非法时退化到 id
  assert.equal(messageTimestamp({ timestamp: 0, id: '1700000000000-x' }), 1700000000000);
});
