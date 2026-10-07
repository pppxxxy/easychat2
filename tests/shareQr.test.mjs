// 二维码编码器：结构不变量 + **真实解码器**验证。
//
// 这是本模块唯一诚实的验收方式：矩阵「看起来像二维码」没有意义，必须能被
// 独立实现的解码器（jsQR，与本项目编码器无任何代码共享）还原出原文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { encodeQr, pickVersion, dataCapacityBytes, EC_LEVEL_L } from '../src/share/qr.js';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr');

// 把点阵渲染成解码器要的 RGBA 像素（带静区与放大），模拟真实扫码。
function toImageData(modules, scale = 3, quiet = 4) {
  const n = modules.length;
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const y = (r + quiet) * scale + dy;
          const x = (c + quiet) * scale + dx;
          const i = (y * size + x) * 4;
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

function decode(modules) {
  const img = toImageData(modules);
  const result = jsQR(img.data, img.width, img.height);
  return result ? result.data : null;
}

test('encodeQr：矩阵尺寸符合版本公式（4v+17），且只含布尔值', () => {
  const { version, size, modules } = encodeQr('HELLO');
  assert.equal(version, 1);
  assert.equal(size, 21, '版本 1 应为 21×21');
  assert.equal(modules.length, size);
  assert.equal(modules[0].length, size);
  modules.forEach(row => row.forEach(cell => assert.equal(typeof cell, 'boolean')));
});

test('encodeQr：定位图形（三个角）按规范落位', () => {
  const { modules } = encodeQr('HELLO');
  const n = modules.length;
  // 定位图形的结构判据：7×7 外框必须整圈深色、内部 5×5 的环必须浅色、中心 3×3 深色。
  // （不能只看角点单格——数据区某格偶然为深色时，那种判据会误报。）
  const probe = (top, left) => {
    const row = r => modules[top + r].slice(left, left + 7);
    assert.deepEqual(row(0), [true, true, true, true, true, true, true], '外框顶行应为深色');
    assert.deepEqual(row(6), [true, true, true, true, true, true, true], '外框底行应为深色');
    assert.deepEqual(row(1).slice(1, 6), [false, false, false, false, false], '第二行内圈应为浅色');
    assert.deepEqual(row(2).slice(2, 5), [true, true, true], '中心 3×3 应为深色');
    assert.deepEqual(row(5).slice(1, 6), [false, false, false, false, false], '倒数第二行内圈应为浅色');
  };
  probe(0, 0);
  probe(0, n - 7);
  probe(n - 7, 0);
  // 时序图形：第 7 行/列在定位图形之间黑白交替
  const timing = modules[6].slice(8, n - 8);
  assert.ok(timing.length > 0 && timing.every((cell, index) => cell === (index % 2 === 0)),
    '第 6 行应为黑白交替的时序图形');
});

test('encodeQr：内容能被独立解码器原样还原（核心验收）', () => {
  const cases = [
    'HELLO',
    'A',
    'https://easychat2.example/share#EC2CARD1:abc',
    'x'.repeat(100),
    'x'.repeat(500),
    'EC2CARD1:' + 'A'.repeat(1200),
  ];
  for (const text of cases) {
    const { modules } = encodeQr(text);
    assert.equal(decode(modules), text, `解码结果应与原文一致（长度 ${text.length}）`);
  }
});

test('encodeQr：中文等多字节内容按 UTF-8 编码后同样可解', () => {
  const text = '中文内容测试：阿澈，银色短发。';
  const { modules } = encodeQr(text);
  assert.equal(decode(modules), text, 'UTF-8 路径必须与解码器一致');
});

test('encodeQr：装不下的内容明确抛错，而不是产出坏码', () => {
  // 版本 40 + 纠错 L 的容量上限约 2953 字节；给一个远超的量
  assert.throws(() => encodeQr('x'.repeat(5000)), /超出二维码容量/);
});

test('pickVersion：选能装下的最小版本，且接近上限时的判断把头部算进去', () => {
  assert.equal(pickVersion(1, EC_LEVEL_L), 1);
  // 版本 1-L 的数据容量是 19 码字，其中 4 位模式 + 8 位长度 = 1.5 字节
  const cap1 = dataCapacityBytes(1, EC_LEVEL_L);
  assert.equal(cap1, 19);
  assert.equal(pickVersion(17, EC_LEVEL_L), 1, '17 字节在版本 1 内（1.5+17=18.5 < 19）');
  assert.equal(pickVersion(18, EC_LEVEL_L), 2, '18 字节装不进版本 1');
});

test('dataCapacityBytes：容量随版本单调不减', () => {
  let previous = 0;
  for (let version = 1; version <= 40; version += 1) {
    const capacity = dataCapacityBytes(version, EC_LEVEL_L);
    assert.ok(capacity > previous, `版本 ${version} 的容量应大于上一版`);
    previous = capacity;
  }
  // 版本 40-L 是二维码容量上限（2953 字节）
  assert.equal(dataCapacityBytes(40, EC_LEVEL_L), 2956);
});

test('encodeQr：空字符串也能编成合法二维码（边界）', () => {
  const { modules } = encodeQr('');
  assert.equal(decode(modules), '', '空内容应解码为空串');
});

test('encodeQr：按罚分规则选掩码，而不是固定用某一个', () => {
  // 掩码选择是「扫码质量」而非「能否解码」——任何掩码都能被解码器读出，所以
  // 解码类断言抓不到「永远用 0 号掩码」这种退化。这里直接钉住选择行为：
  const patterns = new Set();
  for (const text of ['HELLO', 'A', 'https://easychat2.example/share#abc', 'x'.repeat(64)]) {
    patterns.add(encodeQr(text).maskPattern);
  }
  assert.ok(patterns.size > 1,
    `不同内容应能选出不同掩码（否则罚分逻辑失效），实际只出现 ${[...patterns].join(',')}`);
  // 版本 1 的格式信息位必须随掩码变化（固定掩码会让这 15 位也不变）
  const a = encodeQr('HELLO');
  const b = encodeQr('HELLO', { minVersion: 1 });
  assert.equal(a.maskPattern, b.maskPattern, '同一内容同一版本，掩码选择应可复现');
});
