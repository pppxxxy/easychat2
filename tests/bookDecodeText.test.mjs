import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeBytes,
  detectBom,
  isStrictUtf8,
  looksLikeUtf16,
  replacementRatio,
} from '../src/books/decodeText.js';

test('BOM 识别（UTF-8 / UTF-16LE / UTF-16BE）', () => {
  assert.deepEqual(detectBom(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), { encoding: 'utf-8', offset: 3 });
  assert.deepEqual(detectBom(Buffer.from([0xff, 0xfe, 0x41, 0x00])), { encoding: 'utf-16le', offset: 2 });
  assert.deepEqual(detectBom(Buffer.from([0xfe, 0xff, 0x00, 0x41])), { encoding: 'utf-16be', offset: 2 });
  assert.equal(detectBom(Buffer.from([0x41, 0x42])), null);
});

test('UTF-8：BOM 与无 BOM 均正确解码，换行归一', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\rc', 'utf8')]);
  const r1 = decodeBytes(withBom);
  assert.equal(r1.text, 'a\nb\nc');
  assert.equal(r1.encoding, 'utf-8');

  const plain = decodeBytes(Buffer.from('你好，世界', 'utf8'));
  assert.equal(plain.text, '你好，世界');
  assert.equal(plain.encoding, 'utf-8');
});

test('UTF-16LE/BE（含 BOM）解码正确', () => {
  const text = '中文测试';
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.from(le);
  for (let i = 0; i + 1 < be.length; i += 2) {
    const t = be[i];
    be[i] = be[i + 1];
    be[i + 1] = t;
  }
  assert.equal(decodeBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), le])).text, text);
  assert.equal(decodeBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text, text);
});

test('GBK/GB18030 与 BIG5 自动识别（无 BOM）', () => {
  const gbk = decodeBytes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb5, 0xc4, 0xc8, 0xcb]));
  assert.equal(gbk.text, '中文的人');
  assert.equal(gbk.encoding, 'gb18030');

  const big5 = decodeBytes(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]));
  assert.equal(big5.text, '中文');
  assert.equal(big5.encoding, 'big5');
});

test('无法识别编码时抛 ENCODING', () => {
  assert.throws(() => decodeBytes(Buffer.alloc(16, 0xff)), (error) => error && error.code === 'ENCODING');
});

test('UTF-8 严格校验与 UTF-16 启发', () => {
  assert.equal(isStrictUtf8(Buffer.from('中文', 'utf8')), true);
  assert.equal(isStrictUtf8(Buffer.from([0xd6, 0xd0])), false, 'GBK 首字节非合法 UTF-8 起始');
  assert.equal(isStrictUtf8(Buffer.from([0xe0, 0x80, 0x80])), false, '过长编码');
  assert.equal(looksLikeUtf16(Buffer.from('abcdef', 'utf16le')), 'utf-16le');
  const be = Buffer.from('abcdef', 'utf16le');
  for (let i = 0; i + 1 < be.length; i += 2) {
    const swap = be[i];
    be[i] = be[i + 1];
    be[i + 1] = swap;
  }
  assert.equal(looksLikeUtf16(be), 'utf-16be');
  assert.equal(looksLikeUtf16(Buffer.from('abcdef', 'utf8')), null);
  assert.equal(replacementRatio('中文\uFFFD'), 1 / 3);
});
