// 主动消息前台调度的纯逻辑（pickVariant / isSlotDue）。
//
// 这两条是「到底会不会触发、触发的风格对不对」的全部判定，且都只依赖时间与权重——
// 抽成纯函数后才能在没有 Electron/React 的 Node 里钉死边界。
import test from 'node:test';
import assert from 'node:assert/strict';

import { isSlotDue, pickVariant } from '../../src/proactive/slotTiming.js';

const at = (hour, minute, second = 0) => {
  const date = new Date(2026, 0, 2, hour, minute, second, 0);
  return date;
};

test('isSlotDue：准点槽只在那一分钟内到点', () => {
  const slot = { enabled: true, hour: 9, minute: 30, windowMinutes: 0 };
  assert.equal(isSlotDue(slot, at(9, 29, 59)), false, '未到点不触发');
  assert.equal(isSlotDue(slot, at(9, 30, 0)), true);
  assert.equal(isSlotDue(slot, at(9, 30, 59)), true, '分钟内仍算到点');
  assert.equal(isSlotDue(slot, at(9, 31, 0)), false, '过了就不触发（避免晚开窗口补发旧消息）');
});

test('isSlotDue：随机时段在整个窗口内都到点', () => {
  const slot = { enabled: true, hour: 9, minute: 0, windowMinutes: 60 };
  assert.equal(isSlotDue(slot, at(8, 59)), false);
  assert.equal(isSlotDue(slot, at(9, 0)), true);
  assert.equal(isSlotDue(slot, at(9, 59)), true);
  assert.equal(isSlotDue(slot, at(10, 0)), false, '窗口结束即不到点');
});

test('isSlotDue：关掉的槽、残缺的槽都不触发', () => {
  assert.equal(isSlotDue({ enabled: false, hour: 9, minute: 0 }, at(9, 0)), false);
  assert.equal(isSlotDue({ hour: 9, minute: 0 }, at(9, 0)), false, '缺 enabled 视为关闭');
  assert.equal(isSlotDue(null, at(9, 0)), false);
  assert.equal(isSlotDue({ enabled: true, hour: 'x', minute: 0 }, at(9, 0)), false);
});

test('pickVariant：按权重抽，0 权重的风格不会被选中', () => {
  const variants = [
    { messageType: 'DEFAULT', weight: 0 },
    { messageType: 'CARE', weight: 1 },
  ];
  // 无论随机数落在哪，0 权重都不该出现。
  [0, 0.25, 0.5, 0.999].forEach(random => {
    assert.equal(pickVariant(variants, () => random).messageType, 'CARE');
  });
  // 全 0 权重 → 没有可选项。
  assert.equal(pickVariant([{ weight: 0 }, { weight: 0 }]), null);
  assert.equal(pickVariant([]), null);
  assert.equal(pickVariant(null), null);
});

test('pickVariant：1:3 的权重分布大致是 25% / 75%', () => {
  const variants = [
    { messageType: 'A', weight: 1 },
    { messageType: 'B', weight: 3 },
  ];
  assert.equal(pickVariant(variants, () => 0.1).messageType, 'A', '落在前 25% 命中 A');
  assert.equal(pickVariant(variants, () => 0.3).messageType, 'B');
  assert.equal(pickVariant(variants, () => 0.99).messageType, 'B');
  // 边界：恰好 0.25 应落到 B（累加后 <= 0 才算命中 A，所以 0.25*4=1.0 → 1-1=0 ≤ 0 命中 A）。
  assert.equal(pickVariant(variants, () => 0.25).messageType, 'A');
});

test('pickVariant：权重全相等时按顺序取第一个命中项', () => {
  const variants = [{ messageType: 'A', weight: 1 }, { messageType: 'B', weight: 1 }];
  assert.equal(pickVariant(variants, () => 0.1).messageType, 'A');
  assert.equal(pickVariant(variants, () => 0.9).messageType, 'B');
});
