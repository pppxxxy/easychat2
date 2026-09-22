import { getProvider } from './providers';
import { registerSecretValues } from '../secrets';

const SEARCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 60000;
const CACHE_MAX_ENTRIES = 50;
const MAX_RETRIES = 1;
const RATE_LIMIT_PER_MINUTE = 20;

const cache = new Map();
const callTimes = [];

// 模块级缓存必须有过期回收：只判 TTL 而不删除，会让进程常驻大量历史结果。
function pruneCache(now) {
  cache.forEach((entry, key) => {
    if (!entry || now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  });
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const entries = Array.from(cache.entries()).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  entries.slice(0, entries.length - CACHE_MAX_ENTRIES).forEach(([key]) => cache.delete(key));
}

export function getByPath(source, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, source);
}

function isRateLimited(now) {
  while (callTimes.length && now - callTimes[0] > 60000) callTimes.shift();
  return callTimes.length >= RATE_LIMIT_PER_MINUTE;
}

function cacheKey(providerId, query, limit) {
  return `${providerId}::${query}::${limit}`;
}

function xhrRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        xhr.abort();
      } catch (error) {}
      reject(new Error('搜索超时'));
    }, SEARCH_TIMEOUT_MS);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    xhr.open(method || 'GET', url);
    Object.entries(headers || {}).forEach(([key, value]) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch (error) {}
    });
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(reject, new Error(`搜索失败（HTTP ${xhr.status}）`));
        return;
      }
      try {
        finish(resolve, JSON.parse(xhr.responseText || '{}'));
      } catch (error) {
        finish(reject, new Error('搜索返回无法解析'));
      }
    };
    xhr.onerror = () => finish(reject, new Error('搜索网络请求失败'));
    xhr.onabort = () => finish(reject, new Error('搜索已中断'));
    try {
      xhr.send(body || null);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function buildRequest(provider, config, query, limit) {
  const base = provider.custom
    ? String(config.customBaseUrl || '').trim()
    : provider.baseUrl;
  if (!base) return null;
  const params = { ...(provider.extra || {}) };
  (provider.extraFields || []).forEach(field => {
    if (config[field] !== undefined && config[field] !== '') {
      params[field] = config[field];
    }
  });
  params[provider.queryParam] = query;
  params[provider.limitParam] = limit;
  const headers = {};
  const apiKey = String(config.apiKey || '').trim();
  let bodyParams = null;
  if (provider.authType === 'query') {
    params[provider.authKeyName] = apiKey;
  } else if (provider.authType === 'body') {
    bodyParams = { ...params, [provider.authKeyName]: apiKey };
  } else {
    headers[provider.authKeyName] = `${provider.authPrefix || ''}${apiKey}`;
  }
  const queryString = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  if (provider.method === 'POST') {
    return {
      method: 'POST',
      url: base,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyParams || params),
    };
  }
  const join = base.includes('?') ? '&' : '?';
  return {
    method: 'GET',
    url: `${base}${join}${queryString}`,
    headers,
    body: null,
  };
}

export function parseResults(provider, data, limit) {
  const raw = getByPath(data, provider.resultsPath);
  const list = Array.isArray(raw) ? raw : [];
  const fields = provider.fields || {};
  return list
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      title: String(getByPath(item, fields.title) || '').trim(),
      url: String(getByPath(item, fields.url) || '').trim(),
      snippet: String(getByPath(item, fields.snippet) || '').trim(),
    }))
    .filter(item => item.title || item.url || item.snippet)
    .slice(0, limit);
}

export async function runWebSearch({ query, config, maxResults }) {
  const text = String(query || '').trim().slice(0, 200);
  if (!text) return [];
  const source = config || {};
  // 登记搜索密钥：报错文本可能带出裸 Key
  registerSecretValues([source.apiKey]);
  const provider = getProvider(source.provider);
  const limit = Math.min(
    Math.max(1, Math.trunc(Number(maxResults) || Number(source.maxResults) || 5)),
    10
  );
  if (provider.custom) {
    if (!String(source.customBaseUrl || '').trim()) return [];
  }
  const requiresKey = (provider.secretFields || []).includes('apiKey');
  if (requiresKey && !String(source.apiKey || '').trim()) return [];
  if ((provider.extraFields || []).includes('cx') && !String(source.cx || '').trim()) {
    return [];
  }

  const key = cacheKey(provider.id, text, limit);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.results;
  if (cached) cache.delete(key);
  pruneCache(now);
  if (isRateLimited(now)) return [];

  const request = buildRequest(provider, source, text, limit);
  if (!request) return [];

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const data = await xhrRequest(request);
      const results = parseResults(provider, data, limit);
      callTimes.push(Date.now());
      cache.set(key, { at: Date.now(), results });
      return results;
    } catch (error) {
      lastError = error;
      // 4xx 是确定性失败（密钥/权限/配额），重试没有意义，还会触发风控
      if (error && /HTTP 4\d\d/.test(error.message || '')) {
        callTimes.push(Date.now());
        throw error;
      }
    }
  }
  // 失败的尝试也计入限流，避免配置错误时反复冲击服务商
  callTimes.push(Date.now());
  throw lastError || new Error('搜索失败');
}
