// 本地微压缩（Z 系采纳 #5）：旧长消息就地截断，近期/system/短消息不动。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MICROCOMPACT_HEAD_CHARS,
  MICROCOMPACT_KEEP_RECENT,
  MICROCOMPACT_MARKER,
  MICROCOMPACT_TAIL_CHARS,
  microcompactMessages,
} from '../src/chat/microcompact.js';

const longText = n => 'x'.repeat(n);

test('旧的长消息被截断：保留首尾 + 明确标记', () => {
  const messages = [{ role: 'assistant', text: longText(5000) }];
  const result = microcompactMessages(messages, { keepRecent: 0 });
  assert.equal(result.compacted, true);
  assert.equal(result.compactedCount, 1);
  const out = result.messages[0].text;
  assert.ok(out.startsWith('x'.repeat(MICROCOMPACT_HEAD_CHARS)));
  assert.ok(out.endsWith('x'.repeat(MICROCOMPACT_TAIL_CHARS)));
  assert.ok(out.includes(MICROCOMPACT_MARKER));
  assert.ok(out.length < 5000);
  assert.equal(result.savedChars, 5000 - out.length);
});

test('最近 keepRecent 条不动（工作台不能被压）', () => {
  const messages = [
    { role: 'assistant', text: longText(5000) },
    { role: 'user', text: longText(5000) },
  ];
  const result = microcompactMessages(messages, { keepRecent: 1 });
  assert.equal(result.compactedCount, 1);
  assert.equal(result.messages[0].text.length < 5000, true, '旧的被压');
  assert.equal(result.messages[1].text.length, 5000, '最近的保持原样');
});

test('system 消息不动（人设/世界书/格式约束）', () => {
  const messages = [
    { role: 'system', text: longText(9000) },
    { role: 'assistant', text: longText(5000) },
  ];
  const result = microcompactMessages(messages, { keepRecent: 0 });
  assert.equal(result.messages[0].text.length, 9000);
  assert.equal(result.messages[1].text.length < 5000, true);
});

test('短消息不动；无改动时返回同一引用（零成本判断压不动）', () => {
  const messages = [{ role: 'assistant', text: 'hi' }];
  const result = microcompactMessages(messages);
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages, '无改动必须返回同一引用');
});

test('content 字段变体同样处理', () => {
  const messages = [{ role: 'user', content: longText(4000) }];
  const result = microcompactMessages(messages, { keepRecent: 0 });
  assert.equal(result.compacted, true);
  assert.equal(result.messages[0].content.length < 4000, true);
  assert.equal(result.messages[0].text, undefined);
});

test('其余字段保留（id/时间戳等不被丢掉）', () => {
  const messages = [{ id: 'm1', role: 'assistant', text: longText(3000), timestamp: 123 }];
  const result = microcompactMessages(messages, { keepRecent: 0 });
  assert.equal(result.messages[0].id, 'm1');
  assert.equal(result.messages[0].timestamp, 123);
});

test('默认 keepRecent 为 8：前 N-8 条才会被压', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'assistant', text: longText(3000), id: `m${i}` }));
  const result = microcompactMessages(messages);
  assert.equal(result.compactedCount, 12 - MICROCOMPACT_KEEP_RECENT);
});
