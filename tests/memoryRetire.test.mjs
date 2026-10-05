// 世界书记忆归属判定（纯函数）测试：planWorldMemoryRetire / applyWorldMemoryRetire。
// 背景：代码路径已统一「跟随会话所属角色」，但存量数据（单会话时代写进卡上的记忆、
// 删会话残留、跨卡流通）没有清理机制——判定规则这里单独锁死。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeWorldMemoryEntries,
  applyWorldMemoryRetire,
  isBuiltinCharacter,
  isWorldMemoryEntry,
  planWorldMemoryRetire,
} from '../src/memory/memoryRetire.js';

const entry = (id, overrides = {}) => ({
  id,
  comment: '记忆总结 1',
  content: '一段记忆',
  enabled: true,
  boundary: 'msg-1',
  ...overrides,
});

test('isWorldMemoryEntry / activeWorldMemoryEntries：与读取侧同口径', () => {
  assert.equal(isWorldMemoryEntry({ comment: '记忆总结 3' }), true);
  assert.equal(isWorldMemoryEntry({ comment: '普通条目' }), false);
  // 读取侧只认 enabled 且 content 非空的条目，判定必须一致
  assert.deepEqual(activeWorldMemoryEntries([
    entry('a'),
    entry('b', { enabled: false }),
    entry('c', { content: '   ' }),
    { comment: '别的条目', content: 'x' },
  ]).map(item => item.id), ['a']);
  assert.equal(isBuiltinCharacter({ builtin: true }), true);
  assert.equal(isBuiltinCharacter({}), false);
});

test('planWorldMemoryRetire：0 会话 / ≥2 会话 / 内置助手 → 全部退休', () => {
  const worldInfo = [entry('a'), entry('b', { comment: '记忆总结 2' })];
  assert.deepEqual(planWorldMemoryRetire(worldInfo, { sessionCount: 0 }), ['a', 'b']);
  assert.deepEqual(planWorldMemoryRetire(worldInfo, { sessionCount: 2 }), ['a', 'b']);
  assert.deepEqual(planWorldMemoryRetire(worldInfo, { sessionCount: 5, builtin: true }), ['a', 'b']);
  // 没有记忆条目 → 空数组（调用方据此跳过写盘）
  assert.deepEqual(planWorldMemoryRetire([], { sessionCount: 0 }), []);
});

test('planWorldMemoryRetire：唯一会话按 boundary 归属；读不到消息不动', () => {
  const worldInfo = [
    entry('keep', { boundary: 'msg-1' }),
    entry('retire', { boundary: 'msg-gone' }),
    entry('no-boundary', { boundary: '' }),
  ];
  assert.deepEqual(
    planWorldMemoryRetire(worldInfo, { sessionCount: 1, messageIds: new Set(['msg-1']) }),
    ['retire', 'no-boundary'],
    'boundary 属于唯一会话的保留，其余退休（删会话残留的典型形状）'
  );
  // 消息读不出来（null）→ 本次不动，宁可下次再试也不凭猜测退休
  assert.deepEqual(planWorldMemoryRetire(worldInfo, { sessionCount: 1, messageIds: null }), []);
  // 会话数非法 → 不动
  assert.deepEqual(planWorldMemoryRetire(worldInfo, { sessionCount: Number.NaN }), []);
});

test('applyWorldMemoryRetire：只动命中的条目（enabled:false + stale:true）', () => {
  const worldInfo = [
    entry('a'),
    entry('b', { comment: '普通条目', content: 'x' }),
    entry('c', { comment: '记忆总结 2' }),
  ];
  const next = applyWorldMemoryRetire(worldInfo, ['a']);
  assert.equal(next[0].enabled, false);
  assert.equal(next[0].stale, true);
  assert.equal(next[0].content, '一段记忆', '内容保留（用户可在角色卡编辑器里自行清理）');
  assert.equal(next[1], worldInfo[1], '非记忆条目不动');
  assert.equal(next[2].enabled, true, '未命中的记忆条目不动');
  // 空 retireIds → 原样返回
  assert.equal(applyWorldMemoryRetire(worldInfo, []), worldInfo);
});
