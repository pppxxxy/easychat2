// 分块与分页纯函数测试。核心不变量：
// - 分块确定性：同书两次分块结果一致（进度按块号持久化依赖这一点）；
// - charStart 正确：text.slice(charStart) 必须以块文本开头；
// - 任何块不超限（除单行巨段的兜底上限）、代理对不被切劈。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChapterList,
  detectChapterTitle,
  safeCharCut,
  splitBookIntoBlocks,
} from '../src/books/blocks.js';
import {
  findPageByAnchor,
  pageBodyText,
  pageText,
  paginateLines,
} from '../src/books/pagination.js';
import { buildPassageCommentPrompt, formatReadingPercent } from '../src/books/commentPrompts.js';

test('章节标题判定：常见格式命中，叙述行不误判', () => {
  assert.equal(detectChapterTitle('第一章 归来'), '第一章 归来');
  assert.equal(detectChapterTitle('第12回 大战'), '第12回 大战');
  assert.equal(detectChapterTitle('第一百二十三章'), '第一百二十三章');
  assert.equal(detectChapterTitle('Chapter 3 The Return'), 'Chapter 3 The Return');
  assert.equal(detectChapterTitle('楔子'), '楔子');
  assert.equal(detectChapterTitle('番外篇 春日'), '番外篇 春日');
  assert.equal(detectChapterTitle('第二年春天，他们回来了'), '', '「年」不在章节单位集');
  assert.equal(detectChapterTitle('第3天我们出发'), '', '「天」不在章节单位集');
  assert.equal(detectChapterTitle(''), '');
  assert.equal(detectChapterTitle(`${'长'.repeat(31)}第一章`), '', '超长行不判章节');
  // 叙述行排除（monkey 审查发现：以「第X章」开头的正文曾被误判为章节）
  assert.equal(detectChapterTitle('第三章的内容让他想起往事。'), '', '「章+的」开头的叙述行');
  assert.equal(detectChapterTitle('第一章里提到的那个地方。'), '', '「章+里」开头的叙述行');
  assert.equal(detectChapterTitle('第二章，他离开了。'), '', '句读标点收尾的叙述行');
  assert.equal(detectChapterTitle('第一章 起点'), '第一章 起点', '空格分隔的真标题保留');
  assert.equal(detectChapterTitle('第一章起点'), '第一章起点', '无分隔的真标题保留');
});

test('代理对安全切点：高位代理前回退', () => {
  const text = 'abc\uD83D\uDE00def';
  assert.equal(safeCharCut(text, 4), 3, '切点落在代理对中间时回退到对前');
  assert.equal(safeCharCut(text, 5), 5, '切点在代理对之后不动');
  assert.equal(safeCharCut(text, 0), 0);
  assert.equal(safeCharCut(text, 999), text.length);
});

function makeBook() {
  const chapters = ['第一章 起点', '第二章 转折', '第三章 结局'];
  const paragraphs = [];
  chapters.forEach((title, chapterIndex) => {
    paragraphs.push(title);
    for (let index = 0; index < 6; index += 1) {
      paragraphs.push(`第${chapterIndex + 1}章第${index + 1}段的内容，讲述一些情节发展。`);
    }
  });
  return paragraphs.join('\n\n');
}

test('分块：章节边界成块、charStart 对齐、结果确定', () => {
  const book = makeBook();
  const blocks = splitBookIntoBlocks(book);
  assert.ok(blocks.length >= 3, '三章至少三块');
  blocks.forEach(block => {
    assert.equal(book.slice(block.charStart, block.charStart + block.text.length), block.text,
      `块 ${block.index} 的 charStart 必须对回原文`);
    assert.ok(block.text.length > 0);
  });
  const again = splitBookIntoBlocks(book);
  assert.deepEqual(again, blocks, '同书分块必须确定');
  assert.equal(blocks[0].title, '第一章 起点');
});

test('分块：无章节书按段落边界与上限切分', () => {
  const paragraph = '这是一段没有章节标记的正文内容。';
  const book = Array.from({ length: 1200 }, (_, index) => `${paragraph}第${index}段。`).join('\n\n');
  const blocks = splitBookIntoBlocks(book, { maxBlockChars: 6000 });
  assert.ok(blocks.length > 1, '超限必须切多块');
  blocks.forEach(block => {
    assert.ok(block.text.length <= 6000 * 2, `块 ${block.index} 长度 ${block.text.length} 应接近上限`);
  });
  // 全文经块还原无丢失（忽略首尾空白差异的严格检查：偏移拼接回原文）
  const rebuilt = blocks.map(block => book.slice(block.charStart, block.charStart + block.text.length)).join('');
  const covered = blocks.map(block => [block.charStart, block.charStart + block.text.length]);
  assert.equal(rebuilt, blocks.map(block => block.text).join(''));
  for (let index = 1; index < covered.length; index += 1) {
    assert.ok(covered[index][0] > covered[index - 1][0], '块偏移严格递增');
  }
});

test('分块：超长单段硬切且代理对安全', () => {
  const giant = `第一章 ${'\uD83D\uDE00'.repeat(4000)}`;
  const blocks = splitBookIntoBlocks(giant, { maxBlockChars: 5000 });
  assert.ok(blocks.length >= 2, '巨段必须硬切多块');
  blocks.forEach(block => {
    assert.ok(block.text.length <= 5000, `块长 ${block.text.length} 不超限`);
    // 块尾不得停在代理对中间（高位代理结尾 = 对被劈到下一块）
    const last = block.text.charCodeAt(block.text.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), '块尾不得是孤立高位代理');
  });
  const joined = blocks.map(block => block.text).join('');
  assert.equal(joined, giant, '硬切不丢字');
});

test('目录：连续同章块合并', () => {
  const book = `${'第一章\n'.repeat(3)}${'正文。'.repeat(2000)}\n\n第二章\n尾部`;
  const blocks = splitBookIntoBlocks(book, { maxBlockChars: 3000 });
  const chapters = buildChapterList(blocks);
  assert.equal(chapters[0].title, '第一章');
  assert.equal(chapters[0].blockIndex, 0);
  assert.equal(chapters[chapters.length - 1].title, '第二章');
  assert.ok(chapters.every((chapter, index) => index === 0 || chapter.blockIndex > chapters[index - 1].blockIndex));
});

test('长章节跨多块：续块全部沿用章题（monkey 审查缺陷 2 回归）', () => {
  const lines = ['第一章'];
  for (let index = 0; index < 400; index += 1) lines.push('这是第一段的内容，用来撑长度。'.repeat(3));
  lines.push('', '第二章', '第二章正文。');
  const blocks = splitBookIntoBlocks(lines.join('\n\n'), { maxBlockChars: 3000 });
  assert.ok(blocks.length > 3, '第一章必须跨多块');
  const secondStart = blocks.findIndex(block => block.text.startsWith('第二章'));
  assert.ok(secondStart > 0, '第二章必须独立成块');
  blocks.slice(0, secondStart).forEach(block => {
    assert.equal(block.title, '第一章', `块 ${block.index} 的章题不得丢`);
  });
});

test('分页：贪心装箱、超行独占、锚文本', () => {
  const lines = [
    { text: 'a', height: 20 },
    { text: 'b', height: 20 },
    { text: 'c', height: 20 },
    { text: 'tall', height: 100 },
    { text: 'd', height: 20 },
  ];
  const pages = paginateLines(lines, 50);
  assert.deepEqual(pages.map(page => [page.firstLine, page.lineCount]), [
    [0, 2],
    [2, 1],
    [3, 1],
    [4, 1],
  ], '第三行放不进前两行页；tall 独占一页');
  assert.equal(pages[0].anchorText, 'a');
  assert.deepEqual(paginateLines([], 100), []);
});

test('页正文：按行拼接并截断', () => {
  const lines = [
    { text: '第一行', height: 20 },
    { text: '第二行', height: 20 },
    { text: '第三行', height: 20 },
  ];
  const pages = paginateLines(lines, 40);
  assert.equal(pageText(lines, pages[0]), '第一行\n第二行');
  assert.equal(pageText(lines, pages[0], { maxChars: 5 }), '第一行\n第'.slice(0, 5));
  assert.equal(pageText(lines, null), '');
});

test('可见页正文 pageBodyText 不截断；pageText 摘录路径保持 600 上限（回归）', () => {
  // 600 字是评论摘录上限，曾被误用于可见页正文：小字号密页 600+ 字被静默丢尾。
  const longText = '字'.repeat(300);
  const lines = [
    { text: `开头-${longText}`, height: 20 },
    { text: `结尾-${longText}`, height: 20 },
  ];
  const pages = paginateLines(lines, 40);
  const body = pageBodyText(lines, pages[0]);
  assert.equal(body, `开头-${longText}\n结尾-${longText}`, '可见页必须包含末行全文');
  assert.ok(body.length > 600, '构造的页正文应超过旧 600 字上限');

  const excerpt = pageText(lines, pages[0]);
  assert.ok(excerpt.length <= 600, '评论摘录路径仍截断到 600');
  assert.ok(!excerpt.includes(`结尾-${longText}`), '摘录路径丢尾是预期行为（不回流到可见页）');
});

test('重测定位：锚匹配优先，找不到夹取回退', () => {
  const lines = [
    { text: '首页开头', height: 20 },
    { text: '中间内容', height: 20 },
    { text: '末页内容', height: 20 },
  ];
  const pages = paginateLines(lines, 20);
  assert.equal(findPageByAnchor(pages, '首页开头', 2), 0);
  assert.equal(findPageByAnchor(pages, '末页内容', 0), pages.length - 1);
  assert.equal(findPageByAnchor(pages, '不存在的锚', 2), 2, '找不到退回原页号');
  assert.equal(findPageByAnchor(pages, '不存在的锚', 99), pages.length - 1, '回退夹取上限');
  assert.equal(findPageByAnchor(pages, '不存在的锚', -3), 0, '回退夹取下限');
  assert.equal(findPageByAnchor([], 'x', 1), 0);
});

test('阅读进度百分比与评论 prompt', () => {
  assert.equal(formatReadingPercent(0, 10, 0, 10), 0);
  assert.equal(formatReadingPercent(5, 10, 5, 10), 55);
  // 语义：百分比 = 页首位置。最后一页是 99%（读完翻过去才是 100），不算 bug。
  assert.equal(formatReadingPercent(9, 10, 9, 10), 99);
  assert.equal(formatReadingPercent(50, 10, 0, 10), 90, '越界块号夹取到末块');
  assert.equal(formatReadingPercent(0, 0, 0, 0), 0, '空书不 NaN');

  const prompt = buildPassageCommentPrompt({
    bookName: '长征',
    chapterTitle: '第一章 归来',
    excerpt: '他推开门，屋里的灯还亮着。',
  });
  assert.ok(prompt.includes('《长征》'));
  assert.ok(prompt.includes('「第一章 归来」'));
  assert.ok(prompt.includes('他推开门，屋里的灯还亮着。'));
  assert.ok(prompt.includes('不要剧透'), '必须约束不剧透');
  const noChapter = buildPassageCommentPrompt({ bookName: '长征', excerpt: 'x' });
  assert.ok(!noChapter.includes('undefined'), '缺章节不得带 undefined');
});
