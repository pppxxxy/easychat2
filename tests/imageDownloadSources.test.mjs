// 图片下载来源（纯函数）测试：归一 / 白名单匹配 / 请求头 / 私网拒绝。
//
// 背景（2026-10-21）：设置页新增「图片来源」名单；空名单 = 不限制（旧行为），
// 非空 = 只允许名单内站点（含子域），并可带 Referer 解决防盗链 403。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IMAGE_DOWNLOAD_UA,
  MAX_IMAGE_DOWNLOAD_SOURCES,
  buildImageDownloadHeaders,
  hostFromImageUrl,
  hostMatchesPattern,
  isImageDownloadHostAllowed,
  isPrivateDownloadHost,
  matchImageSource,
  normalizeDownloadHost,
  normalizeDownloadReferer,
  normalizeImageSource,
  normalizeImageSources,
} from '../src/chat/imageDownloadSources.js';

test('normalizeDownloadHost：粘链接也能归一成主机名', () => {
  assert.equal(normalizeDownloadHost('i.pximg.net'), 'i.pximg.net');
  assert.equal(normalizeDownloadHost('  HTTPS://WWW.Pixiv.NET/artworks/1?x=2#a '), 'www.pixiv.net');
  assert.equal(normalizeDownloadHost('https://user:pass@example.com:8080/a/b'), 'example.com');
  assert.equal(normalizeDownloadHost('example.com:8443'), 'example.com');
  // 拒绝：通配符 / 空格 / 纯 IP / 无点主机 / IPv6 / 非法字符 / 空
  assert.equal(normalizeDownloadHost('*.example.com'), '');
  assert.equal(normalizeDownloadHost('example .com'), '');
  assert.equal(normalizeDownloadHost('192.168.1.10'), '');
  assert.equal(normalizeDownloadHost('8.8.8.8'), '');
  assert.equal(normalizeDownloadHost('localhost'), '');
  assert.equal(normalizeDownloadHost('[::1]'), '');
  assert.equal(normalizeDownloadHost('exa_mple.com'), '');
  assert.equal(normalizeDownloadHost(''), '');
  assert.equal(normalizeDownloadHost(null), '');
});

test('normalizeDownloadReferer / normalizeImageSource：引用页只收 http(s)', () => {
  assert.equal(normalizeDownloadReferer('https://www.pixiv.net/'), 'https://www.pixiv.net/');
  assert.equal(normalizeDownloadReferer('http://example.com/a'), 'http://example.com/a');
  assert.equal(normalizeDownloadReferer('ftp://example.com'), '');
  assert.equal(normalizeDownloadReferer(' javascript:alert(1)'), '');
  assert.equal(normalizeDownloadReferer(''), '');

  assert.deepEqual(normalizeImageSource({ host: 'i.pximg.net', referer: 'https://www.pixiv.net/' }), {
    host: 'i.pximg.net',
    referer: 'https://www.pixiv.net/',
  });
  assert.deepEqual(normalizeImageSource('example.com'), { host: 'example.com' }, '纯字符串也接受');
  assert.deepEqual(normalizeImageSource({ host: 'example.com', referer: 'ftp://x' }), { host: 'example.com' });
  assert.equal(normalizeImageSource({ host: '*.example.com' }), null);
  assert.equal(normalizeImageSource(null), null);
});

test('normalizeImageSources：去重（按主机）+ 上限截断', () => {
  const list = normalizeImageSources([
    { host: 'a.com' },
    { host: 'A.com', referer: 'https://a.com/' },
    { host: 'b.com' },
    { host: 'bad host' },
  ]);
  assert.deepEqual(list.map(item => item.host), ['a.com', 'b.com'], '同主机去重，首个为准');
  const many = Array.from({ length: MAX_IMAGE_DOWNLOAD_SOURCES + 5 }, (_, i) => ({ host: `h${i}.com` }));
  assert.equal(normalizeImageSources(many).length, MAX_IMAGE_DOWNLOAD_SOURCES);
});

test('hostMatchesPattern：精确 / 子域后缀；不做「部分后缀」误匹配', () => {
  assert.equal(hostMatchesPattern('example.com', 'example.com'), true);
  assert.equal(hostMatchesPattern('i.pximg.net', 'pximg.net'), true);
  assert.equal(hostMatchesPattern('a.b.pximg.net', 'pximg.net'), true);
  assert.equal(hostMatchesPattern('notexample.com', 'example.com'), false);
  assert.equal(hostMatchesPattern('example.com.evil.com', 'example.com'), false);
  assert.equal(hostMatchesPattern('', 'example.com'), false);
});

test('isImageDownloadHostAllowed：空名单=不限制但拒绝私网；非空=只放行名单', () => {
  // 空名单：公网放行（旧行为）
  assert.equal(isImageDownloadHostAllowed('i.pximg.net', []), true);
  assert.equal(isImageDownloadHostAllowed('example.com', null), true);
  // 空名单：本机/内网拒绝（隐式放行不该包含局域网）
  assert.equal(isImageDownloadHostAllowed('localhost', []), false);
  assert.equal(isImageDownloadHostAllowed('127.0.0.1', []), false);
  assert.equal(isImageDownloadHostAllowed('192.168.1.5', []), false);
  assert.equal(isImageDownloadHostAllowed('10.0.0.2', []), false);
  assert.equal(isImageDownloadHostAllowed('172.20.1.1', []), false);
  assert.equal(isImageDownloadHostAllowed('printer.local', []), false);
  // 非空名单：只放行命中项（含子域）
  const sources = [{ host: 'pximg.net' }];
  assert.equal(isImageDownloadHostAllowed('i.pximg.net', sources), true);
  assert.equal(isImageDownloadHostAllowed('pximg.net', sources), true);
  assert.equal(isImageDownloadHostAllowed('example.com', sources), false);
  assert.equal(isImageDownloadHostAllowed('', sources), false);
});

test('matchImageSource / buildImageDownloadHeaders：最长后缀优先 + Referer 只对命中来源生效', () => {
  const sources = normalizeImageSources([
    { host: 'example.com' },
    { host: 'img.example.com', referer: 'https://example.com/gallery/' },
  ]);
  assert.equal(matchImageSource('a.img.example.com', sources).host, 'img.example.com', '取最具体的一条');
  assert.equal(matchImageSource('other.example.com', sources).host, 'example.com');
  assert.equal(matchImageSource('nomatch.net', sources), null);

  const headers = buildImageDownloadHeaders('a.img.example.com', sources);
  assert.equal(headers['User-Agent'], DEFAULT_IMAGE_DOWNLOAD_UA);
  assert.equal(headers.Referer, 'https://example.com/gallery/');

  // 命中没有 Referer 的来源：只带 UA
  const plain = buildImageDownloadHeaders('other.example.com', sources);
  assert.equal(plain.Referer, undefined);
  assert.equal(plain['User-Agent'], DEFAULT_IMAGE_DOWNLOAD_UA);
});

test('isPrivateDownloadHost / hostFromImageUrl：边界值', () => {
  assert.equal(isPrivateDownloadHost('169.254.1.1'), true);
  assert.equal(isPrivateDownloadHost('172.15.0.1'), false, '172.15 不是私网段');
  assert.equal(isPrivateDownloadHost('172.32.0.1'), false, '172.32 不是私网段');
  assert.equal(isPrivateDownloadHost('example.com'), false);

  assert.equal(hostFromImageUrl('https://i.pximg.net/img/1.jpg?x=1'), 'i.pximg.net');
  assert.equal(hostFromImageUrl('http://user@Example.com:8080/a.png'), 'example.com');
  assert.equal(hostFromImageUrl('ftp://example.com/a.png'), '');
  assert.equal(hostFromImageUrl('not a url'), '');
  assert.equal(hostFromImageUrl(null), '');
});
