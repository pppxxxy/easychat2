import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRichHtmlDocument,
  needsRichHtmlRendering,
  shouldRenderRichHtml,
  stripMarkdownFences,
} from '../src/richHtml.js';

test('含内置渲染器不支持标签的消息才需要 WebView', () => {
  assert.equal(needsRichHtmlRendering('普通文本'), false);
  assert.equal(needsRichHtmlRendering('<div style="color:red">x</div>'), false);
  assert.equal(needsRichHtmlRendering('<style>.a{}</style>'), true);
  assert.equal(needsRichHtmlRendering('<script>1</script>'), true);
  // 只有内联样式的卡片也可能用 <details> 做折叠，RenderHtml 会丢弃，必须走 WebView
  assert.equal(needsRichHtmlRendering('<details><summary>标题</summary>内容</details>'), true);
  assert.equal(needsRichHtmlRendering('<svg><circle/></svg>'), true);
  assert.equal(needsRichHtmlRendering('<video controls src="video.mp4"></video>'), true);
});

test('折叠卡片始终使用 WebView，避免 summary 被内置渲染器丢弃', () => {
  assert.equal(
    shouldRenderRichHtml('<details><summary>状态栏</summary><div>正文</div></details>', false),
    true
  );
  assert.equal(shouldRenderRichHtml('<style>.a{}</style>', false), false);
  assert.equal(shouldRenderRichHtml('<script>1</script>', false), false);
});

test('富 HTML 渲染受开关控制，缺省开启', () => {
  assert.equal(shouldRenderRichHtml('<style>.a{}</style>', true), true);
  assert.equal(shouldRenderRichHtml('<style>.a{}</style>'), true);
  assert.equal(shouldRenderRichHtml('普通文本', true), false);
});

test('剥离 ```html 围栏行，保留正文', () => {
  const input = '前言\n```html\n<details><summary>标题</summary></details>\n```\n后记';
  const output = stripMarkdownFences(input);
  assert.ok(!output.includes('```'));
  assert.ok(output.includes('<details>'));
  assert.ok(output.includes('前言'));
  assert.ok(output.includes('后记'));
});

test('包装文档包含视口、正文与高度桥', () => {
  const doc = buildRichHtmlDocument({ bodyHtml: '```html\n<div class="x">hi</div>\n```' });
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.ok(doc.includes('viewport'));
  assert.ok(doc.includes('<div class="x">hi</div>'));
  assert.ok(!doc.includes('```'));
  assert.ok(doc.includes('ReactNativeWebView'));
  assert.ok(doc.includes('ResizeObserver'));
  // 解除卡片内层 max-height，避免折叠区在关闭滚动的 WebView 里被裁
  assert.ok(doc.includes('max-height:none'));
  assert.ok(doc.includes('details{display:block!important'));
  assert.ok(doc.includes('flex:0 0 100%!important'));
  // 展开/收起后重新测量高度
  assert.ok(doc.includes('"toggle"'));
  assert.ok(doc.includes('getBoundingClientRect'));
  assert.ok(doc.includes('requestAnimationFrame'));
});

test('完整 HTML 角色卡直接作为 WebView 文档并注入运行时桥', () => {
  const source = '<div>外层容器<!DOCTYPE html><html><head><title>Card</title></head><body><main>开局</main><script>run()</script></body></html></div>';
  const doc = buildRichHtmlDocument({ bodyHtml: source });
  assert.equal((doc.match(/<!DOCTYPE/gi) || []).length, 1);
  assert.equal((doc.match(/<html[\s>]/gi) || []).length, 1);
  assert.ok(doc.includes('data-easychat2-runtime'));
  assert.ok(doc.includes('min-width:0!important'));
  assert.equal(doc.includes('body *{max-height:none !important;}'), false);
  assert.ok(doc.includes('window.triggerSlash'));
  assert.ok(doc.includes('<main>开局</main>'));
});
