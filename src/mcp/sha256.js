// 紧凑纯 JS SHA-256（PKCE S256 用；Node 直测对齐 node:crypto 向量）。
// 项目里没有现成哈希实现（本地模型校验只用大小比对），expo-crypto 未安装，
// 为零新增原生依赖自实现。输入输出按字节，调用方自行编码。

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

export function sha256Bytes(bytes) {
  const input = Array.isArray(bytes) || bytes instanceof Uint8Array ? Array.from(bytes) : [];
  const bitLength = input.length * 8;
  input.push(0x80);
  while (input.length % 64 !== 56) input.push(0);
  for (let i = 7; i >= 0; i -= 1) input.push(Math.floor(bitLength / 2 ** (8 * i)) & 0xff);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let offset = 0; offset < input.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const j = offset + t * 4;
      w[t] = ((input[j] << 24) | (input[j + 1] << 16) | (input[j + 2] << 8) | input[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[t] + w[t]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const done = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] + done[i]) >>> 0;
  }
  const out = [];
  for (let i = 0; i < 8; i += 1) {
    out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff);
  }
  return out;
}

export function sha256Ascii(text) {
  const string = String(text || '');
  const bytes = [];
  for (let i = 0; i < string.length; i += 1) {
    const code = string.charCodeAt(i);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return sha256Bytes(bytes);
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // 与 workspace/docx.js 同一兜底链：Buffer（Node/测试）→ globalThis.btoa。
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const encode = globalThis.btoa;
  if (typeof encode !== 'function') throw new Error('base64 encoder unavailable');
  return encode(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE：verifier 允许字符集为 BASE64URL 扩展（含 -._~），长度 43-128。
function xorshift(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

export function createPkcePair({ randomSource } = {}) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const fromBytes = bytes => {
    let verifier = '';
    for (let i = 0; i < 64; i += 1) verifier += alphabet[bytes[i] % alphabet.length];
    return { verifier, challenge: bytesToBase64Url(sha256Ascii(verifier)) };
  };
  if (randomSource) {
    // 注入源（测试/上层定制）：把源字符串折成种子走确定性 PRNG。
    const seedString = String(randomSource());
    let seed = 2166136261;
    for (let i = 0; i < seedString.length; i += 1) {
      seed ^= seedString.charCodeAt(i);
      seed = Math.imul(seed, 16777619) >>> 0;
    }
    const next = xorshift(seed);
    const bytes = Array.from({ length: 64 }, () => Math.floor(next() * 256) % 256);
    return fromBytes(bytes);
  }
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(64);
    globalThis.crypto.getRandomValues(bytes);
    return fromBytes(bytes);
  }
  // 退化熵源：RN 老版本没有 crypto.getRandomValues 时兜底。PKCE 仍能绑定
  // 授权码与本次会话，只是熵低于密码学理想值；个人设备场景下可接受。
  const next = xorshift((Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0);
  const bytes = Array.from({ length: 64 }, () => Math.floor(next() * 256) % 256);
  return fromBytes(bytes);
}
