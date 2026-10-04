// 书籍文本编码探测与解码（纯函数，可 Node 直测）。
//
// 方案选型（2026-10-03 spike）：自研轻量探测 + `text-encoding`（WHATWG TextDecoder
// polyfill）解码。不用 iconv-lite（依赖 Node stream/buffer，Hermes 风险）与
// jschardet（体积 7.3M）。支持 UTF-8（含 BOM）/ UTF-16LE/BE（含 BOM 或无 BOM 启发）
// / GB18030 / BIG5。
//
// 探测策略：BOM 优先 → 严格 UTF-8 校验 → UTF-16 零字节启发 → GB18030/BIG5/UTF-16LE/BE
// 候选按「可疑码位占比（U+FFFD/U+0000/非字符）→ 汉字占比」择优。可疑占比超阈值抛
// { code:'ENCODING' }。把 UTF-16 候选并入评分是为了兜住「纯 CJK 无 BOM UTF-16」——
// 其原始字节不含零字节，零字节启发失效，只靠 GB18030 会解出静默乱码。

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

// 可疑码位占比：U+FFFD 替换符、U+0000 NUL、以及无字符（U+FFFE/U+FFFF、U+FDD0–U+FDEF）。
// 合法书籍文本几乎不含这些；用于识别「按单字节编码误读双字节文本」与全 0xFF 之类
// 任何候选都解不出正常文本的输入。纯 CJK 的 UTF-16（无 ASCII）零字节不足，looksLikeUtf16
// 启发失效，会解成带成片 NUL 的乱码——该指标正是为这个静默乱码兜底。
export function undesirableRatio(text) {
  const source = String(text || '');
  if (!source) return 0;
  let bad = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (
      code === REPLACEMENT_CODE
      || code === 0
      || code === 0xfffe
      || code === 0xffff
      || (code >= 0xfdd0 && code <= 0xfdef)
    ) bad += 1;
  }
  return bad / source.length;
}

// UTF-32 BOM（text-encoding 无 utf-32 解码器，命中后手动按 4 字节还原码位）。
export function detectUtf32Bom(input) {
  const bytes = toUint8(input);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return { encoding: 'utf-32le', offset: 4 };
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
    return { encoding: 'utf-32be', offset: 4 };
  }
  return null;
}

function decodeUtf32(bytes, littleEndian) {
  const out = [];
  for (let index = 0; index + 3 < bytes.length; index += 4) {
    const code = littleEndian
      ? (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24)) >>> 0
      : ((bytes[index] << 24) | (bytes[index + 1] << 16) | (bytes[index + 2] << 8) | bytes[index + 3]) >>> 0;
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) out.push('\uFFFD');
    else out.push(String.fromCodePoint(code));
  }
  return out.join('');
}

// 文本脚本画像：为每种候选编码打分，避免「替换符占比」单指标把日/韩/西欧编码
// 误判成 GB18030/BIG5 或 UTF-16 乱码。
export function textStats(text) {
  const source = String(text || '');
  let total = 0;
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  let ascii = 0;
  let bad = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    const point = source.codePointAt(index);
    if (point > 0xffff) index += 1;
    total += 1;
    if (code < 0x80) ascii += 1;
    if (
      code === 0xfffd
      || code === 0
      || code === 0xfffe
      || code === 0xffff
      || (code >= 0xfdd0 && code <= 0xfdef)
      || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)
    ) bad += 1;
    if ((point >= 0x4e00 && point <= 0x9fff) || (point >= 0x3400 && point <= 0x4dbf) || (point >= 0xf900 && point <= 0xfaff)) han += 1;
    else if (point >= 0x3040 && point <= 0x30ff) kana += 1;
    else if (point >= 0xac00 && point <= 0xd7af) hangul += 1;
    else if ((code >= 0xc0 && code <= 0xff) || (code >= 0x100 && code <= 0x17f)) latin += 1;
  }
  const divisor = total || 1;
  return {
    total,
    han: han / divisor,
    kana: kana / divisor,
    hangul: hangul / divisor,
    latin: latin / divisor,
    ascii: ascii / divisor,
    bad: bad / divisor,
  };
}

// 候选编码集合：中日韩双字节 + 西欧单字节 + UTF-16（无 BOM）。
const CANDIDATE_ENCODINGS = [
  'gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'windows-1252', 'utf-16le', 'utf-16be',
];

// 分数越高越可信；bad 惩罚很重（替换符/NUL/控制符是乱码强信号），
// 脚本占比是正信号（日文假名/韩文谚文加倍权重，令其能压过「GB 解读像汉字」的巧合）。
export function candidateScore(encoding, stats) {
  const badPenalty = stats.bad * 6;
  const japanese = stats.kana >= 0.3;
  if (encoding === 'gb18030' || encoding === 'big5') {
    // 出现明显假名时不再给中文加分（否则 Shift_JIS 假名会被 GB 解成汉字而胜出）。
    const bonus = japanese ? 0 : (encoding === 'big5' ? 0.19 : 0.2);
    return stats.han + bonus - badPenalty;
  }
  if (encoding === 'shift_jis' || encoding === 'euc-jp') {
    // 真日文必含汉字（假名+汉字混排）。纯假名的短样本多为别的编码被误读成假名，
    // 不给满权重，避免 4 字节级样本把 BIG5/GBK 抢走。
    return (stats.han >= 0.05 ? 2.5 * stats.kana + 0.5 * stats.han : 0.5 * stats.kana) - badPenalty;
  }
  // 韩文：要求谚文压过汉字（GBK 被 euc-kr 误读时通常是「谚文与汉字各半」，不满足）。
  if (encoding === 'euc-kr') return 1.5 * stats.hangul - stats.han - badPenalty;
  if (encoding === 'windows-1252') {
    return (stats.ascii >= 0.6 ? stats.latin + 0.5 * stats.ascii : -1) - badPenalty;
  }
  // UTF-16（无 BOM）：只认「干净的 CJK」；被误读的输入会落成成片谚文/假名而被扣分。
  // 若原始字节以可打印 ASCII 为主（如西欧单字节文本），UTF-16CJK 只是巧合，重罚。
  const latinBytes = stats.byteAscii >= 0.7 ? 0.8 : 0;
  return stats.han - stats.hangul - stats.kana - latinBytes - badPenalty;
}

// 低于此分视为「没有可信编码」→ 抛 ENCODING；用于挡住全 0xFF / UTF-32 等二进制式输入。
const CANDIDATE_ACCEPT_FLOOR = 0.3;

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

  const utf32 = detectUtf32Bom(bytes);
  if (utf32) {
    const text = normalizeNewlines(decodeUtf32(bytes.subarray(utf32.offset), utf32.encoding === 'utf-32le'));
    return { text, encoding: utf32.encoding, replacementRatio: replacementRatio(text) };
  }

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

  // 无 BOM 且非 UTF-8：逐个候选解码打分择优。可容忍少量坏字节（真实小说常有零星损坏
  // 字节），只有连最高分都低于下限（全 0xFF/UTF-32 等）才判为无法识别。
  let printableAscii = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] >= 0x20 && bytes[index] < 0x80) printableAscii += 1;
  }
  const byteAscii = bytes.length ? printableAscii / bytes.length : 0;

  let best = null;
  for (const encoding of CANDIDATE_ENCODINGS) {
    let text = '';
    try {
      text = normalizeNewlines(decodeWith(encoding, bytes));
    } catch (error) {
      continue;
    }
    const stats = { ...textStats(text), byteAscii };
    const score = candidateScore(encoding, stats);
    if (!best || score > best.score) best = { encoding, text, score };
  }

  if (best && best.score >= CANDIDATE_ACCEPT_FLOOR) {
    return { text: best.text, encoding: best.encoding, replacementRatio: replacementRatio(best.text) };
  }

  const error = new Error('无法识别文件编码');
  error.code = 'ENCODING';
  throw error;
}
