// 图片下载编排（依赖注入）：直链优先 / 页面兜底 / 白名单 / 私网 / 候选顺序。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_NOT_IMAGE,
  MAX_PAGE_IMAGE_ATTEMPTS,
  downloadImageOrPage,
} from '../src/chat/pageImageDownload.js';

const notImage = () => Object.assign(new Error('not image'), { code: CODE_NOT_IMAGE });
const t = (key, vars) => `${key}|${vars && vars.host}`;

test('直链：命中来源 → 一次下载，带 UA；不触发页面抓取', async () => {
  const calls = [];
  let pageCalls = 0;
  const result = await downloadImageOrPage('https://www.pixiv.net/artworks/1', {
    sources: [{ host: 'www.pixiv.net' }],
    downloadImage: async (url, headers) => { calls.push({ url, headers }); return { uri: 'ok' }; },
    fetchPage: async () => { pageCalls += 1; return { html: '' }; },
    t,
  });
  assert.equal(result.uri, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(pageCalls, 0);
  assert.match(calls[0].headers['User-Agent'], /Mozilla/);
});

test('页面兜底：直链不是图片 → 抓页面提取 og:image → 下载主图（图片 CDN 继承页面授权）', async () => {
  const calls = [];
  const result = await downloadImageOrPage('https://www.pixiv.net/artworks/1', {
    sources: [{ host: 'www.pixiv.net' }],
    downloadImage: async (url, headers) => {
      calls.push({ url, headers });
      if (url === 'https://www.pixiv.net/artworks/1') throw notImage();
      return { uri: 'main-image' };
    },
    fetchPage: async () => ({
      html: '<meta property="og:image" content="https://i.pximg.net/img/a.jpg">',
      finalUrl: 'https://www.pixiv.net/artworks/1',
    }),
    t,
  });
  assert.equal(result.uri, 'main-image');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://i.pximg.net/img/a.jpg');
  // 图片主机不在名单 → 未命中来源 → 用页面最终 URL 当 Referer（防盗链）
  assert.equal(calls[1].headers.Referer, 'https://www.pixiv.net/artworks/1');
  assert.match(calls[1].headers['User-Agent'], /Mozilla/);
});

test('命中来源的图片主机：用配置的引用页，而不是页面 URL', async () => {
  const calls = [];
  await downloadImageOrPage('https://www.pixiv.net/artworks/1', {
    sources: [
      { host: 'www.pixiv.net' },
      { host: 'i.pximg.net', referer: 'https://configured.example/' },
    ],
    downloadImage: async (url, headers) => {
      calls.push({ url, headers });
      if (url.includes('/artworks/')) throw notImage();
      return { uri: 'ok' };
    },
    fetchPage: async () => ({
      html: '<meta property="og:image" content="https://i.pximg.net/a.jpg">',
      finalUrl: 'https://www.pixiv.net/artworks/1',
    }),
    t,
  });
  assert.equal(calls[1].headers.Referer, 'https://configured.example/');
});

test('白名单：页面主机不在名单 → DOWNLOAD_IMAGE_BLOCKED（不抓页面）', async () => {
  let fetched = false;
  await assert.rejects(
    downloadImageOrPage('https://other.example.com/p/1', {
      sources: [{ host: 'www.pixiv.net' }],
      downloadImage: async () => ({ uri: 'x' }),
      fetchPage: async () => { fetched = true; return { html: '' }; },
      t,
    }),
    error => error.code === 'DOWNLOAD_IMAGE_BLOCKED' && /other\.example\.com/.test(error.message)
  );
  assert.equal(fetched, false);
});

test('私网防守：页面 URL 是内网 → 拒绝（含十进制 IPv4 写法）', async () => {
  await assert.rejects(
    downloadImageOrPage('http://192.168.1.5/p/1', {
      sources: [],
      downloadImage: async () => ({ uri: 'x' }),
      fetchPage: async () => ({ html: '' }),
      t,
    }),
    error => error.code === 'DOWNLOAD_IMAGE_BLOCKED'
  );
  await assert.rejects(
    downloadImageOrPage('http://2130706433/p/1', {
      sources: [],
      downloadImage: async () => ({ uri: 'x' }),
      fetchPage: async () => ({ html: '' }),
      t,
    }),
    error => error.code === 'DOWNLOAD_IMAGE_BLOCKED'
  );
});

test('候选图片是私网 → 跳过；公网候选继续；最多尝试 N 个候选', async () => {
  const calls = [];
  const html = `
    <meta property="og:image" content="http://10.0.0.5/secret.png">
    <meta property="og:image" content="https://cdn.x.com/a.png">
    <meta property="og:image" content="https://cdn.x.com/b.png">`;
  const result = await downloadImageOrPage('https://site.com/p', {
    sources: [],
    downloadImage: async (url, headers) => {
      calls.push({ url, headers });
      if (url === 'https://site.com/p') throw notImage();
      return { uri: 'ok' };
    },
    fetchPage: async () => ({ html, finalUrl: 'https://site.com/p' }),
    t,
  });
  assert.equal(result.uri, 'ok');
  assert.equal(calls.some(item => item.url.includes('10.0.0.5')), false, '私网候选不发起请求');
  assert.equal(calls[1].url, 'https://cdn.x.com/a.png');

  // 全部候选失败：只尝试 MAX_PAGE_IMAGE_ATTEMPTS 个，最后抛候选错误
  const failures = [];
  await assert.rejects(
    downloadImageOrPage('https://site.com/p', {
      sources: [],
      downloadImage: async url => {
        failures.push(url);
        throw notImage();
      },
      fetchPage: async () => ({ html, finalUrl: 'https://site.com/p' }),
      t,
    }),
    error => error.code === CODE_NOT_IMAGE
  );
  assert.equal(failures.length, 1 + MAX_PAGE_IMAGE_ATTEMPTS, '直链 1 次 + 候选上限');
});

test('页面抓取失败 / 未注入 fetchPage / 直链其它错误：都按原错误失败（不掩盖）', async () => {
  // fetchPage 抛错 → 抛回「不是图片」原错误
  await assert.rejects(
    downloadImageOrPage('https://site.com/p', {
      sources: [],
      downloadImage: async () => { throw notImage(); },
      fetchPage: async () => { throw new Error('network'); },
      t,
    }),
    error => error.code === CODE_NOT_IMAGE
  );
  // 未注入 fetchPage（旧宿主）：不兜底
  await assert.rejects(
    downloadImageOrPage('https://site.com/p', {
      sources: [],
      downloadImage: async () => { throw notImage(); },
      t,
    }),
    error => error.code === CODE_NOT_IMAGE
  );
  // 直链是 403 等其它错误：原样上抛，不抓页面
  let fetched = false;
  await assert.rejects(
    downloadImageOrPage('https://site.com/p', {
      sources: [],
      downloadImage: async () => {
        throw Object.assign(new Error('http'), { code: 'DOWNLOAD_IMAGE_HTTP' });
      },
      fetchPage: async () => { fetched = true; return { html: '' }; },
      t,
    }),
    error => error.code === 'DOWNLOAD_IMAGE_HTTP'
  );
  assert.equal(fetched, false);
});
