import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countCharacterMessageTotals,
  pickRandom,
  selectCommenters,
} from '../src/moments/commenters.js';

function chars(...ids) {
  return ids.map(id => ({ id, name: id }));
}

test('countCharacterMessageTotals 按角色累加且排除群聊', () => {
  const sessions = [
    { id: 's1', type: 'single', characterId: 'a' },
    { id: 's2', type: 'single', characterId: 'a' },
    { id: 's3', type: 'single', characterId: 'b' },
    { id: 'g1', type: 'group', characterId: '' },
  ];
  const totals = countCharacterMessageTotals(sessions, {
    s1: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
    s2: [{ role: 'assistant' }],
    s3: [{ role: 'user' }],
    g1: [{ role: 'user' }, { role: 'user' }],
  });
  assert.deepEqual(totals, { a: 4, b: 1 });
});

test('保底：活跃度最高者独占名额（并列全部纳入）', () => {
  const ids = selectCommenters({
    characters: chars('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    totals: { a: 10, b: 10, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1 },
    max: 7,
    random: () => 0,
  });
  // a、b 并列最高，保底 2 个；剩余 5 个名额随机补足 → 共 7
  assert.equal(ids.length, 7);
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('b'));
});

test('保底 < max 时随机补足到 max', () => {
  const ids = selectCommenters({
    characters: chars('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'),
    totals: { a: 100 },
    max: 7,
    random: () => 0,
  });
  assert.equal(ids.length, 7);
  assert.equal(ids[0], 'a');
  assert.equal(new Set(ids).size, 7);
});

test('保底 >= max 时不再随机，允许超过 max', () => {
  const eight = chars('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
  const totals = {};
  eight.forEach(item => { totals[item.id] = 50; });
  const ids = selectCommenters({ characters: eight, totals, max: 7, random: () => 0 });
  // 8 个并列最活跃 → 8 个全评论，超过 max
  assert.equal(ids.length, 8);
});

test('活跃度全为 0 时没有保底，全部随机抽取至 max', () => {
  const ids = selectCommenters({
    characters: chars('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    totals: {},
    max: 3,
    random: () => 0,
  });
  assert.equal(ids.length, 3);
});

test('excludeIds 排除指定角色', () => {
  const ids = selectCommenters({
    characters: chars('a', 'b', 'c'),
    totals: { a: 5, b: 4, c: 3 },
    max: 7,
    excludeIds: ['a'],
    random: () => 0,
  });
  assert.equal(ids.includes('a'), false);
  assert.equal(ids.length, 2);
});

test('pickRandom 可注入随机源且不重复', () => {
  const source = ['a', 'b', 'c', 'd'];
  assert.deepEqual(pickRandom(source, 2, () => 0), ['a', 'b']);
  assert.deepEqual(pickRandom(source, 9, () => 0).length, 4);
});
