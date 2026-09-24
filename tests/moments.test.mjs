import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendMoment,
  buildMomentText,
  countMomentsForCharacterDeletion,
  countMomentsBySessionIds,
  removeMomentsForCharacterDeletion,
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

test('按角色与会话删除动态：覆盖角色快照和群聊来源', () => {
  const moments = [
    { id: 'm1', characterId: 'c1', sessionId: 's1', text: '角色动态' },
    { id: 'm2', characterId: 'c2', sessionId: 'g1', text: '群聊动态' },
    { id: 'm3', characterId: 'c3', sessionId: 's3', text: '其他角色' },
  ];
  assert.equal(countMomentsForCharacterDeletion(moments, ['c1'], ['g1']), 2);
  assert.deepEqual(
    removeMomentsForCharacterDeletion(moments, ['c1'], ['g1']).map(item => item.id),
    ['m3']
  );
  assert.equal(moments.length, 3);
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

test('动态文本使用发动态时的角色名称快照', () => {
  assert.match(
    buildMomentText({
      trigger: 'milestone-test',
      character: { name: '固定名称' },
    }),
    /固定名称/
  );
});

test('好感度与回合阈值去重后触发', () => {
  assert.equal(shouldTrigger({ affinity: 120 }), 'affinity-best');
  assert.equal(shouldTrigger({ affinity: 120, triggers: ['affinity-best'] }), null);
  assert.equal(shouldTrigger({ turnCount: 50, triggers: ['affinity-best'] }), 'turns-50');
});
