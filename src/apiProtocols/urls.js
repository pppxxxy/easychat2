// 各协议的端点 URL 归一与鉴权请求头构造。纯函数。

import { joinUrlQuery, splitUrlQuery } from '../utils/urlQuery.js';

// 与 normalizeChatUrl 同口径：可填根地址、带 /v1，或直接带端点的完整地址。
//
// 后缀判定必须只看「路径」部分（先例：src/vectorMemory/providers.js:41-48）。
// 本函数是**所有在线请求的唯一收口**（network/api.js:295）+ 主动消息
// （proactive/proactiveRequest.js:112），此前三条分支的 /\/messages$/、
// /\/responses$/、/\/chat\/completions$/ 都作用在含 query 的整串上：
//   https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-02-01
// 整串做后缀判定必然不中（结尾是 api-version），于是端点被再追加一次，拼成
//   .../chat/completions?api-version=2024-02-01/v1/chat/completions → 404，
// 而用户只看到通用失败文案。故先按第一个 '?' 拆出 path / query，判后缀用 path，
// 回拼时把 query 原样接回（与 providers.js 的做法一字不差，只是抽成了公共函数）。
export function normalizeProtocolUrl(protocol, baseUrl) {
  const trimmed = String(baseUrl || '').trim();
  const { path, query } = splitUrlQuery(trimmed);
  const base = path || 'https://api.openai.com';
  const withQuery = url => joinUrlQuery(url, query);
  if (protocol === 'anthropic') {
    if (/\/messages$/i.test(base)) return withQuery(base);
    if (/\/v1$/i.test(base)) return withQuery(`${base}/messages`);
    return withQuery(`${base}/v1/messages`);
  }
  if (protocol === 'openai-responses') {
    if (/\/responses$/i.test(base)) return withQuery(base);
    if (/\/v1$/i.test(base)) return withQuery(`${base}/responses`);
    return withQuery(`${base}/v1/responses`);
  }
  if (/\/chat\/completions$/i.test(base)) return withQuery(base);
  if (/\/v1$/i.test(base)) return withQuery(`${base}/chat/completions`);
  return withQuery(`${base}/v1/chat/completions`);
}

// 鉴权头：沿用 config.authHeader/authScheme，未配置时按协议给默认值
// （OpenAI 系 Authorization: Bearer；Anthropic 系 x-api-key）。
//
// v5 修复 F2：OpenRouter 推荐带 HTTP-Referer / X-Title 用于排行榜归属（可选）。
// 仅当 baseUrl 命中 openrouter.ai 时附加，不影响其它厂商请求头。
export function buildRequestHeaders(protocol, config, { stream = true } = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const headers = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
  const defaultHeader = protocol === 'anthropic' ? 'x-api-key' : 'Authorization';
  const header = String(source.authHeader || defaultHeader) || defaultHeader;
  const scheme = source.authScheme === undefined || source.authScheme === null
    ? (protocol === 'anthropic' ? '' : 'Bearer ')
    : String(source.authScheme);
  headers[header] = `${scheme}${String(source.apiKey || '')}`;
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = String(source.anthropicVersion || '2023-06-01');
  }
  if (/openrouter\.ai/i.test(String(source.baseUrl || ''))) {
    // 可选归属头：缺失不影响调用，服务端不会因此拒绝请求。
    if (!headers['HTTP-Referer']) headers['HTTP-Referer'] = 'https://github.com/pppxxxy/easychat2';
    if (!headers['X-Title']) headers['X-Title'] = 'EasyChat2';
  }
  return headers;
}
