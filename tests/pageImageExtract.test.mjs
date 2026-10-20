// 页面主图提取（纯函数）：og:image 优先级 / 相对地址解析 / 兜底与去重 / 坏输入。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPageImageCandidates,
  looksLikeImageUrl,
  resolveResourceUrl,
} from '../src/chat/pageImageExtract.js';

test('resolveResourceUrl：绝对 / 协议相对 / 根相对 / 相对路径 / 查询；非法 scheme 拒绝', () => {
  const base = 'https://www.pixiv.net/artworks/123?x=1';
  assert.equal(resolveResourceUrl(base, 'https://cdn.x.com/a.jpg'), 'https://cdn.x.com/a.jpg');
  assert.equal(resolveResourceUrl(base, '//cdn.x.com/a.jpg'), 'https://cdn.x.com/a.jpg');
  assert.equal(resolveResourceUrl(base, '/img/a.jpg'), 'https://www.pixiv.net/img/a.jpg');
  assert.equal(resolveResourceUrl(base, 'a.jpg'), 'https://www.pixiv.net/artworks/a.jpg');
  assert.equal(resolveResourceUrl(base, '../a.jpg'), 'https://www.pixiv.net/artworks/../a.jpg');
  assert.equal(resolveResourceUrl('http://x.com/a/b', '?q=1'), 'http://x.com/a/b?q=1');
  assert.equal(resolveResourceUrl(base, 'data:image/png;base64,xx'), '');
  assert.equal(resolveResourceUrl(base, 'javascript:alert(1)'), '');
  assert.equal(resolveResourceUrl(base, ''), '');
  assert.equal(resolveResourceUrl('not-a-url', 'a.jpg'), '');
});

test('looksLikeImageUrl：常见扩展名（含查询串）；无扩展名不算', () => {
  assert.equal(looksLikeImageUrl('https://a.com/x.jpg'), true);
  assert.equal(looksLikeImageUrl('https://a.com/x.JPEG?w=1'), true);
  assert.equal(looksLikeImageUrl('https://a.com/x.webp#z'), true);
  assert.equal(looksLikeImageUrl('https://a.com/image/12345'), false);
  assert.equal(looksLikeImageUrl('https://a.com/x.svg'), false);
});

test('extractPageImageCandidates：优先级（secure_url > og:image > twitter > link > img）', () => {
  const html = `
    <html><head>
      <meta name="twitter:image" content="/tw.jpg">
      <meta property="og:image" content="https://cdn.x.com/og.jpg">
      <meta property="og:image:secure_url" content="https://cdn.x.com/secure.jpg">
      <link rel="image_src" href="https://cdn.x.com/link.jpg">
    </head><body><img src="https://cdn.x.com/body.jpg"></body></html>`;
  assert.deepEqual(extractPageImageCandidates(html, 'https://site.com/p/1'), [
    'https://cdn.x.com/secure.jpg',
    'https://cdn.x.com/og.jpg',
    'https://site.com/tw.jpg',
    'https://cdn.x.com/link.jpg',
  ]);
});

test('extractPageImageCandidates：属性顺序 / 单引号 / 大写标签 / &amp; 实体', () => {
  const html = `<META CONTENT='https://cdn.x.com/a.jpg?x=1&amp;y=2' PROPERTY='og:image'>`;
  assert.deepEqual(extractPageImageCandidates(html, 'https://site.com/'), [
    'https://cdn.x.com/a.jpg?x=1&y=2',
  ]);
});

test('extractPageImageCandidates：无声明主图时才用 <img> 兜底（限 5 个、只收图片扩展名）', () => {
  const imgs = Array.from({ length: 8 }, (_, i) => `<img src="/i${i}.png">`).join('');
  const html = `<body><img src="/logo.svg">${imgs}</body>`;
  const list = extractPageImageCandidates(html, 'https://site.com/gallery');
  assert.equal(list.length, 5, '<img> 兜底最多 5 个');
  assert.equal(list[0], 'https://site.com/i0.png');
  // 有 og:image 时 <img> 不应混进候选
  const withOg = extractPageImageCandidates(
    `<meta property="og:image" content="https://cdn.x.com/og.jpg"><img src="/x.png">`,
    'https://site.com/'
  );
  assert.deepEqual(withOg, ['https://cdn.x.com/og.jpg']);
});

test('extractPageImageCandidates：去重 / 上限 / 坏输入 / itemprop=image', () => {
  const html = `
    <meta property="og:image" content="https://cdn.x.com/a.jpg">
    <meta property="og:image" content="https://cdn.x.com/a.jpg">
    <meta itemprop="image" content="https://cdn.x.com/b.jpg">`;
  assert.deepEqual(extractPageImageCandidates(html, 'https://site.com/'), [
    'https://cdn.x.com/a.jpg',
    'https://cdn.x.com/b.jpg',
  ]);
  assert.equal(
    extractPageImageCandidates(html, 'https://site.com/', { max: 1 }).length,
    1,
    'max 收敛'
  );
  assert.deepEqual(extractPageImageCandidates('', 'https://site.com/'), []);
  assert.deepEqual(extractPageImageCandidates(null, 'https://site.com/'), []);
  assert.deepEqual(extractPageImageCandidates('<meta property="og:image">', 'https://site.com/'), []);
  // 非 http(s) 的 content 不进候选
  assert.deepEqual(
    extractPageImageCandidates('<meta property="og:image" content="data:image/png;base64,x">', 'https://s.com/'),
    []
  );
});
