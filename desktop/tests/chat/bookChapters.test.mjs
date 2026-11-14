// 书籍分章阅读的共享层契约测试（桌面 BookReader 依赖这三块）。
//
// 桌面不复刻手机的「隐藏 Text 测量 + 逐行分页」，但**分章、目录、进度口径**必须与
// 手机完全一致——否则同一本书在两端显示不同的章、同一章在两端算出不同的百分比。
// 这三块都在共享层，本测试钉住它们的实际行为。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChapterList, detectChapterTitle, splitBookIntoBlocks } from '../../../src/books/blocks.js';
import { computeChapterPercent, mergeChapterProgress, normalizeChapterProgress } from '../../../src/books/chapterProgress.js';

const BOOK = [
  '第一章 启程',
  '他推开门，天还没亮。',
  '',
  '第二章 途中',
  '路上遇到一只猫。',
  '',
  '第三章 抵达',
  '天黑时终于到了。',
].join('\n');

test('splitBookIntoBlocks：按「第X章」切成块，块带 title 与 index', () => {
  const blocks = splitBookIntoBlocks(BOOK);
  assert.ok(blocks.length >= 3, `应切成至少 3 块，实际 ${blocks.length}`);
  assert.equal(blocks[0].title, '第一章 启程');
  assert.equal(blocks[1].title, '第二章 途中');
  assert.equal(blocks[2].title, '第三章 抵达');
  // index 必须连续（桌面按 blockIndex 定位章节）。
  blocks.forEach((block, index) => assert.equal(block.index, index));
  // 正文不能丢。
  assert.ok(blocks[0].text.includes('他推开门'));
});

test('buildChapterList：从块里抽目录，连续同名标题合并', () => {
  // 超长正文会被切成多块，同一章可能跨块 —— 目录里不该出现重复章名。
  const long = `第一章 长夜\n${'内容。'.repeat(4000)}\n第二章 天明\n结尾。`;
  const blocks = splitBookIntoBlocks(long, { maxBlockChars: 2000 });
  const chapters = buildChapterList(blocks);
  const titles = chapters.map(item => item.title);
  // 相邻重复必须已合并。
  for (let i = 1; i < titles.length; i += 1) {
    assert.notEqual(titles[i], titles[i - 1], `目录出现相邻重复：${titles[i]}`);
  }
  assert.ok(titles.includes('第一章 长夜'));
  assert.ok(titles.includes('第二章 天明'));
});

test('buildChapterList：没有标题的书返回空目录（桌面据此显示「无可识别章节」）', () => {
  const blocks = splitBookIntoBlocks('一段没有章节标题的普通正文。\n再接一段。');
  assert.deepEqual(buildChapterList(blocks), []);
});

test('detectChapterTitle：认得常见的章标题样式', () => {
  assert.equal(detectChapterTitle('第一章 启程'), '第一章 启程');
  assert.equal(detectChapterTitle('第12章 归来'), '第12章 归来');
  assert.equal(detectChapterTitle('这只是一句普通的话。'), '');
});

test('computeChapterPercent：章内进度按「所在章 → 下一章」区间算', () => {
  const blocks = splitBookIntoBlocks(BOOK);
  const chapters = buildChapterList(blocks);
  assert.ok(chapters.length >= 3);

  // 第一章开头：接近 0。
  const atStart = computeChapterPercent({
    chapterEntries: chapters,
    blockCount: blocks.length,
    blockIndex: chapters[0].blockIndex,
    pageIndex: 0,
    pageCount: 10,
  });
  assert.ok(atStart !== null && atStart <= 20, `章首百分比应很小，实际 ${atStart}`);

  // 第一章末尾（pageIndex=9/pageCount=10）：应高于章首。
  const atEnd = computeChapterPercent({
    chapterEntries: chapters,
    blockCount: blocks.length,
    blockIndex: chapters[0].blockIndex,
    pageIndex: 9,
    pageCount: 10,
  });
  assert.ok(atEnd > atStart, `章末应大于章首：${atEnd} vs ${atStart}`);

  // 最后一章末尾：接近 100。
  const last = chapters[chapters.length - 1];
  const atLastEnd = computeChapterPercent({
    chapterEntries: chapters,
    blockCount: blocks.length,
    blockIndex: last.blockIndex,
    pageIndex: 9,
    pageCount: 10,
  });
  assert.ok(atLastEnd >= 90, `末章末应接近 100，实际 ${atLastEnd}`);
});

test('computeChapterPercent：传错形状返回 null（桌面因此必须传章节数组）', () => {
  // 传块数量（数字）而不是章节数组：必须返回 null，不能静默算成 0。
  // 桌面 BookReader 早期就是这么写的 —— 结果是进度永远不落盘。
  assert.equal(computeChapterPercent({
    chapterEntries: 5,
    blockCount: 5,
    blockIndex: 0,
    pageIndex: 0,
    pageCount: 1,
  }), null);
  assert.equal(computeChapterPercent({ chapterEntries: [], blockCount: 0, blockIndex: 0 }), null);
});

test('normalizeChapterProgress 与 mergeChapterProgress：只增不降', () => {
  const normalized = normalizeChapterProgress({ 0: 40, 3: 120, bad: 5, '02': 30, 5: -8 });
  // 非法键（bad / '02'）丢弃；120 clamp 到 100；-8 clamp 到 0。
  assert.deepEqual(normalized, { 0: 40, 3: 100, 5: 0 });
  // 回翻旧页不降进度（存储层不变量）。
  const merged = mergeChapterProgress({ 0: 80, 1: 20 }, { 0: 30, 1: 60 });
  assert.equal(merged['0'], 80, '同章取历史最大值');
  assert.equal(merged['1'], 60);
});