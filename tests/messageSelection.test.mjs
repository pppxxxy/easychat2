import test from 'node:test';
import assert from 'node:assert/strict';

import { getEditResendPlan, removeMessagesByIds, toggleMessageSelection } from '../src/messageSelection.js';

test('消息选择支持添加、移除与重复选择', () => {
  assert.deepEqual(toggleMessageSelection([], 'a'), ['a']);
  assert.deepEqual(toggleMessageSelection(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleMessageSelection(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleMessageSelection(['a'], ''), ['a']);
});

test('批量删除只移除选中的消息并保持原顺序', () => {
  const messages = [
    { id: 'a', text: '第一条' },
    { id: 'b', text: '第二条' },
    { id: 'c', text: '第三条' },
  ];
  assert.deepEqual(removeMessagesByIds(messages, ['a', 'c']), [messages[1]]);
  assert.deepEqual(removeMessagesByIds(messages, []), messages);
  assert.equal(messages.length, 3);
});

test('修改重发计划撤回目标消息及后续回复并回填文字', () => {
  const messages = [
    { id: 'a', role: 'user', text: '上一条消息' },
    { id: 'b', role: 'assistant', text: '上一轮回复' },
    { id: 'c', role: 'user', text: '当前消息' },
  ];
  assert.deepEqual(getEditResendPlan(messages, 'c'), {
    text: '当前消息',
    messages: messages.slice(0, 2),
  });
  assert.equal(getEditResendPlan(messages, 'b'), null);
  assert.equal(getEditResendPlan([{ id: 'image', role: 'user', image: {} }], 'image'), null);
});
