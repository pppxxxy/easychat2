// 运行时命令队列（Z 系采纳 #6）：类型/优先级/批量/带外取消。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_PRIORITY, createCommandQueue } from '../src/agent/runtime/commandQueue.js';

test('enqueue：有效命令返回 id；空正文的 prompt/steering 返回 null', () => {
  const q = createCommandQueue();
  assert.equal(typeof q.enqueue({ mode: 'prompt', text: '你好' }), 'string');
  assert.equal(q.enqueue({ mode: 'prompt', text: '   ' }), null);
  assert.equal(q.enqueue({ mode: 'steering', text: '' }), null);
  // 通知类允许空正文（payload 承载）
  assert.equal(typeof q.enqueue({ mode: 'notification', payload: { id: 1 } }), 'string');
  assert.equal(q.size(), 2);
});

test('优先级：now > next > later；同级 FIFO', () => {
  const q = createCommandQueue();
  q.enqueue({ mode: 'prompt', text: 'later', priority: 'later' });
  q.enqueue({ mode: 'prompt', text: 'next-1', priority: 'next' });
  q.enqueue({ mode: 'prompt', text: 'now', priority: 'now' });
  q.enqueue({ mode: 'prompt', text: 'next-2', priority: 'next' });
  assert.equal(q.dequeue().text, 'now');
  assert.equal(q.dequeue().text, 'next-1');
  assert.equal(q.dequeue().text, 'next-2');
  assert.equal(q.dequeue().text, 'later');
  assert.equal(q.dequeue(), undefined);
});

test('默认优先级是 next', () => {
  const q = createCommandQueue();
  q.enqueue({ mode: 'prompt', text: 'a' });
  assert.equal(q.snapshot()[0].priority, 'next');
  assert.equal(COMMAND_PRIORITY.next, 1);
});

test('dequeue(maxPriority)：只取不超过上限的（now 上限只取 now）', () => {
  const q = createCommandQueue();
  q.enqueue({ mode: 'prompt', text: 'next', priority: 'next' });
  assert.equal(q.dequeue('now'), undefined, '只有 next 时 now 上限取不到');
  assert.equal(q.dequeue('next').text, 'next');
});

test('dequeueBatch：按 mode 批量取同优先级', () => {
  const q = createCommandQueue();
  q.enqueue({ mode: 'notification', payload: 1, priority: 'later' });
  q.enqueue({ mode: 'notification', payload: 2, priority: 'later' });
  q.enqueue({ mode: 'prompt', text: 'x', priority: 'later' });
  const batch = q.dequeueBatch('later', 'notification');
  assert.equal(batch.length, 2);
  assert.equal(q.size(), 1, '只取走了通知，prompt 还在');
  assert.equal(q.peek().mode, 'prompt');
});

test('peek 不取出；removeById 精确删除', () => {
  const q = createCommandQueue();
  const id = q.enqueue({ mode: 'prompt', text: 'a' });
  assert.equal(q.peek().text, 'a');
  assert.equal(q.size(), 1);
  assert.equal(q.removeById(id).text, 'a');
  assert.equal(q.removeById('nope'), undefined);
});

test('cancel-pending：标记与消费', () => {
  const q = createCommandQueue();
  const id = q.enqueue({ mode: 'prompt', text: 'a' });
  q.markCancelPending(id);
  assert.equal(q.consumeCancelPending(id), true);
  assert.equal(q.consumeCancelPending(id), false, '消费一次即清');
});

test('countByMode / clear', () => {
  const q = createCommandQueue();
  q.enqueue({ mode: 'steering', text: 'a' });
  q.enqueue({ mode: 'steering', text: 'b' });
  q.enqueue({ mode: 'prompt', text: 'c' });
  assert.equal(q.countByMode('steering'), 2);
  q.clear();
  assert.equal(q.size(), 0);
});
