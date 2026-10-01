export const PROVIDERS = [
  {
    id: 'serpapi',
    label: 'SerpAPI',
    keyLinks: [{ label: '获取 SerpAPI Key', url: 'https://serpapi.com/manage-api-key' }],
    baseUrl: 'https://serpapi.com/search',
    method: 'GET',
    authType: 'query',
    authKeyName: 'api_key',
    queryParam: 'q',
    limitParam: 'num',
    extra: { engine: 'google' },
    resultsPath: 'organic_results',
    fields: { title: 'title', url: 'link', snippet: 'snippet' },
    secretFields: ['apiKey'],
  },
  {
    id: 'google-cse',
    label: 'Google CSE',
    keyLinks: [
      { label: '获取 API Key（凭据）', url: 'https://console.cloud.google.com/apis/credentials' },
      { label: '创建搜索引擎（cx）', url: 'https://programmablesearchengine.google.com/' },
    ],
    baseUrl: 'https://www.googleapis.com/customsearch/v1',
    method: 'GET',
    authType: 'query',
    authKeyName: 'key',
    queryParam: 'q',
    limitParam: 'num',
    extra: {},
    extraFields: ['cx'],
    resultsPath: 'items',
    fields: { title: 'title', url: 'link', snippet: 'snippet' },
    secretFields: ['apiKey'],
  },
  {
    id: 'brave',
    label: 'Brave Search',
    keyLinks: [{ label: '获取 Brave Search Key', url: 'https://api.search.brave.com/app/keys' }],
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
    method: 'GET',
    authType: 'header',
    authKeyName: 'X-Subscription-Token',
    queryParam: 'q',
    limitParam: 'count',
    extra: {},
    resultsPath: 'web.results',
    fields: { title: 'title', url: 'url', snippet: 'description' },
    secretFields: ['apiKey'],
  },
  {
    id: 'tavily',
    label: 'Tavily',
    keyLinks: [{ label: '获取 Tavily Key', url: 'https://app.tavily.com/home' }],
    baseUrl: 'https://api.tavily.com/search',
    method: 'POST',
    authType: 'body',
    authKeyName: 'api_key',
    queryParam: 'query',
    limitParam: 'max_results',
    extra: {},
    resultsPath: 'results',
    fields: { title: 'title', url: 'url', snippet: 'content' },
    secretFields: ['apiKey'],
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    method: 'GET',
    authType: 'header',
    authKeyName: 'Authorization',
    authPrefix: 'Bearer ',
    queryParam: 'q',
    limitParam: 'limit',
    extra: {},
    resultsPath: 'results',
    fields: { title: 'title', url: 'url', snippet: 'snippet' },
    secretFields: ['apiKey'],
    custom: true,
  },
];

export function getProvider(id) {
  return PROVIDERS.find(provider => provider.id === id) || PROVIDERS[0];
}

// 判断某供应商配置缺少哪些必填项，返回缺失字段名数组（空数组=配置完整）。
// 面板「开启联网搜索」前的拦截与 webSearch 执行前的短路共用同一判定，
// 避免两处规则漂移（此前各写一份 if 链）。
export function missingRequiredFields(provider, config) {
  const source = config && typeof config === 'object' ? config : {};
  const target = provider || PROVIDERS[0];
  const missing = [];
  if (target.custom && !String(source.customBaseUrl || '').trim()) {
    missing.push('customBaseUrl');
  }
  if ((target.secretFields || []).includes('apiKey') && !String(source.apiKey || '').trim()) {
    missing.push('apiKey');
  }
  if ((target.extraFields || []).includes('cx') && !String(source.cx || '').trim()) {
    missing.push('cx');
  }
  return missing;
}
