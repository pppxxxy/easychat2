const SEARCH_TIMEOUT_MS = 10000;

function xhrRequest({ url, headers }) {
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
    xhr.open('GET', url);
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
      xhr.send();
    } catch (error) {
      finish(reject, error);
    }
  });
}

function buildRequest(provider, config, query, maxResults) {
  const encoded = encodeURIComponent(query);
  if (provider === 'google-cse') {
    return {
      url: `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(config.apiKey)}&cx=${encodeURIComponent(config.cx)}&q=${encoded}&num=${maxResults}`,
      headers: {},
    };
  }
  if (provider === 'bing') {
    return {
      url: `https://api.bing.microsoft.com/v7.0/search?q=${encoded}&count=${maxResults}&mkt=zh-CN`,
      headers: { 'Ocp-Apim-Subscription-Key': config.apiKey },
    };
  }
  if (provider === 'custom') {
    const base = String(config.customBaseUrl || '').trim();
    const join = base.includes('?') ? '&' : '?';
    return {
      url: `${base}${join}q=${encoded}&limit=${maxResults}`,
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    };
  }
  return {
    url: `https://serpapi.com/search?engine=google&q=${encoded}&num=${maxResults}&api_key=${encodeURIComponent(config.apiKey)}`,
    headers: {},
  };
}

function parseResults(provider, data) {
  let raw = [];
  if (provider === 'google-cse') raw = data.items || [];
  else if (provider === 'bing') raw = (data.webPages && data.webPages.value) || [];
  else if (provider === 'custom') raw = data.results || data.items || data.data || [];
  else raw = data.organic_results || [];
  return raw
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      title: String(item.title || item.name || '').trim(),
      link: String(item.link || item.url || item.displayLink || '').trim(),
      snippet: String(item.snippet || item.description || item.summary || '').trim(),
    }))
    .filter(item => item.title || item.link || item.snippet);
}

export async function runWebSearch({ query, config, maxResults }) {
  const text = String(query || '').trim().slice(0, 200);
  if (!text) return [];
  const source = config || {};
  const provider = source.provider;
  const limit = Math.min(Math.max(1, Math.trunc(Number(maxResults) || Number(source.maxResults) || 5)), 10);
  if (provider === 'custom') {
    if (!String(source.customBaseUrl || '').trim()) return [];
  } else if (!String(source.apiKey || '').trim()) {
    return [];
  }
  if (provider === 'google-cse' && !String(source.cx || '').trim()) return [];
  const request = buildRequest(provider, source, text, limit);
  const data = await xhrRequest(request);
  return parseResults(provider, data).slice(0, limit);
}
