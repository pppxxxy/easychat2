import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProactiveMessageId,
  mergeProactiveMessage,
} from '../src/proactiveInbox.js';

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
