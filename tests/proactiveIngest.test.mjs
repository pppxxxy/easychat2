// 主动消息落库领域（Z 系采纳 #9 外提）：written/skipped/deferred 分流 + 槽绑定。假依赖直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import { ingestProactiveMessagesInto } from '../src/context/proactiveIngest.js';

function deps(overrides = {}) {
  const bound = [];
  return {
    bound,
    characters: [{ id: 'c1' }, { id: 'c2' }],
    getProactiveSettings: async () => ({ slots: [] }),
    appendProactiveMessage: async (roleId, incoming) => ({ sessionId: `sess-${roleId}`, created: false, incoming }),
    bindProactiveSlotSession: async (slotId, sessionId) => { bound.push([slotId, sessionId]); },
    ...overrides,
  };
}

test('空列表：全空返回，不触达存储', async () => {
  let called = 0;
  const result = await ingestProactiveMessagesInto({
    messages: [],
    getProactiveSettings: async () => { called += 1; return { slots: [] }; },
  });
  assert.deepEqual(result, { written: [], skipped: [], deferred: [], targetSessions: {} });
  assert.equal(called, 0);
});

test('缺 id 忽略；缺 roleId 记 skipped；角色不在库记 deferred', async () => {
  const result = await ingestProactiveMessagesInto({
    ...deps(),
    messages: [
      { roleId: 'c1', text: 'no id' },
      { id: 'm2', text: 'no role' },
      { id: 'm3', roleId: 'ghost', text: 'x' },
    ],
  });
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.skipped, ['m2']);
  assert.deepEqual(result.deferred, ['m3']);
});

test('写入成功：记 written 与 targetSessions；onWritten 只在有写入时调', async () => {
  let writtenCalls = 0;
  const result = await ingestProactiveMessagesInto({
    ...deps(),
    messages: [{ id: 'm1', roleId: 'c1', text: 'hi' }],
    onWritten: async () => { writtenCalls += 1; },
  });
  assert.deepEqual(result.written, ['m1']);
  assert.deepEqual(result.targetSessions, { c1: 'sess-c1' });
  assert.equal(writtenCalls, 1);
});

test('append 拒写（无 sessionId）→ skipped；抛错 → deferred', async () => {
  const result = await ingestProactiveMessagesInto({
    ...deps({
      appendProactiveMessage: async roleId => (
        roleId === 'c2' ? null : { sessionId: 's', created: false }
      ),
    }),
    messages: [
      { id: 'm1', roleId: 'c1', text: 'ok' },
      { id: 'm2', roleId: 'c2', text: 'rejected' },
    ],
  });
  assert.deepEqual(result.written, ['m1']);
  assert.deepEqual(result.skipped, ['m2']);
  assert.deepEqual(result.deferred, []);

  const thrown = await ingestProactiveMessagesInto({
    ...deps({ appendProactiveMessage: async () => { throw new Error('write failed'); } }),
    messages: [{ id: 'm1', roleId: 'c1', text: 'x' }],
  });
  assert.deepEqual(thrown.deferred, ['m1']);
});

test('首次新建会话：绑定槽，且同批后续消息复用新会话', async () => {
  const calls = [];
  const base = deps({
    getProactiveSettings: async () => ({ slots: [{ slotId: 'slot1', sessionTargetId: '' }] }),
    appendProactiveMessage: async (roleId, incoming) => {
      calls.push(incoming.sessionTargetId);
      // 第一条新建会话，后续复用
      return { sessionId: calls.length === 1 ? 'new-sess' : incoming.sessionTargetId, created: calls.length === 1 };
    },
  });
  const result = await ingestProactiveMessagesInto({
    ...base,
    messages: [
      { id: 'm1', roleId: 'c1', slotId: 'slot1', text: 'a' },
      { id: 'm2', roleId: 'c1', slotId: 'slot1', text: 'b' },
    ],
  });
  assert.deepEqual(result.written, ['m1', 'm2']);
  assert.deepEqual(base.bound, [['slot1', 'new-sess']]);
  assert.equal(calls[0], '', '第一条还没绑定 → 空目标');
  assert.equal(calls[1], 'new-sess', '同批第二条复用刚新建的会话');
});
