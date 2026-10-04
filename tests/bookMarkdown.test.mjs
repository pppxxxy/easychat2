// Markdown 书籍渲染的纯函数测试：ATX 标题识别、markdown 分块、格式判定与样式工厂。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChapterList, detectMarkdownHeading, splitBookIntoBlocks } from '../src/books/blocks.js';
import {
  MARKDOWN_FORMATS,
  createBookMarkdownStyles,
  isMarkdownBook,
  markdownExcerpt,
} from '../src/books/markdownBook.js';

test('detectMarkdownHeading：ATX 标题识别与边界', () => {
  assert.equal(detectMarkdownHeading('# 第一章 归来'), '第一章 归来');
  assert.equal(detectMarkdownHeading('###### 六级标题'), '六级标题');
  assert.equal(detectMarkdownHeading('### 小节 ###'), '小节', '行尾闭合 # 剥离');
  assert.equal(detectMarkdownHeading('####### too many'), '', '7 个 # 不算标题');
  assert.equal(detectMarkdownHeading('#no-space'), '', '缺空格不算标题');
  assert.equal(detectMarkdownHeading('正文 # 井号'), '', '行首不是 # 不算');
  assert.equal(detectMarkdownHeading(''), '');
  assert.equal(detectMarkdownHeading(`# ${'长'.repeat(61)}`), '', '超长标题不判章节');
});

test('markdown 分块：标题开新块并进目录，纯文本模式不误判', () => {
  const md = [
    '# 序章',
    '开场白。',
    '',
    '## 第一幕',
    '第一幕正文。'.repeat(50),
    '',
    '# 尾声',
    '结束。',
  ].join('\n');
  const blocks = splitBookIntoBlocks(md, { markdown: true, maxBlockChars: 2000 });
  assert.equal(blocks[0].title, '序章');
  const chapters = buildChapterList(blocks);
  assert.deepEqual(chapters.map(chapter => chapter.title), ['序章', '第一幕', '尾声']);
  blocks.forEach(block => {
    assert.equal(md.slice(block.charStart, block.charStart + block.text.length), block.text,
      `块 ${block.index} 的 charStart 必须对回原文`);
  });

  const plain = splitBookIntoBlocks(md, { markdown: false, maxBlockChars: 2000 });
  assert.equal(plain[0].title, '', '纯文本模式不把 # 行当章节');
});

test('isMarkdownBook：md/markdown 命中，txt/docx/空 不命中', () => {
  assert.equal(isMarkdownBook({ format: 'md' }), true);
  assert.equal(isMarkdownBook({ format: 'Markdown' }), true);
  assert.equal(isMarkdownBook({ format: 'txt' }), false);
  assert.equal(isMarkdownBook({ format: 'docx' }), false);
  assert.equal(isMarkdownBook({}), false);
  assert.equal(isMarkdownBook(null), false);
  assert.deepEqual(MARKDOWN_FORMATS, ['md', 'markdown']);
});

test('markdownExcerpt：去首尾空白并按上限截断', () => {
  assert.equal(markdownExcerpt('  hello  '), 'hello');
  assert.equal(markdownExcerpt('abcdef', 3), 'abc');
  assert.equal(markdownExcerpt('', 10), '');
  assert.equal(markdownExcerpt('x', 0), 'x', '非法上限退回默认值');
});

test('createBookMarkdownStyles：跟随字号缩放、关键节点齐全、缺省可用', () => {
  const styles = createBookMarkdownStyles({
    colors: { text: '#fff', primary: '#6c63ff', surfaceAlt: '#222' },
    fontSize: 20,
    lineHeight: 35,
    tokens: { radius: { sm: 6 } },
  });
  assert.equal(styles.body.fontSize, 20);
  assert.equal(styles.body.lineHeight, 35);
  assert.ok(styles.heading1.fontSize > styles.body.fontSize, '一级标题必须大于正文');
  assert.ok(styles.code_block && styles.blockquote && styles.link && styles.bullet_list_content,
    '代码块/引用/链接/列表节点样式齐全');
  assert.equal(styles.link.color, '#6c63ff');

  const fallback = createBookMarkdownStyles();
  assert.ok(fallback.body.fontSize > 0, '缺省参数不得抛错');
});
