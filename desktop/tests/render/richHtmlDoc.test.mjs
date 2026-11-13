// 富 HTML iframe 文档构造（Node 直测）：脚本剥离、CSP 收紧、命令按钮转换、本地图片改写。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IFRAME_CSP,
  buildIframeDocument,
  extractSendCommand,
  prepareIframeHtml,
  rewriteLocalMediaSources,
  stripScripts,
} from '../../src/render/richHtmlDoc.js';

test('prepareIframeHtml：onclick triggerSlash 转成 data-command', () => {
  const html = '<button class="x" onclick="triggerSlash(\'/send 你好\')">点我</button>';
  const prepared = prepareIframeHtml(html);
  assert.match(prepared, /data-command="%E4%BD%A0%E5%A5%BD"/);
  assert.match(prepared, /class="x"/, '原有属性必须保留');
});

test('prepareIframeHtml：已有 data-command 不重复转换', () => {
  const html = '<button data-command="abc">x</button>';
  assert.equal(prepareIframeHtml(html), html);
  assert.equal(extractSendCommand("triggerSlash('/send hi there')"), 'hi there');
  assert.equal(extractSendCommand('alert(1)'), '');
});

test('stripScripts：成对与未闭合 script 都删除', () => {
  assert.equal(stripScripts('a<script>bad()</script>b'), 'ab');
  // 未闭合的 <script> 之后的内容都在脚本里，必须一起丢弃（浏览器解析同样如此）。
  assert.equal(stripScripts('a<script src="x.js">b'), 'a');
});

test('buildIframeDocument：严格 CSP、无脚本、保留样式与结构', () => {
  const html = [
    '<style>.card{color:red}</style>',
    '<div class="card" id="card">内容</div>',
    '<details><summary>展开</summary><p>折叠正文</p></details>',
    '<script>window.__pwned=1</script>',
  ].join('\n');
  const document = buildIframeDocument({ html, textColor: '#fff', linkColor: '#00f', fontSize: 15 });
  assert.match(document, new RegExp(`http-equiv="Content-Security-Policy" content="${IFRAME_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(document, /script-src 'none'/);
  assert.ok(!/<script\b/i.test(document), '任何 script 标签都必须被删除');
  assert.ok(!document.includes('ReactNativeWebView'), 'Android 高度桥脚本不得进入桌面文档');
  assert.match(document, /<style>\.card\{color:red\}<\/style>/, '卡片样式必须保留');
  assert.match(document, /<details>/);
  assert.match(document, /id="card"/);
  assert.match(document, /html,body\{min-height:0!important;\}/, '桌面测高需要覆盖共享层的 min-height:100%');
});

test('buildIframeDocument：完整 HTML 文档也能注入 CSP 并剥离脚本', () => {
  const document = buildIframeDocument({
    html: '<!doctype html><html><head><style>body{background:#123}</style></head><body>hi<script>x()</script></body></html>',
  });
  assert.match(document, /^<!doctype html>/i);
  assert.match(document, /<style>body\{background:#123\}<\/style>/);
  assert.ok(!/<script\b/i.test(document));
  assert.match(document, /script-src 'none'/);
});

test('rewriteLocalMediaSources：documents 内的 file:// 改成媒体协议', () => {
  const html = '<img src="file:///C:/Users/u/AppData/Roaming/EasyChat2/chat-images/a.png"><video src="file:///C:/Windows/x.mp4"></video>';
  const rewritten = rewriteLocalMediaSources(html);
  assert.match(rewritten, /src="easychat2-media:\/\/media\/chat-images\/a\.png"/);
  assert.match(rewritten, /src="file:\/\/\/C:\/Windows\/x\.mp4"/, '越界路径保持原样（由 CSP 拦下）');
});
