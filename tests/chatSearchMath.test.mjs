import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceMatchIndex, collectSearchMatchIds } from '../src/chat/chatSearchMath.js';

test('收集命中消息 id：只取 user/assistant 且按消息顺序', () => {
  const messages = [
    { id: 'm1', role: 'user', text: '你好世界' },
    { id: 'm2', role: 'system', text: '你好世界' },
    { id: 'm3', role: 'assistant', text: '世界你好' },
    { id: 'm4', role: 'user', text: '无关' },
  ];
  assert.deepEqual(collectSearchMatchIds(messages, '世界'), ['m1', 'm3']);
  assert.deepEqual(collectSearchMatchIds(messages, '  世界  '), ['m1', 'm3']);
  assert.deepEqual(collectSearchMatchIds(messages, 'WORLD'), []);
  assert.deepEqual(collectSearchMatchIds(messages, ''), []);
  assert.deepEqual(collectSearchMatchIds(null, 'x'), []);
});

test('收集命中消息 id：大小写不敏感且命中图片/表情包名', () => {
  const messages = [
    { id: 'a', role: 'user', text: 'HELLO' },
    { id: 'b', role: 'assistant', kind: 'image', image: { name: '风景照' }, text: '' },
  ];
  assert.deepEqual(collectSearchMatchIds(messages, 'hello'), ['a']);
  assert.deepEqual(collectSearchMatchIds(messages, '风景'), ['b']);
});

test('匹配下标循环推进：到底回头、到头回尾', () => {
  assert.equal(advanceMatchIndex(0, 1, 3), 1);
  assert.equal(advanceMatchIndex(2, 1, 3), 0);
  assert.equal(advanceMatchIndex(0, -1, 3), 2);
  assert.equal(advanceMatchIndex(5, 1, 3), 0);
  assert.equal(advanceMatchIndex(1, 0, 3), 1);
});

test('无命中时推进恒为 0，非法输入不抛错', () => {
  assert.equal(advanceMatchIndex(0, 1, 0), 0);
  assert.equal(advanceMatchIndex(2, 1, 0), 0);
  assert.equal(advanceMatchIndex(NaN, NaN, NaN), 0);
});
