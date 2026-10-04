// 本地模型上下文预算纯函数测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTextTokens,
  trimMessagesToContext,
} from '../src/localModel/localContext.js';

test('estimateTextTokens：CJK 计 1/字，其余按 4 字符/token', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('你好世界'), 4);
  assert.equal(estimateTextTokens('abcd'), 1);
  assert.equal(estimateTextTokens('abcdefgh'), 2);
});

test('estimateMessageTokens：数组内容含图片/音频模态占用', () => {
  assert.ok(estimateMessageTokens({ role: 'user', content: 'hi' }) >= 4);
  const withImage = estimateMessageTokens({
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:...' } }],
  });
  assert.ok(withImage >= 256, '图片按固定 token 计入');
});

test('trimMessagesToContext：未超预算原样返回', () => {
  const messages = [
    { role: 'system', content: '人设' },
    { role: 'user', content: '你好' },
  ];
  const result = trimMessagesToContext(messages, { contextSize: 2048 });
  assert.equal(result.removedCount, 0);
  assert.equal(result.messages.length, 2);
});

test('trimMessagesToContext：超预算时保留 system + 最近轮，丢最旧', () => {
  const system = { role: 'system', content: 'system-prompt' };
  const history = [];
  for (let index = 0; index < 40; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: '这是一段较长的历史消息内容'.repeat(3) });
  }
  const messages = [system, ...history];
  const result = trimMessagesToContext(messages, { contextSize: 512, reserveOutputTokens: 128, minKeep: 2 });
  assert.ok(result.removedCount > 0, '必须发生裁剪');
  assert.equal(result.messages[0], system, 'system 恒保留在首位');
  assert.ok(result.messages.includes(history[history.length - 1]), '最新一条保留');
  assert.ok(result.messages.includes(history[history.length - 2]), '至少保留 minKeep 条最近的');
  assert.ok(result.messages.length < messages.length);
});

test('trimMessagesToContext：contextSize<=0 不裁剪', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(10000) }];
  const result = trimMessagesToContext(messages, { contextSize: 0 });
  assert.equal(result.removedCount, 0);
  assert.equal(result.messages.length, 1);
});

test('trimMessagesToContext：即便系统提示超预算也至少保留最后一条 user', () => {
  const messages = [
    { role: 'system', content: '巨大的系统提示'.repeat(100) },
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '最后的问题' },
  ];
  const result = trimMessagesToContext(messages, { contextSize: 128, minKeep: 1 });
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[result.messages.length - 1].content, '最后的问题');
});

test('estimateMessagesTokens：聚合所有消息', () => {
  const total = estimateMessagesTokens([
    { role: 'system', content: 'aaa' },
    { role: 'user', content: '你好' },
  ]);
  assert.ok(total >= 8);
});
