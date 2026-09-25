import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveImageFormat } from '../src/imageResultFormat.js';

test('生图结果按 mimeType 或 URL 后缀决定扩展名与 MIME', () => {
  assert.deepEqual(resolveImageFormat({ mimeType: 'image/jpeg' }), { ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(resolveImageFormat({ url: 'https://x.test/a.webp?token=1' }), { ext: 'webp', mime: 'image/webp' });
  assert.deepEqual(resolveImageFormat({ url: 'https://x.test/a.GIF' }), { ext: 'gif', mime: 'image/gif' });
  assert.deepEqual(resolveImageFormat({ url: 'https://x.test/noext' }), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(resolveImageFormat({ base64: 'AAAA' }), { ext: 'png', mime: 'image/png' });
});

test('mimeType 优先于 URL 后缀', () => {
  assert.deepEqual(
    resolveImageFormat({ mimeType: 'image/png', url: 'https://x.test/a.jpg' }),
    { ext: 'png', mime: 'image/png' }
  );
});