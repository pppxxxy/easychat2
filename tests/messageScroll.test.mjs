// 虚拟化消息列表的定位算术（messageScroll.js）。
//
// 这一批把 MessageList 的滚动容器从 ScrollView 换成 FlatList：逐条 onLayout 累积的
// messageOffsetsRef 在虚拟化下必然缺值（窗口外的项没有 onLayout），定位改走 scrollToIndex。
// 这里测的是那次改造里**唯一可抽成纯函数**的部分——按 id 找窗口内下标、越界守卫、
// 未测量项的兜底落点与重试预算。组件里只剩接线，接线由 chatScreenSplit /
// scrollScrubber 的结构守卫钉住。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MESSAGE_SCROLL_FALLBACK_ITEM_LENGTH,
  MESSAGE_SCROLL_MAX_RETRY,
  MESSAGE_SCROLL_VIEW_OFFSET,
  canScrollToIndex,
  messageIndexById,
  scrollFallbackOffset,
  shouldRetryScrollToIndex,
} from '../src/chat/messageScroll.js';

const WINDOW = [
  { id: 'm7', text: '七' },
  { id: 'm8', text: '八' },
  { id: 'm9', text: '九' },
];

test('按 id 找窗口内下标：命中返回下标，未命中返回 -1', () => {
  assert.equal(messageIndexById(WINDOW, 'm7'), 0);
  assert.equal(messageIndexById(WINDOW, 'm9'), 2);
  // 窗口外的消息（被 MESSAGE_WINDOW_* 切走的历史）必须返回 -1 而不是 0：
  // 否则 scrollToMessage 会把「找不到」当成「第一条」，跳错位置。
  assert.equal(messageIndexById(WINDOW, 'm1'), -1);
  assert.equal(messageIndexById(WINDOW, ''), -1);
});

test('按 id 找下标：id 类型不统一也按字符串比较，坏数据不抛异常', () => {
  assert.equal(messageIndexById([{ id: 42 }], 42), 0);
  assert.equal(messageIndexById([{ id: 42 }], '42'), 0);
  assert.equal(messageIndexById([null, undefined, { id: 'x' }], 'x'), 2);
  assert.equal(messageIndexById([{ text: '无 id' }], 'x'), -1);
  assert.equal(messageIndexById(null, 'x'), -1);
  assert.equal(messageIndexById(WINDOW, null), -1);
});

test('scrollToIndex 越界守卫：命中 VirtualizedList 的三条 invariant', () => {
  // 越界会直接 invariant 抛错闪退（VirtualizedList.js:165-180），必须先拦住
  assert.equal(canScrollToIndex(0, 3), true);
  assert.equal(canScrollToIndex(2, 3), true);
  assert.equal(canScrollToIndex(3, 3), false, 'index >= itemCount 越界');
  assert.equal(canScrollToIndex(-1, 3), false, 'index < 0 越界');
  assert.equal(canScrollToIndex(0, 0), false, '空列表调用 scrollToIndex 会抛错');
  assert.equal(canScrollToIndex(1.5, 3), false, '非整数下标不接受');
  assert.equal(canScrollToIndex(0, NaN), false);
});

test('未测量项的兜底落点：用平均项高估算，并保持 -80 的落点语义', () => {
  // 目标第 10 项、平均项高 200：10*200 - 80，与旧实现 scrollTo({ y: offset - 80 }) 同语义
  assert.equal(scrollFallbackOffset({ index: 10, averageItemLength: 200 }), 10 * 200 - MESSAGE_SCROLL_VIEW_OFFSET);
  // 框架没测出任何项高（averageItemLength=0）时用保守默认值，不能算出 0 落点（等于不滚）
  assert.equal(
    scrollFallbackOffset({ index: 5, averageItemLength: 0 }),
    5 * MESSAGE_SCROLL_FALLBACK_ITEM_LENGTH - MESSAGE_SCROLL_VIEW_OFFSET
  );
  // 估算落点不得为负（ScrollView 负偏移在 Android 上是越界）
  assert.equal(scrollFallbackOffset({ index: 0, averageItemLength: 200 }), 0);
  assert.equal(scrollFallbackOffset({ index: 1, averageItemLength: 10, viewOffset: 80 }), 0);
  // 缺参/坏参不抛异常
  assert.equal(scrollFallbackOffset(), 0);
  assert.equal(scrollFallbackOffset({ index: -3, averageItemLength: -1 }), 0);
});

test('重试预算有限：次数用完即放弃（避免滚动风暴）', () => {
  assert.equal(shouldRetryScrollToIndex(0), true);
  assert.equal(shouldRetryScrollToIndex(MESSAGE_SCROLL_MAX_RETRY - 1), true);
  assert.equal(shouldRetryScrollToIndex(MESSAGE_SCROLL_MAX_RETRY), false, '到达上限必须停');
  assert.equal(shouldRetryScrollToIndex(MESSAGE_SCROLL_MAX_RETRY + 10), false);
  assert.equal(shouldRetryScrollToIndex(-1), false);
  assert.equal(shouldRetryScrollToIndex(NaN), false);
});
