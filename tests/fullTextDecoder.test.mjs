import test from 'node:test';
import assert from 'node:assert/strict';

import { decodesNonUtf8, ensureFullTextDecoder } from '../src/books/fullTextDecoder.js';

// 模拟 Expo SDK 54 的全局 TextDecoder：只认 UTF-8 系标签，遇到非 UTF-8 构造即抛。
class Utf8OnlyDecoder {
  constructor(label = 'utf-8') {
    if (String(label).trim().toLowerCase() !== 'utf-8') {
      throw new RangeError(`Unknown encoding: ${label}`);
    }
    this.encoding = 'utf-8';
  }

  decode() {
    return '';
  }
}

// 模拟完整 WHATWG polyfill：能正确处理 GBK「你」(0xc4 0xe3)。
class FullTextDecoder {
  constructor(label = 'utf-8') {
    this.encoding = String(label).trim().toLowerCase();
  }

  decode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (this.encoding === 'gb18030' && bytes.length === 2 && bytes[0] === 0xc4 && bytes[1] === 0xe3) {
      return '你';
    }
    return '';
  }
}

test('decodesNonUtf8：无全局 / 非函数时返回 false', () => {
  assert.equal(decodesNonUtf8(undefined), false);
  assert.equal(decodesNonUtf8({}), false);
  assert.equal(decodesNonUtf8({ TextDecoder: 'not-a-function' }), false);
});

test('decodesNonUtf8：UTF-8-only 全局返回 false，完整实现返回 true', () => {
  assert.equal(decodesNonUtf8({ TextDecoder: Utf8OnlyDecoder }), false);
  assert.equal(decodesNonUtf8({ TextDecoder: FullTextDecoder }), true);
});

test('ensureFullTextDecoder：完整实现时不做任何替换，也不加载 polyfill', () => {
  const globalObject = { TextDecoder: FullTextDecoder };
  let loaded = 0;
  const replaced = ensureFullTextDecoder(globalObject, () => { loaded += 1; });
  assert.equal(replaced, false);
  assert.equal(loaded, 0);
  assert.equal(globalObject.TextDecoder, FullTextDecoder);
});

test('ensureFullTextDecoder：UTF-8-only 时先摘除再让 polyfill 顶上', () => {
  const globalObject = { TextDecoder: Utf8OnlyDecoder };
  let sawDeletedAtLoad = null;
  const replaced = ensureFullTextDecoder(globalObject, () => {
    sawDeletedAtLoad = globalObject.TextDecoder === undefined;
    globalObject.TextDecoder = FullTextDecoder;
  });
  assert.equal(replaced, true);
  // 关键顺序：polyfill 安装时全局必须已为空，否则 text-encoding 会继续转发残缺实现。
  assert.equal(sawDeletedAtLoad, true);
  assert.equal(globalObject.TextDecoder, FullTextDecoder);
  const text = new globalObject.TextDecoder('gb18030').decode(new Uint8Array([0xc4, 0xe3]));
  assert.equal(text, '你');
});

test('ensureFullTextDecoder：无全局时返回 false 且不加载', () => {
  let loaded = 0;
  assert.equal(ensureFullTextDecoder(undefined, () => { loaded += 1; }), false);
  assert.equal(loaded, 0);
});
