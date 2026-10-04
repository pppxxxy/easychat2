import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProactiveMessageId,
  mergeProactiveMessage,
  normalizePendingMessages,
} from '../src/proactive/proactiveInbox.js';

test('buildProactiveMessageId：slotId + 本地日期', () => {
  const id = buildProactiveMessageId('slot-abc', new Date(2026, 8, 29, 10, 30));
  assert.equal(id, 'slot-abc-2026-09-29');
});

test('buildProactiveMessageId：空 slotId / 非法日期返回空串', () => {
  assert.equal(buildProactiveMessageId('', new Date()), '');
  assert.equal(buildProactiveMessageId('   ', new Date()), '');
  assert.equal(buildProactiveMessageId('slot', new Date('invalid')), '');
});

test('mergeProactiveMessage：追加为 assistant 消息并标记 proactive', () => {
  const next = mergeProactiveMessage([], {
    id: 'slot-1-2026-09-29',
    text: '  早上好  ',
    timestamp: 1000,
  });
  assert.equal(next.length, 1);
  assert.deepEqual(next[0], {
    id: 'slot-1-2026-09-29',
    role: 'assistant',
    text: '早上好',
    timestamp: 1000,
    proactive: true,
  });
});

test('mergeProactiveMessage：同 id 幂等，不重复追加', () => {
  const first = mergeProactiveMessage([], { id: 'x', text: 'hi' });
  const again = mergeProactiveMessage(first, { id: 'x', text: 'hi again' });
  assert.equal(again.length, 1);
  assert.equal(again[0].text, 'hi');
});

test('mergeProactiveMessage：空 id / 空文本不写入', () => {
  assert.deepEqual(mergeProactiveMessage([], { id: '', text: 'hi' }), []);
  assert.deepEqual(mergeProactiveMessage([], { id: 'x', text: '   ' }), []);
  assert.deepEqual(mergeProactiveMessage([], null), []);
});

test('mergeProactiveMessage：保留已有消息顺序', () => {
  const existing = [{ id: 'a', role: 'user', text: 'hi' }];
  const next = mergeProactiveMessage(existing, { id: 'b', text: 'yo', timestamp: 5 });
  assert.equal(next.length, 2);
  assert.equal(next[0].id, 'a');
  assert.equal(next[1].id, 'b');
});

// 新架构 Interop 下原生 consumePendingMessages 返回值形态不定：这里锁定各形态都要能取到消息，
// 否则 Array.isArray 不成立会静默丢消息（曾导致主动消息永不落库）。
test('normalizePendingMessages：普通数组原样返回', () => {
  const list = [{ id: 'x', roleId: 'r' }];
  assert.equal(normalizePendingMessages(list), list);
});

test('normalizePendingMessages：JSON 字符串解析为数组（原生新契约）', () => {
  const json = JSON.stringify([{ id: 'x', roleId: 'r', text: 'hi', createdAt: 1 }]);
  const list = normalizePendingMessages(json);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'x');
});

test('normalizePendingMessages：类数组 HostObject 按 length/索引取出', () => {
  // 模拟 JSI 返回的类数组对象：Array.isArray 为 false，但有 length 与数字索引
  const host = { 0: { id: 'a', roleId: 'r' }, 1: { id: 'b', roleId: 'r' }, length: 2 };
  const list = normalizePendingMessages(host);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'a');
  assert.equal(list[1].id, 'b');
});

test('normalizePendingMessages：单条消息对象兜底', () => {
  const list = normalizePendingMessages({ id: 'x', roleId: 'r', text: 'hi' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'x');
});

test('normalizePendingMessages：空/非法/异常输入返回空数组', () => {
  assert.deepEqual(normalizePendingMessages(null), []);
  assert.deepEqual(normalizePendingMessages(undefined), []);
  assert.deepEqual(normalizePendingMessages(''), []);
  assert.deepEqual(normalizePendingMessages('not json'), []);
  assert.deepEqual(normalizePendingMessages('{}'), []);
  assert.deepEqual(normalizePendingMessages({ length: 0 }), []);
  assert.deepEqual(normalizePendingMessages(42), []);
});
