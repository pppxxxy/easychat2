// mcp/sha256.js 测试（紧凑纯 JS SHA-256；PKCE S256 与图片识别正文摘要共用）。
//
// 本文件原先还测 mcp/oauth.js 的「GitHub MCP 网页授权流」（发现元数据 → 动态注册 →
// 浏览器授权 → 回调换令牌）。那条链在生产侧零引用——设置页早已改走「打开令牌页 +
// PAT」两条稳定路径（GitHub 远程 MCP 不提供 RFC 7591 的 /register，网页授权必然
// 在注册一步失败），故 oauth.js / oauthBridge.js 与对应用例一并随死代码清理删除。
// sha256.js 本身**不是死代码**：sha256Ascii / bytesToBase64Url 被
// src/imageRecognition/index.js 用于正文摘要，故本文件保留。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { sha256Ascii, bytesToBase64Url, createPkcePair } from '../src/mcp/sha256.js';

function toHex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

test('sha256Ascii 与 node:crypto 对齐', () => {
  assert.equal(toHex(sha256Ascii('abc')), crypto.createHash('sha256').update('abc').digest('hex'));
  assert.equal(
    toHex(sha256Ascii('easychat2-中文-123')),
    crypto.createHash('sha256').update('easychat2-中文-123', 'utf8').digest('hex'),
    '中文按 UTF-8 编码'
  );
});

test('bytesToBase64Url：URL 安全字母表、无填充', () => {
  const b64 = bytesToBase64Url(crypto.createHash('sha256').update('abc').digest());
  assert.ok(!/[+/=]/.test(b64));
  assert.equal(Buffer.from(b64, 'base64url').toString('hex'), crypto.createHash('sha256').update('abc').digest('hex'));
});

test('createPkcePair：verifier 合法长度与字符集，S256 挑战可复算', () => {
  const { verifier, challenge } = createPkcePair({ randomSource: () => 'seed-1' });
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.ok(/^[A-Za-z0-9\-._~]+$/.test(verifier));
  const expected = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  assert.equal(challenge, expected);
  // 同一种子确定性；不同种子不同值。
  assert.equal(createPkcePair({ randomSource: () => 'seed-1' }).verifier, verifier);
  assert.notEqual(createPkcePair({ randomSource: () => 'seed-2' }).verifier, verifier);
});
