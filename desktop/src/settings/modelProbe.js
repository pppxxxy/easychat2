// 模型清单探测（设计同 SettingsScreen 的 fetchProviderModels，但拆成可测纯逻辑 + 一层请求）。
//
// URL 口径必须与共享层 src/network/api.js 的 normalizeChatUrl 一致：设置页探的是
// `<base>/models`，`<base>` 是「去掉 /chat/completions 后的地址」；若 base 已带 /v1
// 就不再补 /v1，否则补上。两处不一致的后果是「检测通过但聊天 404」。
//
// 注意：这里**刻意不 import api.js**——它会经 storage 拖进 `expo-file-system/legacy`，
// 使这个纯逻辑模块在 Node 测试里加载失败。用零依赖的 urlQuery 叶子手写同口径，
// 一致性由 tests/settings/modelProbe.test.mjs 钉住（并用 api.js 的同名函数比对）。
import { joinUrlQuery, splitUrlQuery } from '../../../src/utils/urlQuery.js';
import { normalizeProtocol } from '../../../src/apiProtocols/constants.js';
import vendorXhr from '../../../src/network/vendorHttp.js';

// 与 api.js:normalizeChatUrl 同口径（见上）。
export function normalizeChatEndpoint(baseUrl) {
  const { path, query } = splitUrlQuery(String(baseUrl || '').trim());
  const base = path || 'https://api.deepseek.com';
  if (/\/chat\/completions$/i.test(base)) return joinUrlQuery(base, query);
  if (/\/v1$/i.test(base)) return joinUrlQuery(`${base}/chat/completions`, query);
  return joinUrlQuery(`${base}/v1/chat/completions`, query);
}

// 纯函数：给出候选模型清单地址（先去 base，再回退另一种形态）。
export function modelListUrls(baseUrl) {
  const chatUrl = normalizeChatEndpoint(String(baseUrl || '').trim());
  const base = chatUrl.replace(/\/chat\/completions$/i, '');
  const fallback = /\/v1$/i.test(base) ? base.replace(/\/v1$/i, '') : `${base}/v1`;
  const urls = [`${base}/models`, `${fallback}/models`];
  return [...new Set(urls)];
}

// 纯函数：从 /models 响应里取模型名（按首次出现去重、忽略空值）。
export function parseModelList(payload) {
  const list = payload && Array.isArray(payload.data) ? payload.data : [];
  const names = list.map(item => String((item && item.id) || '').trim()).filter(Boolean);
  return [...new Set(names)];
}

// 探测鉴权头：与聊天请求同口径（Anthropic 用 x-api-key + anthropic-version）。
// 匿名配置不发鉴权头（Kilo Gateway 这类网关收到假 key 会 401，不发才是匿名）。
export function probeHeaders(config) {
  const protocol = normalizeProtocol(config && config.protocol);
  const header = String((config && config.authHeader) || (protocol === 'anthropic' ? 'x-api-key' : 'Authorization'));
  const scheme = config && config.authScheme !== undefined
    ? String(config.authScheme)
    : (protocol === 'anthropic' ? '' : 'Bearer ');
  const headers = {};
  if (!(config && config.anonymous === true)) {
    headers[header] = `${scheme}${String((config && config.apiKey) || '').trim()}`;
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return headers;
}

// 拉取模型清单：两个候选地址依次尝试，任一成功即返回；全部失败抛最后一个错误
// （调用方按 error.code 分流文案）。isCurrent 供竞态校验（请求返回时配置已变）。
export async function detectModels(config, { t, isCurrent = () => true, cancelHandle = null, timeoutMs = 15000 } = {}) {
  const translate = typeof t === 'function' ? t : key => key;
  const urls = modelListUrls(config && config.baseUrl);
  const headers = probeHeaders(config);
  let lastError = null;
  for (const url of urls) {
    if (!isCurrent()) return [];
    try {
      const text = await vendorXhr({
        method: 'GET',
        url,
        headers,
        timeoutMs,
        nativeTimeout: true,
        cancelHandle,
        onTimeoutError: () => {
          const error = new Error(translate('settings.api.err.timeout'));
          error.code = 'timeout';
          return error;
        },
        onAbortError: () => {
          const error = new Error(translate('settings.api.err.cancelled'));
          error.code = 'cancelled';
          return error;
        },
        onCancelError: () => {
          const error = new Error(translate('settings.api.err.cancelled'));
          error.code = 'cancelled';
          return error;
        },
        onNetworkError: () => {
          const error = new Error(translate('settings.api.err.network'));
          error.code = 'network';
          return error;
        },
        onHttpError: () => {
          const error = new Error(translate('settings.api.err.request'));
          error.code = 'http';
          return error;
        },
        parse: xhr => xhr.responseText,
        onParseError: () => {
          const error = new Error(translate('settings.api.err.request'));
          error.code = 'http';
          return error;
        },
      });
      if (!isCurrent()) return [];
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        lastError = Object.assign(new Error(translate('settings.api.err.request')), { code: 'http' });
        continue;
      }
      const models = parseModelList(payload);
      if (models.length > 0) return models;
      lastError = Object.assign(new Error(translate('settings.api.noModelsDetected.body')), { code: 'empty' });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || Object.assign(new Error(translate('settings.api.err.request')), { code: 'http' });
}