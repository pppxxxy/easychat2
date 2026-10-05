// OAuth 网页认证流 + PKCE/sha256 测试（全部注入 fetch / 浏览器回调，Node 直测）。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { sha256Ascii, bytesToBase64Url, createPkcePair } from '../src/mcp/sha256.js';
import {
  discoverOAuthMetadata,
  exchangeCodeForTokens,
  parseCallbackUrl,
  registerOAuthClient,
  runOAuthWebFlow,
} from '../src/mcp/oauth.js';

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

test('discoverOAuthMetadata：受保护资源元数据 → 授权服务器元数据', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('oauth-protected-resource')) {
      return okJson({ authorization_servers: ['https://auth.example'] });
    }
    if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
      return okJson({
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register',
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const metadata = await discoverOAuthMetadata({ serverUrl: 'https://mcp.example/mcp/', fetchImpl });
  assert.equal(metadata.authorizationEndpoint, 'https://auth.example/authorize');
  assert.equal(metadata.tokenEndpoint, 'https://auth.example/token');
  assert.equal(metadata.registrationEndpoint, 'https://auth.example/register');
});

test('discoverOAuthMetadata：资源元数据缺失时直接退回 RFC 8414', async () => {
  const fetchImpl = async url => {
    if (url === 'https://mcp.example/.well-known/oauth-authorization-server/mcp') {
      return okJson({ authorization_endpoint: 'https://mcp.example/authorize', token_endpoint: 'https://mcp.example/token' });
    }
    throw new Error('404');
  };
  const metadata = await discoverOAuthMetadata({ serverUrl: 'https://mcp.example/mcp/', fetchImpl });
  assert.equal(metadata.tokenEndpoint, 'https://mcp.example/token');
});

function okJson(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
}

test('parseCallbackUrl：state 不匹配与拒绝都必须拦下', () => {
  const parsed = parseCallbackUrl('easychat2://github-mcp-callback?code=abc&state=s1', { expectedState: 's1' });
  assert.equal(parsed.code, 'abc');
  assert.throws(
    () => parseCallbackUrl('easychat2://github-mcp-callback?code=abc&state=evil', { expectedState: 's1' }),
    error => error.code === 'OAUTH_STATE_MISMATCH'
  );
  assert.throws(
    () => parseCallbackUrl('easychat2://github-mcp-callback?error=access_denied', { expectedState: 's1' }),
    error => error.code === 'OAUTH_ACCESS_DENIED'
  );
});

test('runOAuthWebFlow：发现→注册→授权 URL→回调→换令牌 全链路', async () => {
  let authorizeUrl = '';
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('oauth-protected-resource')) {
      return okJson({ authorization_servers: ['https://auth.example'] });
    }
    if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
      return okJson({
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register',
      });
    }
    if (url === 'https://auth.example/register') {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.redirect_uris, ['easychat2://github-mcp-callback']);
      assert.equal(payload.token_endpoint_auth_method, 'none');
      return okJson({ client_id: 'client-123' });
    }
    if (url === 'https://auth.example/token') {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('client_id'), 'client-123');
      assert.equal(params.get('code'), 'the-code');
      assert.ok(params.get('code_verifier').length >= 43, 'PKCE verifier 必须随令牌请求回传');
      return okJson({ access_token: 'at-1', refresh_token: 'rt-1', scope: 'repo' });
    }
    throw new Error(`unexpected ${url}`);
  };
  const tokens = await runOAuthWebFlow({
    serverUrl: 'https://mcp.example/mcp/',
    redirectUri: 'easychat2://github-mcp-callback',
    fetchImpl,
    openBrowser: async url => { authorizeUrl = url; },
    awaitCallback: async () => {
      const state = new globalThis.URL(authorizeUrl).searchParams.get('state');
      return `easychat2://github-mcp-callback?code=the-code&state=${state}`;
    },
  });
  assert.equal(tokens.accessToken, 'at-1');
  assert.equal(tokens.refreshToken, 'rt-1');
  const url = new globalThis.URL(authorizeUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'easychat2://github-mcp-callback');
});

test('registerOAuthClient：注册失败返回 null（由上层提示改用令牌）', async () => {
  const none = await registerOAuthClient({
    registrationEndpoint: 'https://x/register',
    redirectUri: 'easychat2://github-mcp-callback',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  assert.equal(none, null);
  const noEndpoint = await registerOAuthClient({ registrationEndpoint: '', redirectUri: 'x', fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(noEndpoint, null);
});

test('exchangeCodeForTokens：失败带稳定 code', async () => {
  await assert.rejects(
    () => exchangeCodeForTokens({
      tokenEndpoint: 'https://auth.example/token',
      clientId: 'c',
      code: 'x',
      verifier: 'v',
      redirectUri: 'r',
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad_verification_code' }) }),
    }),
    error => error.code === 'OAUTH_TOKEN_EXCHANGE'
  );
});
