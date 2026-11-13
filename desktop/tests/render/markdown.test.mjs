// Markdown 渲染的安全边界（Node 直测）：原始 HTML / 危险链接 / 图片来源 / 长度上限。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  renderMarkdownHtml,
  safeImageSrc,
  safeLinkHref,
} from '../../src/render/markdown.js';

test('Markdown：基础语法渲染为 HTML', () => {
  const { html, truncated } = renderMarkdownHtml('**加粗OK**\n\n- 一\n- 二');
  assert.equal(truncated, false);
  assert.match(html, /<strong>加粗OK<\/strong>/);
  assert.match(html, /<ul>\s*<li>一<\/li>\s*<li>二<\/li>\s*<\/ul>/);
});

test('Markdown：原始 HTML 一律转义，不产生可执行标签', () => {
  const { html } = renderMarkdownHtml('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>');
  assert.ok(html.includes('&lt;img'), '尖括号必须被转义');
  assert.ok(!/<img\b/i.test(html), '不允许出现真实 img 标签');
  assert.ok(!/<script\b/i.test(html), '不允许出现真实 script 标签');
});

test('Markdown：javascript:/data: 链接降级为纯文本', () => {
  const blocked = renderMarkdownHtml('[点我](javascript:alert(1))').html;
  assert.ok(!/href\s*=/i.test(blocked), '危险 scheme 不应生成 href');
  assert.match(blocked, /点我/);
  const dataLink = renderMarkdownHtml('[数据](data:text/html,<b>x</b>)').html;
  assert.ok(!/href\s*=/i.test(dataLink));
});

test('Markdown：http/https/mailto 链接保留并带 rel', () => {
  const { html } = renderMarkdownHtml('[链接](https://example.com/a "标题")');
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.equal(safeLinkHref('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(safeLinkHref(' java\nscript:alert(1)'), '');
});

test('Markdown：本地图片 file:// 改写为媒体协议，越界来源降级为 alt 文本', () => {
  const mapped = safeImageSrc('file:///C:/Users/u/AppData/Roaming/EasyChat2/stickers/a.png');
  assert.equal(mapped, 'easychat2-media://media/stickers/a.png');
  assert.equal(safeImageSrc('file:///C:/Windows/System32/secret.png'), '');
  assert.equal(safeImageSrc('javascript:alert(1)'), '');
  assert.equal(safeImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  const { html } = renderMarkdownHtml('![图](javascript:alert(1))');
  assert.ok(!/<img\b/i.test(html), '危险图片地址不生成 img');
  assert.match(html, /图/);
});

test('Markdown：超长文本按共享上限截断并带提示', () => {
  const longText = 'a'.repeat(20050);
  const { html, truncated } = renderMarkdownHtml(longText);
  assert.equal(truncated, true);
  assert.ok(html.length < longText.length);
  assert.match(html, /已截断显示/);
});

test('escapeHtml：五个字符全部转义', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
