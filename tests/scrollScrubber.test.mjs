import test from 'node:test';
import assert from 'node:assert/strict';

import { getScrollRange, indexFromRatio } from '../src/scrollScrubberMath.js';

test('滑动比例映射到首尾索引', () => {
  assert.equal(indexFromRatio(-1, 5), 0);
  assert.equal(indexFromRatio(0.5, 5), 2);
  assert.equal(indexFromRatio(2, 5), 4);
  assert.equal(indexFromRatio(0.5, 0), 0);
});

test('角色网格滚动范围按顶部和底部对齐', () => {
  assert.deepEqual(getScrollRange({ top: 240, height: 900, viewport: 600 }), {
    start: 240,
    end: 540,
  });
  assert.deepEqual(getScrollRange({ top: 100, height: 200, viewport: 600 }), {
    start: 100,
    end: 0,
  });
});
