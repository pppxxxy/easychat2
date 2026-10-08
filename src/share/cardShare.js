// 角色卡分享码：把角色卡 JSON 压成一段可直接放进二维码 / 剪贴板的短文本。
//
// 为什么用压缩：一张常规角色卡的 JSON 有 10-20KB，远超二维码容量（版本 40-L
// 是 2953 字节）；deflate 之后中文卡通常落在 1-3KB，多数卡能塞进单张二维码。
//
// 编码链：JSON → UTF-8 → deflate → base64url → `EC2CARD1:<payload>`
//   · base64url（- _ 而非 + /，无 = 填充）：二维码的字母数字模式对 - 和 _
//     不友好，但字节模式无所谓，且 base64url 更便于用户复制粘贴不被转义。
//   · 前缀是版本/类型标识：以后改格式可以换前缀，旧码仍能被识别为「不认识的码」
//     并给出明确提示，而不是解出一堆乱码。
//
// 纯逻辑，零依赖（fflate 已是本项目依赖），Node 可直测。

import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';
import { Buffer } from 'buffer';

import { tActive } from '../i18n/index.js';

export const SHARE_CODE_PREFIX = 'EC2CARD1:';

// 单张二维码的上限：版本 40 + 纠错 L 的数据容量是 2953 字节码字，
// 其中要扣掉 4 位模式 + 16 位长度指示符（版本 ≥10）≈ 2.5 字节。
// 取 2900 留一点余量，超过就引导用户改用「分享图片」。
export const QR_MAX_CODE_CHARS = 2900;

// 用 buffer 包的 Buffer 而不是 btoa/atob：那两个全局在 Hermes 与 Node 里的
// 可用性不一致，而 Buffer 已由 src/polyfills.js 全局装载（cardExporter 同款做法）。
export function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const buffer = Buffer.from(padded, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

// 角色卡 JSON 文本 → 分享码。传入的是 cardExporter 的 cardToJson 结果。
export function encodeCardShareCode(jsonText) {
  const json = String(jsonText == null ? '' : jsonText);
  if (!json.trim()) throw new Error(tActive('error.share.cardEmpty'));
  const packed = deflateSync(strToU8(json), { level: 9 });
  return `${SHARE_CODE_PREFIX}${toBase64Url(packed)}`;
}

export function isCardShareCode(text) {
  return String(text || '').trim().startsWith(SHARE_CODE_PREFIX);
}

// 分享码 → 角色卡 JSON 文本。任何一步失败都抛错，由调用方提示用户。
export function decodeCardShareCode(code) {
  const raw = String(code == null ? '' : code).trim();
  if (!raw) throw new Error(tActive('error.share.cardEmpty'));
  const payload = raw.startsWith(SHARE_CODE_PREFIX)
    ? raw.slice(SHARE_CODE_PREFIX.length)
    : raw;
  const compact = payload.replace(/\s+/g, '');
  if (!compact) throw new Error(tActive('error.share.cardEmpty'));
  let inflated;
  try {
    inflated = inflateSync(fromBase64Url(compact));
  } catch (error) {
    throw new Error(tActive('error.share.invalidCode'));
  }
  const json = strFromU8(inflated);
  if (!json.trim()) throw new Error(tActive('error.share.cardEmpty'));
  return json;
}

// 容量判定：界面据此决定「给二维码」还是「只给复制/分享图片」。
export function planShareCode(code) {
  const text = String(code || '');
  const chars = text.length;
  const fits = chars > 0 && chars <= QR_MAX_CODE_CHARS;
  return {
    code: text,
    chars,
    fitsQr: fits,
    // 还差多少字符才装得下（fitsQr 时为 0），供提示文案使用
    overBy: fits ? 0 : Math.max(0, chars - QR_MAX_CODE_CHARS),
    limit: QR_MAX_CODE_CHARS,
  };
}
