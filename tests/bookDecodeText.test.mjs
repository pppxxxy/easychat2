import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BAD_RATIO_THRESHOLD,
  FFFD_THRESHOLD,
  HZ_MIN_HAN_RATIO,
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
  textStats,
  undesirableRatio,
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
  // 真 HZ 是中文正文：段与段之间用 ASCII 退出 GB 模式（GB 段内不允许 0x20 空格）。
  // 5ZR;UB=第一章、VPND=中文、2bJT=测试、DZH]=内容（用本仓 gb18030 解码器反查核对）。
  const hz = '~{5ZR;UB~} ~{VPND~}~{2bJT~}~{DZH]~}';
  const r = decodeBytes(Buffer.from(hz, 'ascii'));
  assert.equal(r.encoding, 'hz-gb-2312');
  assert.equal(r.text, '第一章 中文测试内容');
});

test('HZ 内容门槛：纯 ASCII 里的合法 ~{…~} 不得被判 HZ（原文逐字不变）', () => {
  // looksLikeHz 只数签名出现次数，不校验配对与上下文；而 ~{…~} 之间的字节会被当 GB2312
  // 重解——VPND 剥高位正是「中文」的 GB2312 字节，所以英文散文/代码里的一个 HZ 转义
  // 以前会被**静默改写**：printf("~{VPND~}") → printf("中文")。
  const prose = 'The HZ syntax is ~{VPND~} for CJK text, see the manual.';
  assert.equal(looksLikeHz(Buffer.from(prose, 'ascii')), true, '前提：签名确实命中');
  assert.ok(textStats('The HZ syntax is 中文 for CJK text, see the manual.').han < HZ_MIN_HAN_RATIO,
    '前提：误判后解出的汉字占比远低于门槛');
  const r = decodeBytes(Buffer.from(prose, 'ascii'));
  assert.equal(r.encoding, 'utf-8', '无中文正文的签名命中不是 HZ，放回常规流程');
  assert.equal(r.text, prose, '原文必须逐字不变（不得被当 GB2312 重解）');

  const code = 'printf("~{VPND~}")';
  const r2 = decodeBytes(Buffer.from(code, 'ascii'));
  assert.equal(r2.encoding, 'utf-8');
  assert.equal(r2.text, code);

  // 已知取舍（如实钉住，别当回归修）：HZ 段短、ASCII 框架长的样本（如一行英文里的一个
  // 中文词）也会被门槛放回候选评分，最终按 utf-8 逐字收下——用户看到的是原文里的
  // ~{…~}，而不是被静默改写成别的字。这是 decodeText.js 里「宁可放回候选评分，也不
  // 误吞一份普通文本」的既定取向。
  const short = 'pre ~{VPND~} post';
  const rShort = decodeBytes(Buffer.from(short, 'ascii'));
  assert.equal(rShort.encoding, 'utf-8');
  assert.equal(rShort.text, short);
});

test('全 NUL / 近全 NUL 输入抛 NOT_TEXT（NUL 是合法 UTF-8，不得整本当文本导入）', () => {
  // 修复前 isStrictUtf8 排在 NUL 复核之前：0x00 ≤ 0x7f 是合法 UTF-8 单字节，全零文件被
  // 当 utf-8 收下（encoding:'utf-8'、无替换符），importBook 的 text.trim() 又不裁 NUL
  // ⇒ 落库成一本「打开后什么都没有」的书，全程无报错。
  assert.throws(
    () => decodeBytes(Buffer.alloc(1024, 0x00)),
    (error) => error && error.code === 'NOT_TEXT',
    '全零文件必须抛 NOT_TEXT',
  );
  const nearly = Buffer.alloc(1024, 0x00);
  nearly[5] = 0x41;
  assert.throws(
    () => decodeBytes(nearly),
    (error) => error && error.code === 'NOT_TEXT',
    '近全零同样不许落成文本',
  );
  // 前提：辅助函数本来就判对了，问题只在于那条路径根本不咨询它（本条钉住「别再排回去」）。
  assert.equal(sniffBinary(Buffer.alloc(1024, 0x00)), true, '高 NUL 兜底');
});

test('NUL 复核不得误杀真实 UTF-16 文本（ASCII 的 UTF-16 NUL 字节占比 50%）', () => {
  // 顺序约束：UTF-16 零字节启发必须排在 NUL 复核之前。ASCII 的 UTF-16 文本同时踩中
  // 两个坑——字节序列本身是合法 UTF-8（NUL 合法），且 NUL 字节占比过半（会被判二进制）。
  const text = 'Hello world, this is ASCII text stored as UTF-16LE. 0123456789';
  const le = Buffer.from(text, 'utf16le');
  assert.equal(isStrictUtf8(le), true, '前提：ASCII 的 UTF-16 字节序列本身就是合法 UTF-8');
  assert.equal(sniffBinary(le), true, '前提：NUL 字节占比过半，NUL 复核会判它二进制');
  assert.equal(looksLikeUtf16(le), 'utf-16le', '前提：零字节启发认得它');
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

test('UTF-32 BOM 与正文不符时不得裸返回（落回候选/二进制复核）', () => {
  // FF FE 00 00 开头但正文是 UTF-16LE：detectUtf32Bom 认领，解出来是成片 U+FFFD。
  // 修复前该分支裸返回 { encoding:'utf-32le', replacementRatio:1 } ⇒ 落库成一本「全是 �」的书。
  const mismatch = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x42, 0x00]);
  let outcome = null;
  try {
    outcome = decodeBytes(mismatch);
  } catch (error) {
    outcome = error;
  }
  assert.notEqual(outcome.encoding, 'utf-32le', '不得按 UTF-32LE 静默收下');
  assert.ok(
    outcome instanceof Error && (outcome.code === 'NOT_TEXT' || outcome.code === 'ENCODING'),
    `应落回候选评分/二进制复核，实际：${JSON.stringify(outcome && outcome.encoding)}`,
  );

  // 全零碎片同理：解出的是成片 NUL（replacementRatio 为 0，只有 NUL 复核看得见），
  // 修复前它连二进制魔数与 NUL 复核都绕过了。
  const zeros = Buffer.alloc(2048, 0x00);
  zeros[0] = 0xff;
  zeros[1] = 0xfe;
  assert.throws(() => decodeBytes(zeros), (error) => error && error.code === 'NOT_TEXT');

  // 正向面（真 UTF-32 仍要能解出）由上面的「UTF-32 BOM（LE/BE）解码正确」覆盖。
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

// ---- 三处「坏码位」口径：包含关系必须只有一处定义 ----
//
// 以前 replacementRatio（只数 FFFD）、undesirableRatio（+NUL+非字符）、textStats.bad（+控制符）
// 各写一遍循环，改一处必漏两处；且同一个 ENCODING_FFFD_THRESHOLD 同时作用在前两者的**不同分母**
// 上。现在统一由 isBadCodePoint 派生、阈值按分母拆成 FFFD_THRESHOLD / BAD_RATIO_THRESHOLD。
// 下面把三者的包含关系钉住——这是重构「不改变行为」的证据。
test('坏码位三口径保持包含关系（重构不改行为）', () => {
  // U+FFFD：三者都算。
  assert.equal(replacementRatio('\uFFFD'), 1);
  assert.equal(undesirableRatio('\uFFFD'), 1);
  assert.equal(textStats('\uFFFD').bad, 1);
  // U+0000 NUL：replacementRatio 不算（它的语义严格是「替换符占比」），另两个算。
  assert.equal(replacementRatio('\u0000'), 0);
  assert.equal(undesirableRatio('\u0000'), 1);
  assert.equal(textStats('\u0000').bad, 1);
  // 非字符 U+FFFE / U+FDD0：同上。
  assert.equal(replacementRatio('\uFFFE\uFDD0'), 0);
  assert.equal(undesirableRatio('\uFFFE\uFDD0'), 1);
  assert.equal(textStats('\uFFFE\uFDD0').bad, 1);
  // 控制符 BEL：只有 textStats.bad 算（候选评分要惩罚「解出一堆控制符」的乱码）。
  assert.equal(replacementRatio('\u0007'), 0);
  assert.equal(undesirableRatio('\u0007'), 0);
  assert.equal(textStats('\u0007').bad, 1);
  // 制表/换行/回车是正常文本，三者都不算。
  for (const fn of [replacementRatio, undesirableRatio]) assert.equal(fn('\t\n\r'), 0);
  assert.equal(textStats('\t\n\r').bad, 0);
  // 空串一律 0（分母为 0 的分支）。
  assert.equal(replacementRatio(''), 0);
  assert.equal(undesirableRatio(''), 0);
  // 阈值按分母拆名后仍是同一个值，且两个名字都在。
  assert.equal(FFFD_THRESHOLD, BAD_RATIO_THRESHOLD);
});

test('cjkRatio 死代码不得回归（职责已由 candidateScore 的 han/big5 bonus 承担）', () => {
  // 全仓复核过：src 0 引用、tests 0 引用，注释自述的「区分 GB18030 与 BIG5」职责
  // 已由 candidateScore 的 han/big5 bonus 承担（decodeText.js 的 candidateScore）。
  const source = fs.readFileSync('src/books/decodeText.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(source.includes('cjkRatio'), false, 'cjkRatio 不得再出现（含重新引入）');
});
