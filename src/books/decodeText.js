// 书籍文本编码探测与解码（纯函数，可 Node 直测）。
//
// 方案选型（2026-10-03 spike）：自研轻量探测 + `text-encoding`（WHATWG TextDecoder
// polyfill）解码。不用 iconv-lite（依赖 Node stream/buffer，Hermes 风险）与
// jschardet（体积 7.3M）。支持 UTF-8（含 BOM）/ UTF-16LE/BE（含 BOM 或无 BOM 启发）
// / GB18030 / BIG5。
//
// 探测策略：BOM 优先 → 严格 UTF-8 校验 → UTF-16 零字节启发 → GB18030/BIG5 候选按
// U+FFFD 替换符占比择优。全部候选超阈值则抛 { code:'ENCODING' }。

// text-encoding 是 CommonJS/UMD：Node ESM 下不能具名导入，用默认导入解构
// （Metro/Babel 的 interop 同样适用）。
import textEncoding from 'text-encoding';

const { TextDecoder } = textEncoding;

export const ENCODING_FFFD_THRESHOLD = 0.005;
const REPLACEMENT_CODE = 0xfffd;

function toUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input && input.buffer) return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength || input.buffer.byteLength);
  return new Uint8Array(input || []);
}

export function detectBom(input) {
  const bytes = toUint8(input);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', offset: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', offset: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', offset: 2 };
  }
  return null;
}

// 严格 UTF-8 校验：拒绝过长编码、代理区、越界。空字节视为合法（空串）。
export function isStrictUtf8(input) {
  const bytes = toUint8(input);
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte <= 0x7f) {
      index += 1;
      continue;
    }
    let extra = 0;
    let codePoint = 0;
    if (byte >= 0xc2 && byte <= 0xdf) {
      extra = 1;
      codePoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      extra = 2;
      codePoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      extra = 3;
      codePoint = byte & 0x07;
    } else {
      return false;
    }
    if (index + extra >= bytes.length) return false;
    for (let step = 1; step <= extra; step += 1) {
      const continuation = bytes[index + step];
      if ((continuation & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (extra === 1 && codePoint < 0x80) return false;
    if (extra === 2 && codePoint < 0x800) return false;
    if (extra === 3 && codePoint < 0x10000) return false;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    if (codePoint > 0x10ffff) return false;
    index += extra + 1;
  }
  return true;
}

// 无 BOM UTF-16 启发：ASCII 文本按 UTF-16 编码时每隔一字节为 0x00。
export function looksLikeUtf16(input) {
  const bytes = toUint8(input);
  if (bytes.length < 4) return null;
  const sample = Math.min(bytes.length, 4096);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < sample; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const oddRatio = oddZeros / sample;
  const evenRatio = evenZeros / sample;
  if (oddRatio > 0.3 && evenRatio < 0.05) return 'utf-16le';
  if (evenRatio > 0.3 && oddRatio < 0.05) return 'utf-16be';
  return null;
}

export function replacementRatio(text) {
  const source = String(text || '');
  if (!source) return 0;
  let bad = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === REPLACEMENT_CODE) bad += 1;
  }
  return bad / source.length;
}

// 汉字（CJK 基本区 + 扩展 A）占比：GB18030 与 BIG5 都无替换符时用它区分——
// BIG5 文本按 GB18030 解码常落到假名/符号区，汉字占比明显偏低。
export function cjkRatio(text) {
  const source = String(text || '');
  if (!source) return 0;
  let total = 0;
  let cjk = 0;
  for (const char of source) {
    total += 1;
    const code = char.codePointAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk += 1;
  }
  return total ? cjk / total : 0;
}

function isBetter(candidate, current) {
  if (!current) return true;
  if (candidate.replacementRatio !== current.replacementRatio) {
    return candidate.replacementRatio < current.replacementRatio;
  }
  return candidate.cjkRatio > current.cjkRatio;
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n?/g, '\n');
}

function decodeWith(encoding, bytes) {
  // text-encoding 的 TextDecoder 对非法字节以 U+FFFD 替换（非 fatal），便于统计占比。
  const decoder = new TextDecoder(encoding);
  return decoder.decode(toUint8(bytes));
}

// 返回 { text, encoding, replacementRatio }；无法识别时抛 { code:'ENCODING' }。
export function decodeBytes(input) {
  const bytes = toUint8(input);
  if (bytes.length === 0) return { text: '', encoding: 'utf-8', replacementRatio: 0 };

  const bom = detectBom(bytes);
  if (bom) {
    const text = normalizeNewlines(decodeWith(bom.encoding, bytes.subarray(bom.offset)));
    return { text, encoding: bom.encoding, replacementRatio: replacementRatio(text) };
  }

  if (isStrictUtf8(bytes)) {
    const text = normalizeNewlines(decodeWith('utf-8', bytes));
    return { text, encoding: 'utf-8', replacementRatio: replacementRatio(text) };
  }

  const utf16 = looksLikeUtf16(bytes);
  if (utf16) {
    const text = normalizeNewlines(decodeWith(utf16, bytes));
    const ratio = replacementRatio(text);
    if (ratio <= ENCODING_FFFD_THRESHOLD) return { text, encoding: utf16, replacementRatio: ratio };
  }

  let best = null;
  for (const encoding of ['gb18030', 'big5']) {
    let text = '';
    try {
      text = normalizeNewlines(decodeWith(encoding, bytes));
    } catch (error) {
      continue;
    }
    const candidate = {
      text,
      encoding,
      replacementRatio: replacementRatio(text),
      cjkRatio: cjkRatio(text),
    };
    if (isBetter(candidate, best)) best = candidate;
  }

  if (best && best.replacementRatio <= ENCODING_FFFD_THRESHOLD) {
    return { text: best.text, encoding: best.encoding, replacementRatio: best.replacementRatio };
  }

  const error = new Error('无法识别文件编码');
  error.code = 'ENCODING';
  throw error;
}
