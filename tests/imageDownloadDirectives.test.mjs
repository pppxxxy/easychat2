import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DOWNLOAD_IMAGES,
  extractDownloadImageDirectives,
  isHttpImageUrl,
} from '../src/chat/imageDownloadDirectives.js';

test('无指令：正文原样返回，urls 为空', () => {
  const text = '看这张图\n\n已经发给你了。';
  const result = extractDownloadImageDirectives(text);
  assert.equal(result.text, text);
  assert.deepEqual(result.urls, []);
});

test('单条指令：剥离标记并收集 URL', () => {
  const result = extractDownloadImageDirectives('给你看看 <download_image:https://a.com/x.png> 好看吗');
  assert.equal(result.text, '给你看看  好看吗');
  assert.deepEqual(result.urls, ['https://a.com/x.png']);
});

test('多条指令：全部收集并剥离；去重', () => {
  const result = extractDownloadImageDirectives(
    '<download_image:https://a.com/1.png>\n<download_image:https://a.com/2.jpg>\n<download_image:https://a.com/1.png>'
  );
  assert.deepEqual(result.urls, ['https://a.com/1.png', 'https://a.com/2.jpg']);
  assert.equal(result.text.trim(), '');
});

test('超过上限：只下载前 N 个，但所有合法标记都被剥离', () => {
  const text = [
    '<download_image:https://a.com/1.png>',
    '<download_image:https://a.com/2.png>',
    '<download_image:https://a.com/3.png>',
    '<download_image:https://a.com/4.png>',
  ].join('\n');
  const result = extractDownloadImageDirectives(text);
  assert.equal(result.urls.length, MAX_DOWNLOAD_IMAGES);
  assert.equal(result.text.trim(), '');
});

test('非 http(s)：不剥离、不收集（原样保留）', () => {
  const text = '<download_image:ftp://a.com/x.png> 与 <download_image:javascript:alert(1)>';
  const result = extractDownloadImageDirectives(text);
  assert.equal(result.text, text);
  assert.deepEqual(result.urls, []);
  assert.equal(isHttpImageUrl('ftp://a.com'), false);
  assert.equal(isHttpImageUrl('HTTPS://a.com'), true);
});

test('非字符串入参安全兜底', () => {
  assert.deepEqual(extractDownloadImageDirectives(null), { text: '', urls: [] });
  assert.deepEqual(extractDownloadImageDirectives(undefined), { text: '', urls: [] });
});
