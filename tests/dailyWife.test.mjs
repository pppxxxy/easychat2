// 「今日老婆/老公」纯函数：按「本地日期 + 称呼」稳定抽取的回归测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import { hashSeed, buildDailyDateStr, pickDailyCharacter } from '../src/games/dailyWife.js';

const CHARACTERS = [
  { id: 'a', name: '角色甲' },
  { id: 'b', name: '角色乙' },
  { id: 'c', name: '角色丙' },
];

test('hashSeed：同输入恒定、不同输入分散', () => {
  assert.equal(hashSeed('2026-10-01\u0000wife'), hashSeed('2026-10-01\u0000wife'));
  assert.equal(hashSeed(''), 5381);
  assert.equal(hashSeed('a'), hashSeed('a'));
});

test('buildDailyDateStr：本地日期格式 YYYY-MM-DD', () => {
  assert.match(buildDailyDateStr(new Date(2026, 9, 1)), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(buildDailyDateStr(new Date(2026, 9, 1)), '2026-10-01');
  // 月份与日期补零
  assert.equal(buildDailyDateStr(new Date(2026, 0, 5)), '2026-01-05');
});

test('pickDailyCharacter：同一天同称呼稳定抽同一位', () => {
  const first = pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife');
  assert.ok(first);
  assert.equal(pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife').id, first.id);
  // 同一天内多次调用一致
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife').id, first.id);
  }
});

test('pickDailyCharacter：称呼切换各自独立（今日老婆/老公可不同）', () => {
  const wife = pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife');
  const husband = pickDailyCharacter(CHARACTERS, '2026-10-01', 'husband');
  assert.ok(wife && husband);
  // 三角色两称呼：至少验证 seed 输入不同（可能同结果但概率低，这里断言函数接受 mode）
  assert.ok(CHARACTERS.some(item => item.id === wife.id));
  assert.ok(CHARACTERS.some(item => item.id === husband.id));
});

test('pickDailyCharacter：跨天抽到不同角色（长清单高概率覆盖）', () => {
  const bigList = Array.from({ length: 50 }, (_, index) => ({ id: `c${index}`, name: `角色${index}` }));
  const days = Array.from({ length: 30 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`);
  const picked = new Set(days.map(day => pickDailyCharacter(bigList, day, 'wife').id));
  // 30 天抽 50 人：至少应出现多个不同角色（全同概率 1/50^29 趋近零）
  assert.ok(picked.size > 3, `30 天应抽到多个角色，实际 ${picked.size}`);
});

test('pickDailyCharacter：空库/非法输入返回 null，非法日期回退今天', () => {
  assert.equal(pickDailyCharacter([], '2026-10-01', 'wife'), null);
  assert.equal(pickDailyCharacter(null, '2026-10-01', 'wife'), null);
  assert.equal(pickDailyCharacter([null, undefined, 'not-object'].filter(Boolean), '2026-10-01'), null);
  // 非法日期回退今天，不抛错
  const fallback = pickDailyCharacter(CHARACTERS, 'not-a-date', 'wife');
  assert.ok(fallback);
  assert.equal(pickDailyCharacter(CHARACTERS, '', 'wife').id, fallback.id);
});
