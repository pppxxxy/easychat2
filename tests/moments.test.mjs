import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendMoment,
  countMomentsBySessionIds,
  removeMomentsBySessionIds,
  selectMomentIdsBySessionIds,
  shouldTrigger,
} from '../src/moments/moments.js';

const MOMENTS = [
  { id: 'm1', sessionId: 's1', text: 'a' },
  { id: 'm2', sessionId: 's2', text: 'b' },
  { id: 'm3', sessionId: '', text: 'c' },
  { id: 'm4', sessionId: 's1', text: 'd' },
];

test('按会话选动态：匹配 sessionId，忽略空 sessionId 与老数据', () => {
  assert.deepEqual(selectMomentIdsBySessionIds(MOMENTS, ['s1']), ['m1', 'm4']);
  assert.deepEqual(selectMomentIdsBySessionIds(MOMENTS, ['s1', 's2']), ['m1', 'm2', 'm4']);
  // 空 sessionId 的动态不属于任何会话，不会被误删
  assert.deepEqual(selectMomentIdsBySessionIds(MOMENTS, ['']), []);
  assert.deepEqual(selectMomentIdsBySessionIds(MOMENTS, ['s9']), []);
});

test('按会话计数与删除：非目标会话原样保留', () => {
  assert.equal(countMomentsBySessionIds(MOMENTS, ['s1']), 2);
  assert.equal(countMomentsBySessionIds(MOMENTS, []), 0);

  const removed = removeMomentsBySessionIds(MOMENTS, ['s1']);
  assert.deepEqual(removed.map(item => item.id), ['m2', 'm3']);
  // 不修改原数组
  assert.equal(MOMENTS.length, 4);

  const untouched = removeMomentsBySessionIds(MOMENTS, []);
  assert.deepEqual(untouched.map(item => item.id), ['m1', 'm2', 'm3', 'm4']);
});

test('appendMoment 超过上限时保留最新的', () => {
  let list = [];
  for (let i = 0; i < 205; i += 1) {
    list = appendMoment(list, { id: `m${i}` });
  }
  assert.equal(list.length, 200);
  assert.equal(list[0].id, 'm5');
});

test('appendMoment 传入降序列表时按 createdAt 保最新，不误删次新动态', () => {
  const list = Array.from({ length: 200 }, (_, i) => ({ id: `old${i}`, createdAt: 1000 + i }));
  // getMoments 返回降序（最新在前）
  const descending = [...list].sort((a, b) => b.createdAt - a.createdAt);
  const next = appendMoment(descending, { id: 'newest', createdAt: 99999 });
  assert.equal(next.length, 200);
  assert.ok(next.some(item => item.id === 'newest'));
  // 原降序列表里最新的那条必须保留，不能被按位置截断误删
  assert.ok(next.some(item => item.id === descending[0].id));
});

test('好感度与回合阈值去重后触发', () => {
  assert.equal(shouldTrigger({ affinity: 120 }), 'affinity-best');
  assert.equal(shouldTrigger({ affinity: 120, triggers: ['affinity-best'] }), null);
  assert.equal(shouldTrigger({ turnCount: 50, triggers: ['affinity-best'] }), 'turns-50');
});
