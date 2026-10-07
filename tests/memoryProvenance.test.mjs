// 记忆溯源纯逻辑：分组 / 来源解析 / 证据链（含源消息已消失的诚实降级）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvidenceChain,
  groupMemoriesBySession,
  isMemoryItem,
  listMemories,
  MAX_EVIDENCE_MESSAGES,
  memoryKey,
  memorySources,
  sessionIdsOf,
} from '../src/memory/provenance.js';

function memory(overrides = {}) {
  return {
    id: 'seg-1',
    sessionId: 's1',
    messageId: 'm1',
    role: 'user',
    at: 100,
    text: '用户：我喜欢猫',
    ...overrides,
  };
}

test('memoryKey：与存储层分段键同构（会话 + 分片 id）', () => {
  assert.equal(memoryKey({ sessionId: 's1', id: 'seg-1' }), 's1\u0000seg-1');
  assert.equal(memoryKey(null), '\u0000');
  // 跨会话同 id 不算同一条记忆
  assert.notEqual(
    memoryKey({ sessionId: 'a', id: 'x' }),
    memoryKey({ sessionId: 'b', id: 'x' })
  );
});

test('listMemories：过滤掉缺 id / 空文本的脏条目', () => {
  const index = [
    memory({ id: 'ok' }),
    memory({ id: '' }),
    memory({ id: 'blank', text: '   ' }),
    null,
    { id: 'no-text' },
  ];
  assert.deepEqual(listMemories(index).map(item => item.id), ['ok']);
  assert.equal(isMemoryItem(memory()), true);
  assert.equal(isMemoryItem({ id: 'x', text: 42 }), false);
});

test('groupMemoriesBySession：组间按最近记忆降序，组内按时间升序', () => {
  const index = [
    memory({ id: 'a1', sessionId: 's1', at: 100 }),
    memory({ id: 'a2', sessionId: 's1', at: 300 }),
    memory({ id: 'b1', sessionId: 's2', at: 500 }),
  ];
  const groups = groupMemoriesBySession(index, { sessionName: id => `会话${id}` });
  assert.deepEqual(groups.map(group => group.sessionId), ['s2', 's1'], '最近的会话排前面');
  assert.deepEqual(groups[1].items.map(item => item.id), ['a1', 'a2'], '组内从旧到新');
  assert.equal(groups[1].name, '会话s1');
  assert.equal(groups[1].latestAt, 300);
});

test('groupMemoriesBySession：无会话名的记忆归到空会话组，不丢条目', () => {
  const groups = groupMemoriesBySession([memory({ sessionId: '', id: 'orphan' })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessionId, '');
  assert.equal(groups[0].items.length, 1);
});

test('memorySources：普通记忆来源是它切出的那条消息', () => {
  const sources = memorySources(memory());
  assert.equal(sources.length, 1);
  assert.deepEqual(
    { sessionId: sources[0].sessionId, messageId: sources[0].messageId, merged: sources[0].merged },
    { sessionId: 's1', messageId: 'm1', merged: false }
  );
});

test('memorySources：合并记忆来源是合并前的快照（原文已被删除）', () => {
  const merged = memory({
    id: 'merged-1',
    origin: 'merged',
    messageId: '',
    mergedFrom: [
      { id: 'seg-a', sessionId: 's1', messageId: 'm1', text: '用户：喜欢猫', at: 10 },
      { id: 'seg-b', sessionId: 's2', messageId: 'm9', text: '用户：讨厌猫', at: 20 },
    ],
  });
  const sources = memorySources(merged);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map(item => item.text), ['用户：喜欢猫', '用户：讨厌猫']);
  assert.ok(sources.every(item => item.merged === true));
});

test('buildEvidenceChain：定位源消息并带出前后文', () => {
  const messages = [
    { id: 'm1', role: 'user', text: '一', timestamp: 1 },
    { id: 'm2', role: 'assistant', text: '二', timestamp: 2 },
    { id: 'm3', role: 'user', text: '三', timestamp: 3 },
    { id: 'm4', role: 'assistant', text: '四', timestamp: 4 },
    { id: 'm5', role: 'user', text: '五', timestamp: 5 },
  ];
  const chain = buildEvidenceChain({ memory: memory({ messageId: 'm3' }), messages, radius: 1 });
  assert.equal(chain.found, true);
  assert.equal(chain.source.text, '三');
  assert.deepEqual(chain.before.map(item => item.id), ['m2']);
  assert.deepEqual(chain.after.map(item => item.id), ['m4']);
  assert.equal(chain.truncated, false);
});

test('buildEvidenceChain：源消息不在时如实返回 found:false，不伪造', () => {
  const chain = buildEvidenceChain({
    memory: memory({ messageId: 'gone' }),
    messages: [{ id: 'm1', role: 'user', text: '一' }],
  });
  assert.equal(chain.found, false);
  assert.equal(chain.source, null);
  assert.deepEqual(chain.before, []);
  assert.deepEqual(chain.after, []);
  assert.equal(chain.messageId, 'gone');
});

test('buildEvidenceChain：radius 被夹在安全范围内，不会一次拉出整段对话', () => {
  const messages = Array.from({ length: 40 }, (unused, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第${index}条`,
    timestamp: index,
  }));
  const chain = buildEvidenceChain({ memory: memory({ messageId: 'm20' }), messages, radius: 999 });
  const total = chain.before.length + 1 + chain.after.length;
  assert.ok(total <= MAX_EVIDENCE_MESSAGES, `证据链不应超过 ${MAX_EVIDENCE_MESSAGES} 条，实际 ${total}`);
});

test('buildEvidenceChain：非对话消息（系统提示）不进入证据链', () => {
  const chain = buildEvidenceChain({
    memory: memory({ messageId: 'm2' }),
    messages: [
      { id: 'm1', role: 'system', text: '系统提示' },
      { id: 'm2', role: 'user', text: '用户说话' },
    ],
  });
  assert.equal(chain.found, true);
  assert.equal(chain.before.length, 0, 'system 消息不当作上下文');
});

test('sessionIdsOf：去重保序', () => {
  const ids = sessionIdsOf([
    memory({ sessionId: 's2', id: 'x' }),
    memory({ sessionId: 's1', id: 'y' }),
    memory({ sessionId: 's2', id: 'z' }),
    memory({ sessionId: '', id: 'w' }),
  ]);
  assert.deepEqual(ids, ['s2', 's1']);
});
