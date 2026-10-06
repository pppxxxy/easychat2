// 各协议的端点 URL 归一与鉴权请求头构造。纯函数。

// 与 normalizeChatUrl 同口径：可填根地址、带 /v1，或直接带端点的完整地址。
export function normalizeProtocolUrl(protocol, baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  const base = trimmed || 'https://api.openai.com';
  if (protocol === 'anthropic') {
    if (/\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (protocol === 'openai-responses') {
    if (/\/responses$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/responses`;
    return `${base}/v1/responses`;
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// 鉴权头：沿用 config.authHeader/authScheme，未配置时按协议给默认值
// （OpenAI 系 Authorization: Bearer；Anthropic 系 x-api-key）。
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
  return headers;
}
