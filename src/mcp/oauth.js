// GitHub MCP 网页认证流（OAuth 2.0 授权码 + PKCE + 动态客户端注册）。
// 纯逻辑 + 注入 fetch / 打开浏览器回调，Node 直测；RN 侧由调用方提供
// 「打开系统浏览器」与「捕获回调 URL」两个能力（Linking 实现，见 oauthBridge.js）。
//
// 流程（MCP 授权规范 2025-06-18，对 GitHub 远程 MCP 的适配）：
//   1. 发现授权服务器元数据：先试受保护资源元数据（oauth-protected-resource，
//      取 authorization_servers[0]），再退到 oauth-authorization-server（RFC 8414）；
//   2. 动态客户端注册（RFC 7591）：公共客户端（无 secret），grant 含 refresh_token；
//   3. 打开浏览器到 authorization_endpoint（response_type=code + S256 PKCE + state）；
//   4. 回调带 code → token 端点换 access_token/refresh_token。
// 任一步失败都抛带步骤名的错误（提示用户改用令牌方式连接）。

import { createPkcePair } from './sha256.js';

const DISCOVERY_TIMEOUT_MS = 15000;

// 错误统一带稳定 code：用户可读文案由设置页按 code 映射 t()，本模块零 i18n 依赖。
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const URLImpl = typeof globalThis !== 'undefined' ? globalThis.URL : undefined;

async function fetchJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    throw fail('OAUTH_HTTP_ERROR', `HTTP ${response.status} (${url})`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw fail('OAUTH_BAD_JSON', `non-JSON response: ${url}`);
  }
}

function originOf(url) {
  return new URLImpl(url).origin;
}

function pathOf(url) {
  return new URLImpl(url).pathname;
}

// 返回 { authorizationEndpoint, tokenEndpoint, registrationEndpoint } 或抛错。
export async function discoverOAuthMetadata({ serverUrl, fetchImpl, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw fail('OAUTH_NO_FETCH', 'fetch is unavailable in this environment');
  const init = { headers: { Accept: 'application/json' } };
  void timeoutMs;

  // 1) 受保护资源元数据（路径相关）
  const resourceUrl = `${originOf(serverUrl)}/.well-known/oauth-protected-resource${pathOf(serverUrl).replace(/\/$/, '')}`;
  try {
    const resource = await fetchJson(resourceUrl, init, fetchImpl);
    const authorizationServer = Array.isArray(resource.authorization_servers) && resource.authorization_servers[0];
    if (authorizationServer) {
      const asMetadataUrl = `${authorizationServer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
      const metadata = await fetchJson(asMetadataUrl, init, fetchImpl);
      if (metadata.authorization_endpoint && metadata.token_endpoint) {
        return {
          authorizationEndpoint: metadata.authorization_endpoint,
          tokenEndpoint: metadata.token_endpoint,
          registrationEndpoint: metadata.registration_endpoint || '',
          authorizationServer,
        };
      }
    }
  } catch (error) { /* 走下一步 */ }

  // 2) 直接把服务端 origin 当授权服务器（RFC 8414，带路径变体先行）
  for (const metadataUrl of [
    `${originOf(serverUrl)}/.well-known/oauth-authorization-server${pathOf(serverUrl).replace(/\/$/, '')}`,
    `${originOf(serverUrl)}/.well-known/oauth-authorization-server`,
  ]) {
    try {
      const metadata = await fetchJson(metadataUrl, init, fetchImpl);
      if (metadata.authorization_endpoint && metadata.token_endpoint) {
        return {
          authorizationEndpoint: metadata.authorization_endpoint,
          tokenEndpoint: metadata.token_endpoint,
          registrationEndpoint: metadata.registration_endpoint || '',
          authorizationServer: originOf(serverUrl),
        };
      }
    } catch (error) { /* 试下一个 */ }
  }
  throw fail('OAUTH_METADATA_NOT_FOUND', 'oauth authorization-server metadata not found; use a personal access token instead.');
}

// 动态注册公共客户端；服务端不支持时返回 null（调用方可退回固定 client_id）。
export async function registerOAuthClient({ registrationEndpoint, redirectUri, fetchImpl, clientName = 'EasyChat2 工作区' } = {}) {
  if (!registrationEndpoint) return null;
  const response = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || !payload.client_id) return null;
  return { clientId: payload.client_id };
}

export function buildAuthorizeUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  codeChallenge,
  state,
  scope = 'repo read:user',
  resource,
} = {}) {
  const url = new URLImpl(String(authorizationEndpoint));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', String(clientId || ''));
  url.searchParams.set('redirect_uri', String(redirectUri || ''));
  url.searchParams.set('code_challenge', String(codeChallenge || ''));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', String(state || ''));
  if (scope) url.searchParams.set('scope', scope);
  if (resource) url.searchParams.set('resource', resource);
  return url.toString();
}

// 从回调 URL 解析 code / state / error（用户在授权页拒绝时 error=access_denied）。
export function parseCallbackUrl(callbackUrl, { expectedState } = {}) {
  let url;
  try {
    url = new URLImpl(String(callbackUrl || ''));
  } catch (error) {
    throw fail('OAUTH_CALLBACK_PARSE', 'callback url is unparseable.');
  }
  if (url.searchParams.get('error')) {
    throw fail('OAUTH_ACCESS_DENIED', `authorization failed: ${url.searchParams.get('error')}`);
  }
  const code = url.searchParams.get('code');
  if (!code) throw fail('OAUTH_NO_CODE', 'callback is missing the authorization code.');
  if (expectedState && url.searchParams.get('state') !== expectedState) {
    throw fail('OAUTH_STATE_MISMATCH', 'state mismatch; callback untrusted (possible CSRF).');
  }
  return { code };
}

export async function exchangeCodeForTokens({
  tokenEndpoint,
  clientId,
  code,
  verifier,
  redirectUri,
  fetchImpl,
} = {}) {
  const response = await fetchImpl(String(tokenEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: String(clientId || ''),
      code: String(code || ''),
      code_verifier: String(verifier || ''),
      redirect_uri: String(redirectUri || ''),
    }).toString(),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !payload.access_token) {
    throw fail('OAUTH_TOKEN_EXCHANGE', `token exchange failed: ${(payload && payload.error) || `HTTP ${response.status}`}`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || '',
    scope: payload.scope || '',
  };
}

export async function refreshAccessToken({
  tokenEndpoint,
  clientId,
  refreshToken,
  fetchImpl,
} = {}) {
  const response = await fetchImpl(String(tokenEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: String(clientId || ''),
      refresh_token: String(refreshToken || ''),
    }).toString(),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !payload.access_token) {
    throw fail('OAUTH_REFRESH_FAILED', `token refresh failed: ${(payload && payload.error) || `HTTP ${response.status}`}`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || String(refreshToken || ''),
  };
}

// 一步编排：发现 → 注册 → 生成授权 URL。浏览器打开与回调捕获由调用方
// 通过 openBrowser / awaitCallback 两个注入点完成（RN 里是 Linking + 监听）。
export async function runOAuthWebFlow({
  serverUrl,
  redirectUri,
  fetchImpl,
  openBrowser,
  awaitCallback,
  scope,
  resource,
  randomSource,
} = {}) {
  const metadata = await discoverOAuthMetadata({ serverUrl, fetchImpl });
  const { verifier, challenge } = createPkcePair({ randomSource });
  const state = `ec2-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let clientId = '';
  const registration = await registerOAuthClient({
    registrationEndpoint: metadata.registrationEndpoint,
    redirectUri,
    fetchImpl,
  }).catch(() => null);
  if (registration && registration.clientId) {
    clientId = registration.clientId;
  } else {
    throw fail('OAUTH_NO_REGISTRATION', 'server does not support dynamic client registration; use a personal access token instead.');
  }
  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: metadata.authorizationEndpoint,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state,
    scope,
    resource,
  });
  if (typeof openBrowser !== 'function') throw fail('OAUTH_NO_BROWSER', 'no browser opener provided.');
  await openBrowser(authorizeUrl);
  if (typeof awaitCallback !== 'function') throw fail('OAUTH_NO_AWAIT', 'no callback catcher provided.');
  const callbackUrl = await awaitCallback();
  const { code } = parseCallbackUrl(callbackUrl, { expectedState: state });
  const tokens = await exchangeCodeForTokens({
    tokenEndpoint: metadata.tokenEndpoint,
    clientId,
    code,
    verifier,
    redirectUri,
    fetchImpl,
  });
  return { ...tokens, clientId };
}
