// 工作区布局断点（layout）测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import { WIDE_BREAKPOINT, resolveWorkspaceLayout } from '../src/workspace/layout.js';

test('resolveWorkspaceLayout：达到断点分栏，否则单屏', () => {
  assert.equal(WIDE_BREAKPOINT, 720);
  assert.equal(resolveWorkspaceLayout({ width: WIDE_BREAKPOINT }), 'split');
  assert.equal(resolveWorkspaceLayout({ width: WIDE_BREAKPOINT - 1 }), 'single');
  assert.equal(resolveWorkspaceLayout({ width: 1024 }), 'split');
  assert.equal(resolveWorkspaceLayout({ width: 390 }), 'single');
});

test('resolveWorkspaceLayout：可自定义断点；非法宽度回退单屏', () => {
  assert.equal(resolveWorkspaceLayout({ width: 600, breakpoint: 600 }), 'split');
  assert.equal(resolveWorkspaceLayout({ width: 600, breakpoint: 601 }), 'single');
  assert.equal(resolveWorkspaceLayout({}), 'single');
  assert.equal(resolveWorkspaceLayout({ width: 'x' }), 'single');
  assert.equal(resolveWorkspaceLayout({ width: 800, breakpoint: 'y' }), 'single');
});
