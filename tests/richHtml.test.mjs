import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRichHtmlCommandBridge,
  buildRichHtmlDocument,
  isViewportRichHtml,
  needsRichHtmlRendering,
  resolveViewportCardHeight,
  shouldRenderRichHtml,
  splitFullHtmlDocument,
  stripMarkdownFences,
  RICH_HTML_LIST_PREVIEW_MAX_HEIGHT,
  RICH_HTML_SCROLL_PREVIEW_HEIGHT,
  RICH_HTML_SCROLL_THRESHOLD,
} from '../src/richHtml.js';

test('视口卡片高度：宿主实测优先，估算一律封顶', () => {
  // Modal 场景：信宿主实测高度
  assert.equal(resolveViewportCardHeight({ windowHeight: 800, fullWidth: true, hostHeight: 645 }), 645);
  // 宿主高度过小时仍保底 320
  assert.equal(resolveViewportCardHeight({ windowHeight: 800, fullWidth: true, hostHeight: 100 }), 320);
  // 列表预览：0.72 * 屏高，低于上限时按比例
  assert.equal(resolveViewportCardHeight({ windowHeight: 640, fullWidth: false }), 461);
  // 估算路径无论是否全宽都封顶，避免长屏手机把聊天区挤没
  assert.equal(resolveViewportCardHeight({ windowHeight: 1000, fullWidth: false }), RICH_HTML_LIST_PREVIEW_MAX_HEIGHT);
  assert.equal(resolveViewportCardHeight({ windowHeight: 1000, fullWidth: true }), RICH_HTML_LIST_PREVIEW_MAX_HEIGHT);
  // 窗口高度未知时按 640 估算
  assert.equal(resolveViewportCardHeight({ windowHeight: 0, fullWidth: false }), 461);
});

test('滚动阈值与固定预览高度分离', () => {
  assert.ok(RICH_HTML_SCROLL_THRESHOLD < 24000);
  assert.ok(RICH_HTML_SCROLL_THRESHOLD > RICH_HTML_SCROLL_PREVIEW_HEIGHT);
  assert.equal(RICH_HTML_SCROLL_PREVIEW_HEIGHT, 480);
});

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

test('剥离围栏时保留 pre/code 内部代码围栏', () => {
  const input = '```html\n<pre><code>```js\nconst x = 1;\n```</code></pre>\n```';
  const output = stripMarkdownFences(input);
  assert.ok(output.includes('```js'));
  assert.equal((output.match(/```/g) || []).length, 2);
});

test('包装文档包含视口、正文与高度桥', () => {
  const doc = buildRichHtmlDocument({
    bodyHtml: '```html\n<div class="x">hi</div>\n```',
    heightToken: 'height-token',
  });
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
  assert.ok(doc.includes('*,*::before,*::after{box-sizing:border-box!important;}'));
  assert.ok(doc.includes('margin:0!important;padding:0!important'));
  assert.ok(doc.includes('details>div{width:100%!important;max-width:100%!important;min-width:0!important;box-sizing:border-box!important;}'));
  assert.ok(doc.includes('overflow-y:auto!important'));
  assert.ok(doc.includes('main{max-width:100%!important;overflow-x:hidden!important;overflow-y:auto!important;}'));
  assert.ok(doc.includes('Content-Security-Policy'));
  assert.ok(doc.includes("connect-src 'none'"));
  assert.ok(doc.includes("base-uri 'none'"));
  // 允许卡片自带的远程图片与视频，同时保持脚本无法联网
  assert.ok(doc.includes("img-src 'self' data: blob: https:"));
  assert.ok(doc.includes("media-src 'self' data: blob: https:"));
  assert.ok(doc.includes('var heightToken = "height-token"'));
  assert.ok(doc.includes('nativePostMessage'));
  assert.equal(doc.includes('window.triggerSlash'), false);
  // 展开/收起后重新测量高度
  assert.ok(doc.includes('"toggle"'));
  assert.ok(doc.includes('getBoundingClientRect'));
  assert.ok(doc.includes('requestAnimationFrame'));
});

test('完整 HTML 角色卡直接作为 WebView 文档并注入高度桥', () => {
  const source = '<div>外层容器<!DOCTYPE html><html><head><title>Card</title><script>window.__userScriptRan = true;</script></head><body><main>开局</main><script>run()</script></body></html></div>';
  const doc = buildRichHtmlDocument({ bodyHtml: source, heightToken: 'height-token' });
  const commandBridge = buildRichHtmlCommandBridge('command-token');
  assert.equal((doc.match(/<!DOCTYPE/gi) || []).length, 1);
  assert.equal((doc.match(/<html[\s>]/gi) || []).length, 1);
  assert.ok(doc.includes('data-easychat2-runtime'));
  assert.ok(doc.includes('min-width:0!important'));
  assert.equal(doc.includes('body *{max-height:none !important;}'), false);
  assert.ok(doc.includes('var heightToken = "height-token"'));
  assert.ok(commandBridge.includes('var commandToken = "command-token"'));
  assert.ok(commandBridge.includes('event.isTrusted'));
  assert.ok(commandBridge.includes('nativePostMessage'));
  assert.equal(commandBridge.includes('<script>'), false);
  assert.equal(doc.includes('command-token'), false);
  assert.ok(doc.includes('<main>开局</main>'));
});

test('完整文档前后的正文被保留进 body', () => {
  const source = '开场白第一段\n开场白第二段\n<!DOCTYPE html><html><head><title>Card</title></head><body><main>界面</main></body></html>\n结尾补充';
  const doc = buildRichHtmlDocument({ bodyHtml: source, heightToken: 'height-token' });
  assert.ok(doc.includes('开场白第一段'));
  assert.ok(doc.includes('开场白第二段'));
  assert.ok(doc.includes('结尾补充'));
  assert.ok(doc.includes('data-easychat2-preamble="before"'));
  assert.ok(doc.includes('data-easychat2-preamble="after"'));
  // 前置正文只出现一次，且不再丢掉
  assert.equal((doc.match(/开场白第一段/g) || []).length, 1);
});

test('拆分完整文档，保留前置叙事与后置正文', () => {
  const source = '开场白第一段\n开场白第二段\n<!DOCTYPE html><html><head><style>.app{height:100vh}</style></head><body><main>界面</main></body></html>\n结尾补充';
  const parts = splitFullHtmlDocument(source);
  assert.ok(parts);
  assert.ok(parts.before.includes('开场白第一段'));
  assert.ok(parts.before.includes('开场白第二段'));
  assert.ok(parts.document.startsWith('<!DOCTYPE html>'));
  assert.ok(parts.document.includes('height:100vh'));
  assert.equal(parts.before.includes('<!DOCTYPE'), false);
  assert.equal(parts.after.trim(), '结尾补充');
  assert.equal(splitFullHtmlDocument('只有正文，没有文档'), null);
});

test('识别视口型文档样式', () => {
   assert.equal(isViewportRichHtml('<style>.app{height:100vh;overflow:hidden}</style>'), true);
   assert.equal(isViewportRichHtml('<style>.x{height:100dvh}</style>'), true);
  // 根级 position:fixed 是视口型；四边钉死的 fixed 承载容器（如 #app 整屏卡）也是
   assert.equal(isViewportRichHtml('<style>body{position:fixed;inset:0}</style>'), true);
   assert.equal(isViewportRichHtml('<style>html{position:fixed}</style>'), true);
   assert.equal(isViewportRichHtml('<style>:root{position:fixed}</style>'), true);
   assert.equal(isViewportRichHtml('<style>.x{position:fixed;inset:0}</style>'), true);
   assert.equal(isViewportRichHtml('<style>#app{position:fixed;top:0;right:0;bottom:0;left:0}</style>'), true);
   assert.equal(isViewportRichHtml('<div style="position:fixed;inset:0"></div>'), true);
   assert.equal(isViewportRichHtml('<div style="height:100vh"></div>'), true);
   assert.equal(isViewportRichHtml('<!-- <style>.x{height:100vh}</style> -->'), false);
   assert.equal(isViewportRichHtml('<script>const demo = "<div style=\\"height:100vh\\"></div>";</script>'), false);
   assert.equal(isViewportRichHtml('<style>.x{height:200px}</style>'), false);
    assert.equal(isViewportRichHtml('普通文本没有样式'), false);
    assert.equal(isViewportRichHtml('<pre>&lt;div style="height:100vh"&gt;</pre>'), false);
    assert.equal(isViewportRichHtml('<div data-style="height:100vh"></div>'), false);
 });

test('含 fixed 子元素的普通卡片不判为视口型文档', () => {
  // 悬浮角标/挂件：整卡不应因此失去直接交互、被推入全屏 Modal 路径
  assert.equal(
    isViewportRichHtml('<div>正文按钮区</div><span style="position:fixed;top:0;right:0">角标</span>'),
    false
  );
  assert.equal(
    isViewportRichHtml('<style>.badge{position:fixed;top:8px;right:8px}</style><div>卡片内容</div>'),
    false
  );
  // 声明值里的裸词 body/html 不构成根选择器：根匹配只打在选择器部分
  assert.equal(
    isViewportRichHtml('<style>.banner{position:fixed;background:url(/body.png)}</style>'),
    false
  );
  assert.equal(
    isViewportRichHtml('<style>.panel{position:fixed;font-family:"My body Font";top:12px;right:12px}</style>'),
    false
  );
  // 非根类名含 body 也不误判
  assert.equal(
    isViewportRichHtml('<style>.body-wrap{position:fixed;top:0}</style>'),
    false
  );
  // 但 <body> 内联 fixed 仍算视口型
  assert.equal(isViewportRichHtml('<body style="position:fixed">面板</body>'), true);
});

test('含 fixed 子元素的普通卡片不判为视口型文档', () => {
  // 悬浮角标/挂件：整卡不应因此失去直接交互、被推入全屏 Modal 路径
  assert.equal(
    isViewportRichHtml('<div>正文按钮区</div><span style="position:fixed;top:0;right:0">角标</span>'),
    false
  );
  assert.equal(
    isViewportRichHtml('<style>.badge{position:fixed;top:8px;right:8px}</style><div>卡片内容</div>'),
    false
  );
  // 但 html/body 内联 fixed 仍算视口型
  assert.equal(isViewportRichHtml('<body style="position:fixed">面板</body>'), true);
});

test('完整文档缺少 viewport meta 时自动补齐', () => {
  const doc = buildRichHtmlDocument({
    bodyHtml: '<!DOCTYPE html><html><head><title>Card</title></head><body>内容</body></html>',
  });
  assert.equal((doc.match(/name="viewport"/g) || []).length, 1);
});
