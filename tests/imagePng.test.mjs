import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  decodeBase64ToBytes,
  encodePngBase64FromRgb,
  encodePngFromRgb,
} from '../src/imageGen/png.js';

// 解析 PNG 块序列，返回 [{ type, data }]。
function readChunks(bytes) {
  const chunks = [];
  let offset = 8; // 跳过签名
  while (offset < bytes.length) {
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length; // length + type(4) + data + crc(4)
  }
  return chunks;
}

test('PNG 签名与块结构合法（IHDR/IDAT/IEND）', () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]); // 2x2
  const png = encodePngFromRgb(rgb, 2, 2, 3);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = readChunks(png);
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  // IHDR：宽、高、位深 8、颜色类型 2（RGB）
  const ihdr = chunks[0].data;
  assert.equal((ihdr[0] << 24) | (ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3], 2);
  assert.equal((ihdr[4] << 24) | (ihdr[5] << 16) | (ihdr[6] << 8) | ihdr[7], 2);
  assert.equal(ihdr[8], 8);
  assert.equal(ihdr[9], 2);
});

test('IDAT 可被 zlib 解压还原为原始扫描线（每行带 filter=0）', () => {
  const rgb = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]); // 2x2 RGB
  const png = encodePngFromRgb(rgb, 2, 2, 3);
  const idat = readChunks(png).find(c => c.type === 'IDAT').data;
  const raw = zlib.inflateSync(Buffer.from(idat));
  // 每行 = 1 filter 字节 + 2 像素 * 3 通道
  assert.equal(raw.length, 2 * (1 + 6));
  assert.equal(raw[0], 0); // filter None
  assert.deepEqual(Array.from(raw.subarray(1, 7)), [10, 20, 30, 40, 50, 60]);
  assert.equal(raw[7], 0);
  assert.deepEqual(Array.from(raw.subarray(8, 14)), [70, 80, 90, 100, 110, 120]);
});

test('RGBA（4 通道）颜色类型为 6，且扫描线长度正确', () => {
  const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]); // 2x2 RGBA
  const png = encodePngFromRgb(rgba, 2, 2, 4);
  const chunks = readChunks(png);
  assert.equal(chunks[0].data[9], 6);
  const raw = zlib.inflateSync(Buffer.from(chunks.find(c => c.type === 'IDAT').data));
  assert.equal(raw.length, 2 * (1 + 8));
});

test('非方形与大于 65535 字节时使用多个 stored 块仍可解压', () => {
  const width = 200;
  const height = 200;
  const rgb = new Uint8Array(width * height * 3).fill(127);
  const png = encodePngFromRgb(rgb, width, height, 3);
  const raw = zlib.inflateSync(Buffer.from(readChunks(png).find(c => c.type === 'IDAT').data));
  assert.equal(raw.length, height * (1 + width * 3));
  assert.equal(raw[1], 127);
});

test('encodePngBase64FromRgb 输出可 base64 解码回 PNG 字节', () => {
  const rgb = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const b64 = encodePngBase64FromRgb(rgb, 1, 2, 3);
  const bytes = decodeBase64ToBytes(b64);
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('非法输入：尺寸无效/像素不足/不支持的通道数均抛错', () => {
  assert.throws(() => encodePngFromRgb(new Uint8Array(12), 0, 2, 3), /尺寸无效/);
  assert.throws(() => encodePngFromRgb(new Uint8Array(5), 2, 2, 3), /像素数据不足/);
  assert.throws(() => encodePngFromRgb(new Uint8Array(12), 2, 2, 5), /不支持的通道数/);
});

test('decodeBase64ToBytes：去空白并正确处理空值', () => {
  assert.equal(decodeBase64ToBytes('').length, 0);
  assert.equal(decodeBase64ToBytes(null).length, 0);
  assert.equal(decodeBase64ToBytes('AQID').length, 3);
});
