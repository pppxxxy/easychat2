// iframe 高度换算（阈值/兜底与共享层常量一致）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RICH_HTML_FALLBACK_HEIGHT,
  contentHeightFrom,
  resolveFrameDisplayHeight,
} from '../../src/render/frameHeight.js';
import {
  RICH_HTML_MAX_RENDER_HEIGHT,
  RICH_HTML_SCROLL_PREVIEW_HEIGHT,
} from '../../../src/chat/richHtml.js';

test('contentHeightFrom：取 scroll/offset 较大者，下限 24、上限 24000', () => {
  assert.equal(contentHeightFrom(98, 98), 98);
  assert.equal(contentHeightFrom(0, 0), 24);
  assert.equal(contentHeightFrom(120, 90), 120);
  assert.equal(contentHeightFrom(RICH_HTML_MAX_RENDER_HEIGHT + 5000, 0), RICH_HTML_MAX_RENDER_HEIGHT);
});

test('resolveFrameDisplayHeight：超过滚动阈值收成预览高度', () => {
  assert.equal(resolveFrameDisplayHeight(98), 98);
  assert.equal(resolveFrameDisplayHeight(5999), 5999);
  assert.equal(resolveFrameDisplayHeight(6000), RICH_HTML_SCROLL_PREVIEW_HEIGHT);
  assert.equal(resolveFrameDisplayHeight(12000), RICH_HTML_SCROLL_PREVIEW_HEIGHT);
});

test('resolveFrameDisplayHeight：拿不到文档时退化为固定高度', () => {
  assert.equal(resolveFrameDisplayHeight(98, false), RICH_HTML_FALLBACK_HEIGHT);
});
