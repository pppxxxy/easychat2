// 工作区宽屏两栏的布局解算（workspace/splitLayout.js）——纯函数行为测试。
// 用户裁决（2026-10-10）：宽屏允许破例两栏。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_PANE_WIDTH,
  MIN_SPLIT_RATIO,
  SIDE_PANELS,
  WIDE_MIN_WIDTH,
  clampSplitRatio,
  isWideLayout,
  normalizeStoredLayout,
  ratioFromDrag,
  resolveWorkspaceLayout,
  splitColumns,
} from '../src/workspace/splitLayout.js';

test('isWideLayout：阈值边界；坏输入当 0（单栏）', () => {
  assert.equal(isWideLayout(WIDE_MIN_WIDTH - 1), false);
  assert.equal(isWideLayout(WIDE_MIN_WIDTH), true);
  assert.equal(isWideLayout(1400), true);
  assert.equal(isWideLayout(0), false);
  assert.equal(isWideLayout(-100), false);
  assert.equal(isWideLayout(undefined), false);
  assert.equal(isWideLayout('abc'), false);
});

test('resolveWorkspaceLayout：宽屏**且领域可停靠**才两栏（对话与设置都保持单栏）', () => {
  // 窄屏：无论选哪个领域都是单栏（手机竖屏放不下两栏，原「面板单开」原则继续有效）
  assert.deepEqual(resolveWorkspaceLayout({ width: 400, panel: 'files' }), { wide: false, twoPane: false, single: true });
  // 宽屏 + 对话：单栏——「对话常驻」不等于「永远两栏」，用户点了对话就是要全宽的对话
  assert.deepEqual(resolveWorkspaceLayout({ width: 1200, panel: 'chat' }), { wide: true, twoPane: false, single: true });
  // 宽屏 + 设置：也单栏——设置是「改配置」不是「边看边改」，塞进侧栏只会把对话挤窄
  assert.equal(resolveWorkspaceLayout({ width: 1200, panel: 'settings' }).twoPane, false);
  // 宽屏 + 可停靠的三选一：两栏
  assert.deepEqual(resolveWorkspaceLayout({ width: 1200, panel: 'files' }), { wide: true, twoPane: true, single: false });
  assert.equal(resolveWorkspaceLayout({ width: 1200, panel: 'terminal' }).twoPane, true);
  assert.equal(resolveWorkspaceLayout({ width: 1200, panel: 'github' }).twoPane, true);
  // panel 缺省当对话
  assert.equal(resolveWorkspaceLayout({ width: 1200 }).twoPane, false);
  assert.equal(resolveWorkspaceLayout({}).single, true);
});

test('clampSplitRatio：夹到上下限；坏输入回默认', () => {
  assert.equal(clampSplitRatio(0.5), 0.5);
  assert.equal(clampSplitRatio(0.1), MIN_SPLIT_RATIO);
  assert.equal(clampSplitRatio(0.95), MAX_SPLIT_RATIO);
  assert.equal(clampSplitRatio(Number.NaN), DEFAULT_SPLIT_RATIO);
  assert.equal(clampSplitRatio(null), DEFAULT_SPLIT_RATIO);
  assert.equal(clampSplitRatio('0.6'), 0.6, '数字字符串照收');
});

test('splitColumns：两栏之和恒等于总宽，且都不低于下限', () => {
  const cols = splitColumns({ width: 1200, ratio: 0.5 });
  assert.equal(cols.left + cols.right, 1200, '不能出现 1px 缝隙');
  assert.equal(cols.left, 600);
  assert.ok(cols.left >= MIN_PANE_WIDTH && cols.right >= MIN_PANE_WIDTH);
  // 极端比例被夹住后仍然成立
  const skewed = splitColumns({ width: 1200, ratio: 0.99 });
  assert.equal(skewed.left + skewed.right, 1200);
  assert.equal(skewed.left, Math.round(1200 * MAX_SPLIT_RATIO));
});

test('splitColumns：放不下就返回 null（不硬分两个都不可用的窄栏）', () => {
  assert.equal(splitColumns({ width: MIN_PANE_WIDTH * 2 - 1, ratio: 0.5 }), null);
  assert.equal(splitColumns({ width: 0, ratio: 0.5 }), null);
  assert.equal(splitColumns({ width: -10, ratio: 0.5 }), null);
  assert.equal(splitColumns({}), null);
  // 刚好放得下
  assert.ok(splitColumns({ width: MIN_PANE_WIDTH * 2, ratio: 0.5 }));
});

test('ratioFromDrag：位移按总宽折算（同样的手指位移 = 同样的像素变化）', () => {
  // 宽 1000，向右拖 100px → 比例 +0.1
  assert.equal(ratioFromDrag({ startRatio: 0.5, dx: 100, width: 1000 }), 0.6);
  assert.equal(ratioFromDrag({ startRatio: 0.5, dx: -100, width: 1000 }), 0.4);
  // 拖过头被夹住
  assert.equal(ratioFromDrag({ startRatio: 0.5, dx: 10000, width: 1000 }), MAX_SPLIT_RATIO);
  assert.equal(ratioFromDrag({ startRatio: 0.5, dx: -10000, width: 1000 }), MIN_SPLIT_RATIO);
  // 坏输入不抛：宽度为 0 时保持起点（夹紧后）
  assert.equal(ratioFromDrag({ startRatio: 0.5, dx: 100, width: 0 }), 0.5);
  assert.equal(ratioFromDrag({ startRatio: 0.9, dx: 100, width: 0 }), MAX_SPLIT_RATIO);
  assert.equal(ratioFromDrag({}), DEFAULT_SPLIT_RATIO);
});

test('normalizeStoredLayout：任一项不合法就整份丢弃（不做半份可信）', () => {
  assert.deepEqual(normalizeStoredLayout({ ratio: 0.6, side: 'files' }), { ratio: 0.6, side: 'files' });
  assert.deepEqual(SIDE_PANELS, ['files', 'github', 'terminal']);
  // 侧栏只认这三种：'chat' 不是可停靠的侧栏，'settings' 同理
  assert.equal(normalizeStoredLayout({ ratio: 0.6, side: 'chat' }), null);
  assert.equal(normalizeStoredLayout({ ratio: 0.6, side: 'settings' }), null);
  assert.equal(normalizeStoredLayout({ ratio: 0.6 }), null);
  // 比例越界整份丢弃（而不是夹紧）——夹紧会让重启后处于用户没选过的布局
  assert.equal(normalizeStoredLayout({ ratio: 0.1, side: 'files' }), null);
  assert.equal(normalizeStoredLayout({ ratio: 0.99, side: 'files' }), null);
  assert.equal(normalizeStoredLayout({ ratio: 'abc', side: 'files' }), null);
  assert.equal(normalizeStoredLayout(null), null);
  assert.equal(normalizeStoredLayout('nope'), null);
});
