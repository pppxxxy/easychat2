// 角色卡分享码：往返一致、容量判定、坏输入拒绝。
// 分享码是「跨设备搬运一张卡」的唯一载体，往返必须字节级一致——差一个字符
// 对方就拿到一张损坏的卡，而这类错误在真机上很难复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

function loadSourceModule(relativePath, stubs = {}) {
  const sourcePath = path.resolve(relativePath);
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    if (request.endsWith('/i18n/index.js')) return { tActive: key => key };
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

const share = loadSourceModule('src/share/cardShare.js');

test('分享码：往返完全一致（含中文与多字节内容）', () => {
  const cases = [
    '{"name":"阿澈"}',
    '{"name":"角色","desc":"银色短发，旧书店老板。","tags":["书店","冷淡"]}',
    JSON.stringify({ worldInfo: Array.from({ length: 30 }, (unused, index) => ({
      id: `w${index}`, content: `第 ${index} 条世界书设定，描述小镇的潮湿气候与人物关系。`,
    })) }),
  ];
  for (const json of cases) {
    const code = share.encodeCardShareCode(json);
    assert.equal(share.decodeCardShareCode(code), json, `往返应一致（原长 ${json.length}）`);
  }
});

test('分享码：带前缀标识，且能被识别', () => {
  const code = share.encodeCardShareCode('{"a":1}');
  assert.ok(code.startsWith(share.SHARE_CODE_PREFIX), `应以 ${share.SHARE_CODE_PREFIX} 开头`);
  assert.equal(share.isCardShareCode(code), true);
  assert.equal(share.isCardShareCode('   ' + code + '  '), true, '容忍首尾空白');
  assert.equal(share.isCardShareCode('{"a":1}'), false);
  assert.equal(share.isCardShareCode(''), false);
  assert.equal(share.isCardShareCode(null), false);
});

test('分享码：解压后体积远小于原文（压缩是二维码可行性的前提）', () => {
  const json = JSON.stringify({ text: '潮湿的小镇，终年多雨。'.repeat(200) });
  const code = share.encodeCardShareCode(json);
  assert.ok(code.length < json.length / 3, `压缩后应显著变小：原文 ${json.length} → 码 ${code.length}`);
});

test('分享码：base64url 字符集不含 + / =（避免复制粘贴被转义）', () => {
  const code = share.encodeCardShareCode(JSON.stringify({ d: '内容'.repeat(50) }));
  const payload = code.slice(share.SHARE_CODE_PREFIX.length);
  assert.equal(/[+/=]/.test(payload), false, '不应出现 + / =');
  assert.equal(/^[A-Za-z0-9_-]+$/.test(payload), true);
});

test('分享码：无前缀的裸载荷也能解（容错用户只复制了一半的情况）', () => {
  const code = share.encodeCardShareCode('{"a":1}');
  const bare = code.slice(share.SHARE_CODE_PREFIX.length);
  assert.equal(share.decodeCardShareCode(bare), '{"a":1}');
});

test('分享码：换行与空格被容忍（聊天窗口常把长文本折行）', () => {
  const code = share.encodeCardShareCode('{"a":1}');
  const payload = code.slice(share.SHARE_CODE_PREFIX.length);
  const folded = `${share.SHARE_CODE_PREFIX}${payload.slice(0, 5)}\n${payload.slice(5)}`;
  assert.equal(share.decodeCardShareCode(folded), '{"a":1}');
});

test('分享码：坏输入明确抛错，不静默产出空卡', () => {
  const bad = ['', '   ', null, undefined, 'EC2CARD1:', 'EC2CARD1:!!!!', 'notacode', 'EC2CARD1:####'];
  for (const input of bad) {
    assert.throws(() => share.decodeCardShareCode(input), /share\./, `应对 ${JSON.stringify(input)} 抛错`);
  }
  assert.throws(() => share.encodeCardShareCode(''), /share\./);
  assert.throws(() => share.encodeCardShareCode('   '), /share\./);
});

test('planShareCode：容量判定与超出量计算正确', () => {
  const small = share.planShareCode('EC2CARD1:abc');
  assert.equal(small.fitsQr, true);
  assert.equal(small.overBy, 0);
  assert.equal(small.limit, share.QR_MAX_CODE_CHARS);

  const big = share.planShareCode('x'.repeat(share.QR_MAX_CODE_CHARS + 40));
  assert.equal(big.fitsQr, false);
  assert.equal(big.overBy, 40);

  // 恰好等于上限应算装得下（边界不差一）
  const exact = share.planShareCode('x'.repeat(share.QR_MAX_CODE_CHARS));
  assert.equal(exact.fitsQr, true);

  assert.equal(share.planShareCode('').fitsQr, false, '空码不算可生成二维码');
});

test('QR_MAX_CODE_CHARS：不超过版本 40-L 的码字容量', () => {
  // 版本 40 + 纠错 L 的数据容量是 2956 码字，扣掉模式与长度指示符后
  // 可用的字节模式载荷上限约 2953；我们的阈值必须不超过它。
  assert.ok(share.QR_MAX_CODE_CHARS <= 2953, `阈值 ${share.QR_MAX_CODE_CHARS} 不能超过 2953`);
  assert.ok(share.QR_MAX_CODE_CHARS > 2500, '阈值过小会让本可扫码的卡被拒');
});
