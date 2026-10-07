// 最小 PNG 读写原语（自拼字节，零依赖，Node 可直测）。
//
// 从 character/cardExporter.js 原样外提：角色卡导出（往头像 PNG 里嵌角色数据）
// 与分享二维码（把 0/1 矩阵画成 PNG）都要用同一套 CRC / tEXt / deflate 原语，
// 各写一份必然漂移。cardExporter 通过 import 复用，行为不变。

import { tActive } from '../i18n/index.js';
import { zlibSync } from 'fflate';

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function uint32BE(value) {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

export function readUint32(data, offset) {
  return (
    ((data[offset] << 24)
      | (data[offset + 1] << 16)
      | (data[offset + 2] << 8)
      | data[offset + 3]) >>> 0
  );
}

export function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.length === 'number') return Uint8Array.from(input);
  return new Uint8Array(0);
}

export function isPng(bytes) {
  const data = toUint8Array(bytes);
  if (data.length < 8) return false;
  return PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

export function makeChunk(type, data) {
  const typeBytes = Uint8Array.from(Array.from(type).map(ch => ch.charCodeAt(0)));
  const body = concatBytes([typeBytes, data]);
  return concatBytes([uint32BE(data.length), body, uint32BE(crc32(body))]);
}

function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

export function makeTextChunk(keyword, value) {
  return makeChunk(
    'tEXt',
    concatBytes([
      encodeLatin1(keyword),
      Uint8Array.from([0]),
      encodeLatin1(value),
    ])
  );
}

// zlib 流（deflate "stored" 块：不压缩，只打包）。
// 保留原实现是因为 cardExporter 的占位图/嵌卡路径依赖它产出的**确定字节**，
// 换压缩算法会改变输出（既有测试断言的是行为，但没必要的变更不做）。
// 需要真正压缩的场景（二维码位图，上百万像素重复度高）走 zlibCompress。
export function deflateStored(bytes) {
  const parts = [Uint8Array.from([0x78, 0x01])];
  const maxBlock = 65535;
  let offset = 0;
  do {
    const size = Math.min(bytes.length - offset, maxBlock);
    const final = offset + size >= bytes.length ? 1 : 0;
    parts.push(Uint8Array.from([
      final,
      size & 0xff,
      (size >>> 8) & 0xff,
      (~size) & 0xff,
      ((~size) >>> 8) & 0xff,
    ]));
    parts.push(bytes.slice(offset, offset + size));
    offset += size;
  } while (offset < bytes.length);
  parts.push(uint32BE(adler32(bytes)));
  return concatBytes(parts);
}

export function createPlaceholderPng(width = 2, height = 2) {
  const rowSize = 1 + width * 3;
  const raw = new Uint8Array(height * rowSize);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = 0x6c;
      raw[pixel + 1] = 0x63;
      raw[pixel + 2] = 0xff;
    }
  }
  const ihdr = concatBytes([
    uint32BE(width),
    uint32BE(height),
    Uint8Array.from([8, 2, 0, 0, 0]),
  ]);
  return concatBytes([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateStored(raw)),
    makeChunk('IEND', new Uint8Array(0)),
  ]);
}

function textChunkKeyword(bytes, dataStart, dataEnd) {
  for (let index = dataStart; index < dataEnd; index += 1) {
    if (bytes[index] === 0) {
      let keyword = '';
      for (let cursor = dataStart; cursor < index; cursor += 1) {
        keyword += String.fromCharCode(bytes[cursor]);
      }
      return keyword;
    }
  }
  return '';
}

// 黑白点阵 → 灰度 PNG（位深 8、颜色类型 0）。
// 用灰度而不是调色板/位深 1：图会大一些，但省掉位打包与调色板两块易错逻辑，
// 且所有图片查看器都能显示。scale 是每个点阵格画多少像素，quiet 是静区格数
// （二维码规范要求至少 4 格静区，缺了会让很多扫码器识别失败）。
export function encodeBitmapPng(bitmap, options = {}) {
  const rows = Array.isArray(bitmap) ? bitmap : [];
  const height = rows.length;
  const width = height > 0 && Array.isArray(rows[0]) ? rows[0].length : 0;
  if (width === 0 || height === 0) {
    throw new Error(tActive('error.share.emptyBitmap'));
  }
  const scale = Number.isFinite(options.scale) && options.scale > 0
    ? Math.min(64, Math.trunc(options.scale))
    : 1;
  const quiet = Number.isFinite(options.quiet) && options.quiet >= 0
    ? Math.min(32, Math.trunc(options.quiet))
    : 0;
  const dark = options.dark === undefined ? 0 : Number(options.dark) & 0xff;
  const light = options.light === undefined ? 0xff : Number(options.light) & 0xff;

  const outWidth = (width + quiet * 2) * scale;
  const outHeight = (height + quiet * 2) * scale;
  const rowSize = 1 + outWidth;
  const raw = new Uint8Array(outHeight * rowSize);
  raw.fill(light);
  for (let y = 0; y < outHeight; y += 1) raw[y * rowSize] = 0; // 每行滤波器字节

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!rows[row][col]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const y = (row + quiet) * scale + dy;
        const base = y * rowSize + 1 + (col + quiet) * scale;
        for (let dx = 0; dx < scale; dx += 1) raw[base + dx] = dark;
      }
    }
  }

  const ihdr = concatBytes([
    uint32BE(outWidth),
    uint32BE(outHeight),
    Uint8Array.from([8, 0, 0, 0, 0]), // 8 位深、颜色类型 0（灰度）
  ]);
  // 位图必须真压缩：二维码放大 6 倍后有 120 万像素且高度重复，stored 块会产出
  // 一张 500KB+ 的图（实测），而 zlib 压到 4KB。这一步只是把 IDAT 换成压缩流，
  // 仍是标准 PNG，读取方无感。
  const idat = options.compress === false ? deflateStored(raw) : zlibSync(raw, { level: 9 });
  return concatBytes([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', new Uint8Array(0)),
  ]);
}

// 导出时先移除原图里已有的角色卡 tEXt chunk，否则 parsecard 读取时
// 仍会优先命中旧 ccv3/chara，导致编辑后的内容被旧卡覆盖。
export function injectCharaChunk(pngBytes, jsonText, encodeBase64) {
  const bytes = toUint8Array(pngBytes);
  if (!isPng(bytes)) {
    throw new Error(tActive('error.cardExport.invalidPng'));
  }
  if (typeof encodeBase64 !== 'function') {
    throw new Error(tActive('error.share.base64Required'));
  }
  const base64 = encodeBase64(String(jsonText));
  const textChunk = makeTextChunk('chara', base64);
  const parts = [PNG_SIGNATURE];
  let offset = 8;
  let inserted = false;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const total = 12 + length;
    let isCharacterCardChunk = false;
    // 三种文本块的关键词都是“首个 null 前的字符串”，可用同一提取器。
    // 只清 tEXt 会漏掉 iTXt/zTXt 里的旧卡数据：导出后 PNG 同时携带新旧两份
    // chara/ccv3 载荷，偏好 iTXt 的读取方（含部分第三方工具）会读到旧卡。
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const keyword = textChunkKeyword(bytes, offset + 8, offset + 8 + length);
      isCharacterCardChunk = keyword === 'chara' || keyword === 'ccv3';
    }
    if (type === 'IDAT' && !inserted) {
      parts.push(textChunk);
      inserted = true;
    }
    if (!isCharacterCardChunk) {
      parts.push(bytes.slice(offset, offset + total));
    }
    offset += total;
    if (type === 'IEND') break;
  }
  if (!inserted) {
    parts.push(textChunk);
  }
  return concatBytes(parts);
}
