// web_fetch 测试：URL 准入（SSRF 守卫）、域名白名单、正文提取，以及
// 「准入失败必须在发请求之前」这条顺序不变量（Node 里没有 XMLHttpRequest，
// 一旦顺序错了测试会以 ReferenceError 失败而不是「悄悄发了请求」）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEB_FETCH_TEXT_MAX_CHARS,
  decodeHtmlEntities,
  extractReadableText,
  isDomainAllowed,
  isPrivateHost,
  normalizeFetchUrl,
  parseAllowedDomains,
  runWebFetch,
} from '../src/plugins/webFetch.js';

test('normalizeFetchUrl：放行公网 http/https，保留路径与查询', () => {
  const https = normalizeFetchUrl('https://example.com/news/1?q=2#top');
  assert.equal(https.ok, true);
  assert.equal(https.host, 'example.com');
  assert.equal(https.url, 'https://example.com/news/1?q=2#top');

  const http = normalizeFetchUrl('  http://EXAMPLE.com/a  ');
  assert.equal(http.ok, true);
  assert.equal(http.host, 'example.com', '主机名小写归一');

  // 端口与 userinfo 不干扰主机判定
  assert.equal(normalizeFetchUrl('https://user:pw@example.com:8443/x').host, 'example.com');
});

test('normalizeFetchUrl：拒绝空值、非 http(s) 协议与畸形输入', () => {
  assert.equal(normalizeFetchUrl('').reason, 'empty');
  assert.equal(normalizeFetchUrl(null).reason, 'empty');
  assert.equal(normalizeFetchUrl('   ').reason, 'empty');
  assert.equal(normalizeFetchUrl('ftp://example.com/a').reason, 'scheme');
  assert.equal(normalizeFetchUrl('file:///etc/passwd').reason, 'scheme');
  assert.equal(normalizeFetchUrl('javascript:alert(1)').reason, 'scheme');
  assert.equal(normalizeFetchUrl('example.com/a').reason, 'invalid', '缺协议不算有效网址');
  assert.equal(normalizeFetchUrl('https:///a').reason, 'invalid');
});

test('normalizeFetchUrl：拒绝本机与内网地址（SSRF 守卫）', () => {
  const blocked = [
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://router.local/',
    'http://panel.internal/',
  ];
  blocked.forEach(url => {
    const result = normalizeFetchUrl(url);
    assert.equal(result.ok, false, `${url} 必须被拒绝`);
    assert.equal(result.reason, 'private');
  });
  // 172.32 已出私有段；公网 IP 正常放行
  assert.equal(normalizeFetchUrl('http://172.32.0.1/').ok, true);
  assert.equal(normalizeFetchUrl('http://8.8.8.8/').ok, true);
});

test('isPrivateHost：空主机名视为不可信', () => {
  assert.equal(isPrivateHost(''), true);
  assert.equal(isPrivateHost(null), true);
  assert.equal(isPrivateHost('example.com'), false);
});

test('域名白名单：为空放行；配置后只放行命中域名（含子域）', () => {
  assert.deepEqual(parseAllowedDomains(''), []);
  assert.deepEqual(parseAllowedDomains('a.com, b.com；c.com d.com'), ['a.com', 'b.com', 'c.com', 'd.com']);
  assert.deepEqual(parseAllowedDomains('https://a.com/path'), ['a.com'], '容忍写成完整 URL');
  assert.deepEqual(parseAllowedDomains(['A.com', ' b.com ']), ['a.com', 'b.com']);

  assert.equal(isDomainAllowed('anything.example', ''), true, '没配白名单 = 公网全放行');
  assert.equal(isDomainAllowed('docs.example.com', 'example.com'), true, '子域命中');
  assert.equal(isDomainAllowed('example.com', 'example.com'), true, '自身命中');
  assert.equal(isDomainAllowed('evilexample.com', 'example.com'), false, '后缀相似不算命中');
  assert.equal(isDomainAllowed('example.com.evil.net', 'example.com'), false);
});

test('decodeHtmlEntities：具名、十进制、十六进制实体', () => {
  assert.equal(decodeHtmlEntities('a&amp;b&lt;c&gt;d&quot;e'), 'a&b<c>d"e');
  assert.equal(decodeHtmlEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeHtmlEntities('&nbsp;&mdash;'), ' —');
  assert.equal(decodeHtmlEntities('&unknown;'), '&unknown;', '未知实体原样保留');
  assert.equal(decodeHtmlEntities('&#x110000;'), '', '超范围码点不产生乱码');
});

test('extractReadableText：去脚本样式、保段落、取标题、解实体', () => {
  const html = [
    '<html><head><title>标题 &amp; 副标题</title>',
    '<style>body{color:red}</style><script>var x = "<p>假的段落</p>";</script></head>',
    '<body><h1>大标题</h1><p>第一段&nbsp;文字</p>',
    '<div>第二段</div><noscript>无脚本提示</noscript>',
    '<ul><li>条目一</li><li>条目二</li></ul></body></html>',
  ].join('');
  const result = extractReadableText(html);
  assert.equal(result.title, '标题 & 副标题');
  assert.equal(result.truncated, false);
  const lines = result.text.split('\n');
  assert.ok(lines.includes('大标题'));
  assert.ok(lines.includes('第一段 文字'), 'nbsp 归一成普通空格');
  assert.ok(lines.includes('第二段'));
  assert.ok(lines.includes('条目一') && lines.includes('条目二'), '列表项各自成行');
  assert.ok(!result.text.includes('color:red'), '样式内容不进来');
  assert.ok(!result.text.includes('假的段落'), '脚本内容不进来');
  assert.ok(!result.text.includes('无脚本提示'), 'noscript 内容不进来');
  assert.ok(!result.text.includes('<'), '没有残留标签');
});

test('extractReadableText：超长截断如实标记；空输入安全', () => {
  const long = extractReadableText(`<p>${'x'.repeat(100)}</p>`, { maxChars: 10 });
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 10);
  assert.equal(extractReadableText('').text, '');
  assert.equal(extractReadableText(null).text, '');
  assert.equal(extractReadableText('<div>只有标签</div>').text, '只有标签');
  assert.equal(WEB_FETCH_TEXT_MAX_CHARS > 0, true);
});

test('runWebFetch：准入失败在发请求之前抛错（本机 / 白名单外）', async () => {
  // Node 环境没有 XMLHttpRequest：若守卫顺序错了，这里会是 ReferenceError 而不是
  // 我们自己的错误文案——顺序不变量因此可测。
  await assert.rejects(
    () => runWebFetch({ url: 'http://127.0.0.1:8080/secret' }),
    error => error.fetchReason === 'private'
  );
  await assert.rejects(
    () => runWebFetch({ url: 'ftp://example.com/x' }),
    error => error.fetchReason === 'scheme'
  );
  await assert.rejects(
    () => runWebFetch({ url: '不是网址' }),
    error => error.fetchReason === 'invalid'
  );
  await assert.rejects(
    () => runWebFetch({ url: 'https://blocked.example.com/x', allowedDomains: 'allowed.com' }),
    error => error.fetchReason === 'blocked'
  );
});
