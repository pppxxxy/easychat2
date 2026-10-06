// PNG 角色卡读取：优先 parsecard，失败回退手解 tEXt/iTXt 分块。纯函数。
import { readJsonFromPNG } from 'parsecard';
import { Buffer } from 'buffer';

import { tActive } from '../../i18n/index.js';

import { parseCardFromJson } from './json.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.length === 'number') return Uint8Array.from(input);
  return new Uint8Array(0);
}

function isPng(data) {
  if (data.length < 8) return false;
  return PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

function readUint32(data, offset) {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

function decodeBase64(base64) {
  return Buffer.from(String(base64).replace(/\s+/g, ''), 'base64').toString('utf8');
}

function readTextChunkBase64(data, keyword) {
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = readUint32(data, offset);
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) {
      throw new Error(tActive('error.cardParser.pngChunkLength', { type }));
    }
    if (type === 'tEXt') {
      const separator = data.indexOf(0x00, start);
      if (separator !== -1 && separator < end) {
        const key = Buffer.from(data.slice(start, separator)).toString('utf8');
        if (key === keyword) {
          return Buffer.from(data.slice(separator + 1, end)).toString('utf8');
        }
      }
    } else if (type === 'iTXt') {
      const separator = data.indexOf(0x00, start);
      if (separator !== -1 && separator + 2 < end) {
        const key = Buffer.from(data.slice(start, separator)).toString('utf8');
        const compressionFlag = data[separator + 1];
        if (key === keyword && compressionFlag === 0) {
          const languageEnd = data.indexOf(0x00, separator + 3);
          if (languageEnd !== -1) {
            const translatedEnd = data.indexOf(0x00, languageEnd + 1);
            if (translatedEnd !== -1 && translatedEnd < end) {
              return Buffer.from(data.slice(translatedEnd + 1, end)).toString('utf8');
            }
          }
        }
      }
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  return null;
}

function readFallbackJsonFromPng(bytes) {
  const data = toUint8Array(bytes);
  if (!isPng(data)) {
    throw new Error(tActive('error.cardParser.pngSignature'));
  }
  for (const keyword of ['ccv3', 'chara']) {
    const base64 = readTextChunkBase64(data, keyword);
    if (base64) {
      try {
        return decodeBase64(base64);
      } catch (error) {
        throw new Error(tActive('error.cardParser.pngBase64Decode', { message: error.message }));
      }
    }
  }
  return null;
}

export function readCardJsonFromPng(bytes) {
  let primaryError = null;
  try {
    const text = readJsonFromPNG(toUint8Array(bytes));
    if (text) return text;
  } catch (error) {
    primaryError = error;
  }
  const fallback = readFallbackJsonFromPng(bytes);
  if (fallback) return fallback;
  if (primaryError) throw primaryError;
  return null;
}

export function parseCardFromPng(bytes) {
  const jsonText = readCardJsonFromPng(bytes);
  if (!jsonText) return null;
  return parseCardFromJson(jsonText);
}
