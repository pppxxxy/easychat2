// 书籍文本编码探测与解码（纯函数，可 Node 直测）。
//
// 方案选型（2026-10-03 spike）：自研轻量探测 + `text-encoding`（WHATWG TextDecoder
// polyfill）解码。不用 iconv-lite（依赖 Node stream/buffer，Hermes 风险）与
// jschardet（体积 7.3M）。支持 UTF-8（含 BOM）/ UTF-16LE/BE（含 BOM 或无 BOM 启发）
// / UTF-32（BOM）/ GB18030 / BIG5 / Shift_JIS / EUC-JP / EUC-KR / ISO-2022-JP /
// windows-1252 / HZ-GB-2312（自实现解码，WHATWG 已弃用该编码）。
//
// 探测策略：UTF-32 BOM → BOM（解出成片替换符视为「BOM 与正文不符」，落回候选评分）
// → 二进制魔数（NOT_TEXT）→ 7 位转义式（HZ-GB-2312 / ISO-2022-JP：整份文件都是合法
// ASCII，严格 UTF-8 一定会抢先认领，必须排在它前面）→ 严格 UTF-8 校验 → UTF-16 零字节
// 启发 → NUL 占比复核（NOT_TEXT）→ 其余候选按「可疑码位占比 → 脚本占比」打分择优，
// 最高分低于下限抛 { code:'ENCODING' }。把 UTF-16 候选并入评分是为了兜住「纯 CJK 无
// BOM UTF-16」——其原始字节不含零字节，零字节启发失效，只靠 GB18030 会解出静默乱码。
// 二进制识别单列，是因为改后缀的 PDF/Word/电子书容器是「编码不支持」报错的高发来源，
// 笼统让用户转码会误导。

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

// ---- HZ-GB-2312（~{...~} 转义的 GB2312）----
//
// 早年中文新闻组/BBS 的编码：汉字以 ~{ 开头、~} 结尾，中间是「去掉高位位」的 GB2312
// 双字节（0x21–0x7E）。整份文件没有一个高位字节，对任何候选解码器都是合法 ASCII，
// 会被静默解成乱码（windows-1252 还能拿高分），所以必须在候选评分前用签名截住。
// WHATWG 已把它归入 replacement（解不出东西），text-encoding/Node 都没有解码器，
// 只能自实现。解码从严：0x80+ 字节、非法转义、奇数 GB 字节都判为「不是 HZ」，
// 宁可放回候选评分，也不误吞一份普通文本。
export function looksLikeHz(input) {
  const bytes = toUint8(input);
  const sample = Math.min(bytes.length, 65536);
  let open = 0;
  let close = 0;
  for (let index = 0; index + 1 < sample; index += 1) {
    if (bytes[index] !== 0x7e) continue;
    if (bytes[index + 1] === 0x7b) open += 1;
    if (bytes[index + 1] === 0x7d) close += 1;
  }
  return open >= 1 && close >= 1;
}

export function decodeHz(input) {
  const bytes = toUint8(input);
  let text = '';
  let gbBytes = [];
  let inGb = false;
  const flushGb = () => {
    if (!inGb) return;
    inGb = false;
    if (gbBytes.length % 2 !== 0) throw new Error('bad-hz');
    if (gbBytes.length > 0) {
      // HZ 的 GB 段存的是「高位被剥掉」的 GB2312：补回 0x80 再按 GB18030（超集）解码。
      const eightBit = new Uint8Array(gbBytes.length);
      for (let index = 0; index < gbBytes.length; index += 1) {
        const byte = gbBytes[index];
        if (byte < 0x21 || byte > 0x7e) throw new Error('bad-hz');
        eightBit[index] = byte | 0x80;
      }
      text += decodeWith('gb18030', eightBit);
    }
    gbBytes = [];
  };
  try {
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === 0x7e) {
        const next = bytes[index + 1];
        if (next === 0x7b) { flushGb(); inGb = true; index += 1; continue; }
        if (next === 0x7d) { flushGb(); index += 1; continue; }
        if (next === 0x7e) { if (inGb) gbBytes.push(0x7e); else text += '~'; index += 1; continue; }
        throw new Error('bad-hz');
      }
      if (byte >= 0x80) throw new Error('bad-hz');
      if (inGb) gbBytes.push(byte);
      else text += String.fromCharCode(byte);
    }
    flushGb();
  } catch (error) {
    return null;
  }
  return text;
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

// ---- 二进制识别 ----
//
// 改了 .txt 后缀的 PDF/Word/电子书容器是「编码不支持」报错的高发来源：任何解码器
// 都解不出像样文本，用户照提示转码也没用。魔数部分（PK/%PDF/mobi 等）要排在严格
// UTF-8 校验之前——zip 头四个字节全落在 ASCII 区，纯字节校验拦不住它；NUL 占比
// 复核则必须排在 UTF-16 启发之后（UTF-16 文本的 NUL 只来自 ASCII 字符）。
const BINARY_MAGICS = [
  ['zip/docx/epub', [0x50, 0x4b, 0x03, 0x04]],
  ['zip-empty', [0x50, 0x4b, 0x05, 0x06]],
  ['zip-spanned', [0x50, 0x4b, 0x07, 0x08]],
  ['pdf', [0x25, 0x50, 0x44, 0x46]],
  ['mobi', [0x42, 0x4f, 0x4f, 0x4b, 0x4d, 0x4f, 0x42, 0x49]],
  ['gzip', [0x1f, 0x8b]],
  ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['sqlite', [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]],
];
// 高 NUL 但无魔数的兜底（删库碎片、内存转储之类）；UTF-16 文本走到这里时
// 零字节启发早已接走，不会误伤。
export const BINARY_NUL_RATIO = 0.35;

export function sniffBinaryMagic(input) {
  const bytes = toUint8(input);
  for (const [, signature] of BINARY_MAGICS) {
    if (signature.every((byte, index) => bytes[index] === byte)) return true;
  }
  return false;
}

export function sniffBinary(input) {
  const bytes = toUint8(input);
  if (sniffBinaryMagic(bytes)) return true;
  const sample = Math.min(bytes.length, 65536);
  let zeros = 0;
  for (let index = 0; index < sample; index += 1) {
    if (bytes[index] === 0) zeros += 1;
  }
  return zeros / sample > BINARY_NUL_RATIO;
}

// ---- ISO-2022-JP（ESC 序列切换的 7 位日文）----
//
// 与 HZ 同理：整份文件是合法 ASCII，严格 UTF-8 会抢先认领，只能签名检测 +
// 交给 text-encoding 解码。签名认 ESC $ @/B（进 JIS 汉字区）与 ESC ( B/J/I（回 ASCII/半角假名）。
export function looksLikeIso2022Jp(input) {
  const bytes = toUint8(input);
  const sample = Math.min(bytes.length, 65536);
  for (let index = 0; index + 2 < sample; index += 1) {
    if (bytes[index] !== 0x1b) continue;
    if (bytes[index + 1] === 0x24 && (bytes[index + 2] === 0x40 || bytes[index + 2] === 0x42)) return true;
    if (bytes[index + 1] === 0x28 && (bytes[index + 2] === 0x49 || bytes[index + 2] === 0x4a || bytes[index + 2] === 0x42)) return true;
  }
  return false;
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
// 注：未收 windows-1251/koi8-r——它们与 euc-kr 共享同一字节空间，纯脚本占比无法
// 区分「俄文」与「韩文的互读乱码」（两者都能解出干净的单脚本文本），需要字符频率表
// （jschardet 级方案）才可靠；贸然加入会破坏现有韩文识别。
const CANDIDATE_ENCODINGS = [
  'gb18030', 'big5', 'shift_jis', 'euc-jp', 'iso-2022-jp', 'euc-kr', 'windows-1252', 'utf-16le', 'utf-16be',
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
  if (encoding === 'shift_jis' || encoding === 'euc-jp' || encoding === 'iso-2022-jp') {
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

// 返回 { text, encoding, replacementRatio }；无法识别时抛 { code:'ENCODING' }，
// 文件是二进制（改后缀的 PDF/Word/容器等）时抛 { code:'NOT_TEXT' }。
export function decodeBytes(input) {
  const bytes = toUint8(input);
  if (bytes.length === 0) return { text: '', encoding: 'utf-8', replacementRatio: 0 };

  const utf32 = detectUtf32Bom(bytes);
  if (utf32) {
    const text = normalizeNewlines(decodeUtf32(bytes.subarray(utf32.offset), utf32.encoding === 'utf-32le'));
    return { text, encoding: utf32.encoding, replacementRatio: replacementRatio(text) };
  }

  const bom = detectBom(bytes);
  // bomOffset 非 0 时（BOM 与正文不符），后续候选评分改用去掉 BOM 的正文：
  // 「UTF-8 BOM + GBK 正文」的下载站产物按 BOM 解是成片替换符，按正文解才是真文本。
  let bomOffset = 0;
  if (bom) {
    const text = normalizeNewlines(decodeWith(bom.encoding, bytes.subarray(bom.offset)));
    const ratio = replacementRatio(text);
    if (ratio <= ENCODING_FFFD_THRESHOLD) {
      return { text, encoding: bom.encoding, replacementRatio: ratio };
    }
    bomOffset = bom.offset;
  }

  // 二进制魔数：zip 头全在 ASCII 区，必须赶在严格 UTF-8 校验之前拦下。
  if (sniffBinaryMagic(bytes)) {
    const error = new Error('文件是二进制格式，不是纯文本');
    error.code = 'NOT_TEXT';
    throw error;
  }

  // 7 位转义式编码（HZ-GB-2312 / ISO-2022-JP）：整份文件都是合法 ASCII，严格 UTF-8
  // 一定会抢先认领，必须在它之前用签名截住；解码从严，不合语法就当没有这回事。
  if (looksLikeHz(bytes)) {
    const hzText = decodeHz(bytes);
    if (hzText !== null && undesirableRatio(hzText) <= ENCODING_FFFD_THRESHOLD) {
      const text = normalizeNewlines(hzText);
      return { text, encoding: 'hz-gb-2312', replacementRatio: replacementRatio(text) };
    }
  }
  if (looksLikeIso2022Jp(bytes)) {
    let isoText = null;
    try {
      isoText = decodeWith('iso-2022-jp', bytes);
    } catch (error) {
      isoText = null;
    }
    if (isoText !== null) {
      const isoStats = textStats(isoText);
      // 无 CJK 的「签名命中」不是日文（纯 ASCII 文档碰巧带 ESC 序列），放回常规流程。
      if (isoStats.bad <= ENCODING_FFFD_THRESHOLD && (isoStats.kana >= 0.05 || isoStats.han >= 0.3)) {
        const text = normalizeNewlines(isoText);
        return { text, encoding: 'iso-2022-jp', replacementRatio: replacementRatio(text) };
      }
    }
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

  // NUL 占比复核：走到这里（非 BOM、非 UTF-8、无 UTF-16 启发）还满是 NUL 的，
  // 是删库碎片/内存转储一类的二进制，抛 NOT_TEXT 而不是笼统的编码错误。
  if (sniffBinary(bytes)) {
    const error = new Error('文件是二进制格式，不是纯文本');
    error.code = 'NOT_TEXT';
    throw error;
  }

  // 无 BOM 且非 UTF-8：逐个候选解码打分择优。可容忍少量坏字节（真实小说常有零星损坏
  // 字节），只有连最高分都低于下限（全 0xFF/UTF-32 等）才判为无法识别。
  const body = bomOffset ? bytes.subarray(bomOffset) : bytes;
  let printableAscii = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] >= 0x20 && body[index] < 0x80) printableAscii += 1;
  }
  const byteAscii = body.length ? printableAscii / body.length : 0;

  let best = null;
  for (const encoding of CANDIDATE_ENCODINGS) {
    let text = '';
    try {
      text = normalizeNewlines(decodeWith(encoding, body));
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
