import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeBytes,
  decodeHz,
  detectBom,
  isStrictUtf8,
  looksLikeHz,
  looksLikeIso2022Jp,
  looksLikeUtf16,
  replacementRatio,
  sniffBinary,
  sniffBinaryMagic,
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

test('纯 CJK 无 BOM UTF-16（零字节启发失效）不落成 GB18030 乱码', () => {
  // 纯中文的 UTF-16 原始字节不含 ASCII 零字节，looksLikeUtf16 判定为 null；
  // 修复前会被 GB18030 胜出解出成片 NUL 乱码且不报错。
  const text = '中文测试内容一段';
  const le = Buffer.from(text, 'utf16le');
  assert.equal(looksLikeUtf16(le), null, '前提：该输入确实绕过零字节启发');
  const rLe = decodeBytes(le);
  assert.equal(rLe.encoding, 'utf-16le');
  assert.equal(rLe.text, text);
  assert.equal(/[\u0000\uFFFD]/.test(rLe.text), false, '不得含 NUL/替换符');

  const be = Buffer.from(le);
  for (let i = 0; i + 1 < be.length; i += 2) {
    const swap = be[i];
    be[i] = be[i + 1];
    be[i + 1] = swap;
  }
  const rBe = decodeBytes(be);
  assert.equal(rBe.encoding, 'utf-16be');
  assert.equal(rBe.text, text);
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

test('UTF-32 BOM（LE/BE）解码正确', () => {
  const le = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x2d, 0x4e, 0x00, 0x00, 0x87, 0x65, 0x00, 0x00]);
  const rLe = decodeBytes(le);
  assert.equal(rLe.encoding, 'utf-32le');
  assert.equal(rLe.text, '中文');
  const be = Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x4e, 0x2d, 0x00, 0x00, 0x65, 0x87]);
  const rBe = decodeBytes(be);
  assert.equal(rBe.encoding, 'utf-32be');
  assert.equal(rBe.text, '中文');
});

test('Shift_JIS / EUC-KR / Windows-1252 常见编码识别', () => {
  // Shift_JIS「漢字あい」（含假名）：GB18030 解读会是汉字假名混淆，应判为 shift_jis。
  const sjis = decodeBytes(Buffer.from([0x8a, 0xbf, 0x8e, 0x9a, 0x82, 0xa0, 0x82, 0xa2]));
  assert.equal(sjis.encoding, 'shift_jis');
  assert.equal(sjis.text, '漢字あい');

  // EUC-KR「한국어」：GB18030 会解成汉字，应判为 euc-kr。
  const kr = decodeBytes(Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee]));
  assert.equal(kr.encoding, 'euc-kr');
  assert.equal(kr.text, '한국어');

  // Windows-1252「café」：此前会被误判为 UTF-16LE 乱码。
  const latin = decodeBytes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65]));
  assert.equal(latin.encoding, 'windows-1252');
  assert.equal(latin.text, 'café naïve');
});

test('GBK 夹杂少量损坏字节仍能识别（容忍零星坏字节）', () => {
  // 真实小说常有零星 0xFF 等损坏字节：不应整本判为「无法识别」。
  const good = [0xd6, 0xd0, 0xce, 0xc4, 0xb5, 0xc4, 0xc8, 0xcb];
  const bytes = [];
  for (let i = 0; i < 1000; i += 1) bytes.push(...good);
  bytes.splice(100, 0, 0xff, 0xff);
  bytes.splice(4000, 0, 0xff);
  const r = decodeBytes(Buffer.from(bytes));
  assert.equal(r.encoding, 'gb18030');
  assert.ok(r.text.includes('中文的人'));
});

test('HZ-GB-2312（~{...~} 转义）识别与解码', () => {
  // 「中文」的 GB2312 双字节是 D6D0 CEC4；HZ 段存剥掉高位后的 56 50 4E 44。
  assert.deepEqual(
    [...Buffer.from([0xd6, 0xd0, 0xce, 0xc4])].map(byte => (byte & 0x7f).toString(16)),
    ['56', '50', '4e', '44'],
    '前提：HZ 段字节 = GB2312 剥高位'
  );
  assert.equal(looksLikeHz(Buffer.from('pre ~{VPND~} post', 'ascii')), true);
  assert.equal(looksLikeHz(Buffer.from('no tilde here', 'ascii')), false);
  const r = decodeBytes(Buffer.from('pre ~{VPND~} post', 'ascii'));
  assert.equal(r.encoding, 'hz-gb-2312');
  assert.equal(r.text, 'pre 中文 post');
});

test('HZ 解码从严：高位字节/非法转义/奇数 GB 段一律拒绝', () => {
  assert.equal(decodeHz(Buffer.from([0xd6, 0xd0])), null, '高位字节不是 HZ');
  assert.equal(decodeHz(Buffer.from('~{VPN~}', 'ascii')), null, '奇数 GB 字节');
  assert.equal(decodeHz(Buffer.from('~{VPND~}', 'ascii')), '中文');
  assert.equal(decodeHz(Buffer.from('a~~b', 'ascii')), 'a~b', '~~ 转义为字面波浪号');
  // GBK 文本里的字面 ~{：高位字节让 decodeHz 拒绝，落回候选评分，不得误判 HZ。
  assert.equal(decodeBytes(Buffer.from([0xd6, 0xd0, 0x7e, 0x7b, 0xb1, 0xb8])).encoding, 'gb18030');
});

test('ISO-2022-JP 识别与解码', () => {
  assert.equal(looksLikeIso2022Jp(Buffer.from([0x41, 0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42])), true);
  assert.equal(looksLikeIso2022Jp(Buffer.from('plain ascii text', 'ascii')), false);
  // ESC $ B 进 JIS 区（0x24 0x22 = あ），ESC ( B 回 ASCII。真实文本的转义块之间总有
  // ASCII 字符；背靠背的 ESC ( B + ESC $ B 会触发 polyfill 的 FFFD 怪癖并被坏字节
  // 守卫拒绝（宁可回退也不导入缺字文本）。
  const bytes = [];
  for (let i = 0; i < 3; i += 1) bytes.push(0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42, 0x41);
  const r = decodeBytes(Buffer.from(bytes));
  assert.equal(r.encoding, 'iso-2022-jp');
  assert.ok(r.text.includes('\u3042'), 'JIS 段应还原为假名');
});

test('BOM 与正文不符时回退候选评分（UTF-8 BOM + GBK 正文）', () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb5, 0xc4, 0xc8, 0xcb]),
  ]);
  const r = decodeBytes(bytes);
  assert.equal(r.encoding, 'gb18030', '不得按 BOM 静默解成乱码');
  assert.equal(r.text, '中文的人', '候选评分应使用去 BOM 后的正文');
});

test('二进制文件抛 NOT_TEXT（魔数），普通文本不误伤', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  assert.throws(() => decodeBytes(zip), (error) => error && error.code === 'NOT_TEXT');
  const pdf = Buffer.from('%PDF-1.4\n%', 'latin1');
  assert.throws(() => decodeBytes(pdf), (error) => error && error.code === 'NOT_TEXT');
  assert.equal(sniffBinaryMagic(Buffer.from('普通文本', 'utf8')), false);
  assert.equal(sniffBinary(Buffer.alloc(1024, 0x00)), true, '高 NUL 兜底');
  assert.equal(sniffBinary(Buffer.from('abc', 'utf8')), false);
});
