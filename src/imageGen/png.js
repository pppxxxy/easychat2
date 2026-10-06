// 裸像素 → PNG 编码（纯 JS、无依赖，Node 可测）。
//
// Local Dream 的 /generate `complete` 事件返回的是 base64 裸 RGB 像素
// （channels=3，(h,w,c) 排列），不是 PNG/JPG。本模块把裸像素包成合法 PNG，
// 这样就能直接喂给现有的 base64 结果落盘/画廊路径。
//
// 选择「无依赖」：不引入 pako。PNG 的 IDAT 用 zlib 的 **stored（不压缩）块**
// 表达——无需实现 DEFLATE 压缩，只需正确的 zlib 头、块结构、Adler32 与 CRC32。
// 体积代价可忽略（每 64KB 仅多 5 字节块头），换来零依赖、零 Metro 复验、可直测
// （Node zlib.inflateSync 能还原原始扫描线，用来验证合法性）。

import { Buffer } from 'buffer';

import { tActive } from '../i18n/index.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_TYPE_BY_CHANNELS = { 1: 0, 2: 4, 3: 2, 4: 6 };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type, data) {
  const typeBytes = Array.from(type).map(char => char.charCodeAt(0));
  const body = typeBytes.concat(Array.from(data));
  const crc = crc32(Uint8Array.from(body));
  return u32(data.length).concat(body, u32(crc));
}

// zlib 流：0x78 0x01（无字典、最快） + stored deflate 块 + Adler32。
function zlibStored(raw) {
  const out = [0x78, 0x01];
  const MAX = 65535;
  if (raw.length === 0) {
    out.push(0x01, 0x00, 0x00, 0xff, 0xff);
  } else {
    for (let offset = 0; offset < raw.length; offset += MAX) {
      const block = raw.subarray(offset, Math.min(offset + MAX, raw.length));
      const final = offset + MAX >= raw.length ? 1 : 0;
      out.push(final);
      out.push(block.length & 0xff, (block.length >>> 8) & 0xff);
      out.push(~block.length & 0xff, ((~block.length) >>> 8) & 0xff);
      for (let i = 0; i < block.length; i += 1) out.push(block[i]);
    }
  }
  const adler = adler32(raw);
  out.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return Uint8Array.from(out);
}

// 裸像素 → PNG 字节。channels：3=RGB / 4=RGBA / 2=灰+alpha / 1=灰度。
export function encodePngFromRgb(pixels, width, height, channels = 3) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  const c = Math.trunc(Number(channels));
  if (!(w > 0) || !(h > 0)) throw new Error(tActive('error.imageGen.pngInvalidSize'));
  // 不能写成 `!COLOR_TYPE_BY_CHANNELS[c]`：灰度通道 1 映射到颜色类型 0（falsy），
  // 会被误判为「不支持」而拒绝。用 hasOwnProperty 精确判定键是否存在。
  if (!Object.prototype.hasOwnProperty.call(COLOR_TYPE_BY_CHANNELS, c)) {
    throw new Error(tActive('error.imageGen.pngUnsupportedChannels', { channels }));
  }
  const source = pixels instanceof Uint8Array ? pixels : Uint8Array.from(pixels || []);
  const expected = w * h * c;
  if (source.length < expected) {
    throw new Error(tActive('error.imageGen.pngPixelsInsufficient', { expected, actual: source.length }));
  }
  // 每行前置一个 filter 字节（0 = None）。
  const stride = w * c;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0;
    raw.set(source.subarray(src, src + stride), dst + 1);
  }
  const ihdr = u32(w).concat(u32(h), [8, COLOR_TYPE_BY_CHANNELS[c], 0, 0, 0]);
  const bytes = Uint8Array.from(
    PNG_SIGNATURE
      .concat(chunk('IHDR', Uint8Array.from(ihdr)))
      .concat(chunk('IDAT', zlibStored(raw)))
      .concat(chunk('IEND', new Uint8Array(0)))
  );
  return bytes;
}

// 裸像素 → PNG 的 base64（直接作为 { base64 } 结果消费）。
export function encodePngBase64FromRgb(pixels, width, height, channels = 3) {
  return Buffer.from(encodePngFromRgb(pixels, width, height, channels)).toString('base64');
}

// base64 裸像素 → Uint8Array。
export function decodeBase64ToBytes(base64) {
  const clean = String(base64 || '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  return Uint8Array.from(Buffer.from(clean, 'base64'));
}
