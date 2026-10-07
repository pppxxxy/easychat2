// 按章进度纯函数测试（2026-10-07「已读完」虚报修复）。
// 钉住的语义：
// - 页粒度百分比：共 4 面读到第 3 面 = 75%，共 13 面读到第 3 面 ≈ 23%；
// - 读完一章最后一页 = 100%（跨章结算也按这个口径补写被离开的章）；
// - 映射归一化 clamp/丢弃、旧数据迁移为 {}（绝不从旧位置反推「已读完」）；
// - 合并同章取历史最大值，回翻/回读不降进度。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeChapterPercent,
  mergeChapterProgress,
  normalizeChapterProgress,
} from '../src/books/chapterProgress.js';

// 三章书：第一章占块 0-3，第二章占块 4-6，第三章占块 7-9。
const ENTRIES = [
  { index: 0, title: '第一章', blockIndex: 0 },
  { index: 1, title: '第二章', blockIndex: 4 },
  { index: 2, title: '第三章', blockIndex: 7 },
];

test('页粒度百分比：单块章 4 面读 3 面 = 75%，13 面读 3 面 ≈ 23%', () => {
  const single = [{ index: 0, title: '第一章', blockIndex: 0 }];
  assert.equal(computeChapterPercent({
    chapterEntries: single, blockCount: 1, blockIndex: 0, pageIndex: 2, pageCount: 4,
  }), 75);
  assert.equal(computeChapterPercent({
    chapterEntries: single, blockCount: 1, blockIndex: 0, pageIndex: 2, pageCount: 13,
  }), 23);
  // 站在第 1 面不是 0%：(0 + 1/13) × 100 = 7.7 → 8
  assert.equal(computeChapterPercent({
    chapterEntries: single, blockCount: 1, blockIndex: 0, pageIndex: 0, pageCount: 13,
  }), 8);
});

test('多块章：块均匀近似，读完最后一块最后一页 = 100%', () => {
  // 第一章（块 0-3，每块 4 面）：块 2 第 3 面 → (2 + 3/4) / 4 = 68.75 → 69
  assert.equal(computeChapterPercent({
    chapterEntries: ENTRIES, blockCount: 10, blockIndex: 2, pageIndex: 2, pageCount: 4,
  }), 69);
  // 第一章最后一页（块 3 第 4 面）= 100%
  assert.equal(computeChapterPercent({
    chapterEntries: ENTRIES, blockCount: 10, blockIndex: 3, pageIndex: 3, pageCount: 4,
  }), 100);
  // 第二章第一页：(0 + 1/4) / 3 = 8.3 → 8
  assert.equal(computeChapterPercent({
    chapterEntries: ENTRIES, blockCount: 10, blockIndex: 4, pageIndex: 0, pageCount: 4,
  }), 8);
  // 全书末章末页：块 9 第 4 面 → (2 + 1) / 3 = 100%
  assert.equal(computeChapterPercent({
    chapterEntries: ENTRIES, blockCount: 10, blockIndex: 9, pageIndex: 3, pageCount: 4,
  }), 100);
});

test('边界：无目录 / 位置在首章之前 → null；越界页码夹取', () => {
  assert.equal(computeChapterPercent({ chapterEntries: [], blockCount: 10, blockIndex: 0 }), null);
  const late = [{ index: 0, title: '章', blockIndex: 5 }];
  assert.equal(computeChapterPercent({ chapterEntries: late, blockCount: 10, blockIndex: 2 }), null,
    '进度块号早于首章（脏进度）时无可判定章，返回 null');
  assert.equal(computeChapterPercent({
    chapterEntries: late, blockCount: 10, blockIndex: 9, pageIndex: 99, pageCount: 4,
  }), 100, '页码越界夹取（inBlock 封顶 1），末块站满即 100%');
});

test('归一化：clamp 取整、非法丢弃、规范键、迁移为空映射', () => {
  assert.deepEqual(normalizeChapterProgress(undefined), {}, '旧数据无字段 → {}');
  assert.deepEqual(normalizeChapterProgress(null), {});
  assert.deepEqual(normalizeChapterProgress([1, 2]), {}, '数组不是映射');
  assert.deepEqual(
    normalizeChapterProgress({ 0: 130, 1: -8, 2: 75.6 }),
    { 0: 100, 1: 0, 2: 76 },
    '超界 clamp 到 [0,100]，小数取整'
  );
  assert.deepEqual(
    normalizeChapterProgress({ '03': 5, '3.5': 6, x: 7, '4': 8 }),
    { 4: 8 },
    '只收规范十进制整数键'
  );
});

test('合并：同章取历史最大值，回翻不降进度', () => {
  assert.deepEqual(mergeChapterProgress({}, { 3: 23 }), { 3: 23 });
  assert.deepEqual(mergeChapterProgress({ 3: 75 }, { 3: 23 }), { 3: 75 }, '回翻旧页不降');
  assert.deepEqual(mergeChapterProgress(null, { 3: 100 }), { 3: 100 });
  assert.deepEqual(mergeChapterProgress({ 1: 40 }, { 1: 55, 2: 8 }), { 1: 55, 2: 8 });
  // 合并过程同样归一化：脏补丁不能把非法值带进存储
  assert.deepEqual(mergeChapterProgress({ 1: 40 }, { 1: 999, 2: 'x' }), { 1: 100 });
});
