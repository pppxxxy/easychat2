// 共享 PNG 原语：灰度位图编码（被二维码用到）+ 与 cardExporter 的契约。
//
// 这里重点验两件事，都是「错了但很难看出来」的类型：
//   1) PNG 结构必须真的合法（用独立 inflate 解回来，而不是信任自己写的 CRC）；
//   2) 位图必须真压缩——stored 块会产出 100 倍大的文件，肉眼看不出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const { unzlibSync } = require('fflate');

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

const png = loadSourceModule('src/share/png.js');

// 最小 PNG 解析器：读出宽高并把 IDAT 解压回原始扫描线。
// 用独立实现（不调被测代码）才能验证写出的 PNG 真的合法。
function parsePng(bytes) {
  const u8 = new Uint8Array(bytes);
  assert.deepEqual(Array.from(u8.slice(0, 8)), Array.from(png.PNG_SIGNATURE), 'PNG 签名');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  const read32 = o => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  while (offset + 8 <= u8.length) {
    const length = read32(offset);
    const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
    const data = u8.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = read32(offset + 8);
      height = read32(offset + 12);
      bitDepth = data[8];
      colorType = data[9];
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = unzlibSync(new Uint8Array(Buffer.concat(idat)));
  return { width, height, bitDepth, colorType, raw };
}

function bitmapOf(rows) {
  return rows;
}

test('encodeBitmapPng：产出合法 PNG，IHDR 为 8 位灰度', () => {
  const bytes = png.encodeBitmapPng(bitmapOf([[true, false], [false, true]]));
  const parsed = parsePng(bytes);
  assert.equal(parsed.bitDepth, 8);
  assert.equal(parsed.colorType, 0, '灰度（0）');
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 2);
});

test('encodeBitmapPng：像素与扫描线滤波器都正确（解码回来逐点比对）', () => {
  const rows = [[true, false, true], [false, true, false]];
  const parsed = parsePng(png.encodeBitmapPng(rows));
  const rowSize = 1 + parsed.width;
  for (let y = 0; y < rows.length; y += 1) {
    assert.equal(parsed.raw[y * rowSize], 0, '每行滤波器字节应为 0');
    for (let x = 0; x < rows[y].length; x += 1) {
      const value = parsed.raw[y * rowSize + 1 + x];
      assert.equal(value, rows[y][x] ? 0 : 255, `像素 (${y},${x}) 应映射为黑白`);
    }
  }
});

test('encodeBitmapPng：scale 与 quiet 改变输出尺寸，静区为白', () => {
  const bytes = png.encodeBitmapPng([[true]], { scale: 3, quiet: 2 });
  const parsed = parsePng(bytes);
  assert.equal(parsed.width, (1 + 2 * 2) * 3, '(1 格 + 前后各 2 格静区) × 3 倍');
  assert.equal(parsed.height, 15);
  assert.equal(parsed.raw[1], 255, '静区左上角应为白');
});

test('encodeBitmapPng：位图必须真压缩（stored 块会让文件大 100 倍）', () => {
  // 模拟二维码放大后的位图：大面积重复
  const size = 120;
  const rows = Array.from({ length: size }, (unused, y) => (
    Array.from({ length: size }, (unused2, x) => (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0)
  ));
  const bytes = png.encodeBitmapPng(rows, { scale: 6, quiet: 4 });
  const rawBytes = parsePng(bytes).raw.length;
  assert.ok(bytes.length < rawBytes / 10,
    `压缩后应远小于原始扫描线（${bytes.length} vs ${rawBytes}）`);
});

test('encodeBitmapPng：空位图抛错而不是产出坏图', () => {
  assert.throws(() => png.encodeBitmapPng([]), /share\./);
  assert.throws(() => png.encodeBitmapPng([[]]), /share\./);
  assert.throws(() => png.encodeBitmapPng(null), /share\./);
});

test('injectCharaChunk：需要注入 base64 编码函数（否则明确抛错）', () => {
  const base = png.createPlaceholderPng();
  assert.throws(() => png.injectCharaChunk(base, '{}'), /share\./);
});

test('injectCharaChunk：嵌入后写出 chara 文本块，且清掉旧的角色卡块', () => {
  const base = png.createPlaceholderPng();
  const encodeBase64 = text => Buffer.from(String(text), 'utf8').toString('base64');
  const once = png.injectCharaChunk(base, JSON.stringify({ name: '第一版' }), encodeBase64);
  assert.ok(Buffer.from(once).includes(Buffer.from('chara')), '应含 chara 块');
  const twice = png.injectCharaChunk(once, JSON.stringify({ name: '第二版' }), encodeBase64);
  const occurrences = Buffer.from(twice).toString('latin1').split('chara').length - 1;
  assert.equal(occurrences, 1, '重复注入不应留下两份 chara 块（否则读取方可能命中旧的）');
  const text = Buffer.from(twice).toString('latin1');
  const expected = encodeBase64(JSON.stringify({ name: '第二版' }));
  assert.ok(text.includes(expected), '应写入最新内容的 base64');
});

test('injectCharaChunk：也清理 iTXt/zTXt 里的旧卡（只清 tEXt 会漏）', () => {
  // 手工拼一个带 iTXt 旧卡的 PNG：不带这个断言时，只清 tEXt 的实现会静默通过
  const base = png.createPlaceholderPng();
  const u8 = new Uint8Array(base);
  const read32 = o => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const parts = [u8.slice(0, 8)];
  let offset = 8;
  while (offset + 8 <= u8.length) {
    const length = read32(offset);
    const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
    if (type === 'IDAT') {
      // 在 IDAT 之前插入一个 iTXt 旧卡块
      const keyword = Buffer.from('ccv3\u0000\u0000\u0000\u0000', 'latin1');
      const body = Buffer.concat([Buffer.from('iTXt', 'latin1'), keyword, Buffer.from('OLD')]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(png.crc32(new Uint8Array(body)) >>> 0, 0);
      const chunk = Buffer.alloc(4);
      chunk.writeUInt32BE(keyword.length + 3, 0);
      parts.push(chunk, body, crc);
    }
    parts.push(u8.slice(offset, offset + 12 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const withOldItxt = Buffer.concat(parts.map(part => Buffer.from(part)));
  // 旧卡在 iTXt 里；注入新卡后不应再有 ccv3（tEXt/iTXt/zTXt 任何一个残留都算失败）
  const cleaned = png.injectCharaChunk(withOldItxt, JSON.stringify({ name: '新卡' }),
    text => Buffer.from(String(text), 'utf8').toString('base64'));
  const latin = Buffer.from(cleaned).toString('latin1');
  assert.equal(latin.includes('ccv3'), false, 'iTXt 里的旧卡必须被清掉');
  assert.equal(latin.includes('OLD'), false, '旧卡数据不应残留');
});

test('isPng：识别签名，拒绝非 PNG', () => {
  assert.equal(png.isPng(png.createPlaceholderPng()), true);
  assert.equal(png.isPng(Uint8Array.from([1, 2, 3])), false);
  assert.equal(png.isPng(new Uint8Array(0)), false);
  assert.equal(png.isPng(null), false);
});
