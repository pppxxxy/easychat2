// AnySearch 两档共用同一 REST 接口，只有鉴权与密钥入口不同：
// 匿名档（默认）不发送 Authorization 头，走官方按 IP 限速的免费额度；
// 密钥档发送 Bearer，走密钥上的付费额度。
const ANYSEARCH_API = {
  baseUrl: 'https://api.anysearch.com/v1/search',
  method: 'POST',
  authType: 'header',
  authKeyName: 'Authorization',
  authPrefix: 'Bearer ',
  queryParam: 'query',
  limitParam: 'max_results',
  extra: {},
  // 结果包在响应信封 data.results 里（{ code, message, request_id, data: { results } }）
  resultsPath: 'data.results',
  fields: { title: 'title', url: 'url', snippet: 'snippet' },
};

export const PROVIDERS = [
  {
    id: 'anysearch',
    label: 'AnySearch Free',
    labelKey: 'plugin.provider.anysearchFree',
    noteKey: 'plugin.note.anysearchFree',
    keyLinks: [],
    // 不要求密钥：无 Authorization 头即匿名额度，是新建配置的默认提供方
    secretFields: [],
    ...ANYSEARCH_API,
  },
  {
    id: 'anysearch-key',
    label: 'AnySearch Key',
    labelKey: 'plugin.provider.anysearchKey',
    keyLinks: [{ label: '获取 AnySearch Key', labelKey: 'plugin.keyLink.anysearch', url: 'https://anysearch.com/console/api-keys' }],
    secretFields: ['apiKey'],
    ...ANYSEARCH_API,
  },
  {
    id: 'serpapi',
    label: 'SerpAPI',
    keyLinks: [{ label: '获取 SerpAPI Key', labelKey: 'plugin.keyLink.serpapi', url: 'https://serpapi.com/manage-api-key' }],
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
      { label: '获取 API Key（凭据）', labelKey: 'plugin.keyLink.googleApiKey', url: 'https://console.cloud.google.com/apis/credentials' },
      { label: '创建搜索引擎（cx）', labelKey: 'plugin.keyLink.googleCx', url: 'https://programmablesearchengine.google.com/' },
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
    keyLinks: [{ label: '获取 Brave Search Key', labelKey: 'plugin.keyLink.brave', url: 'https://api.search.brave.com/app/keys' }],
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
    keyLinks: [{ label: '获取 Tavily Key', labelKey: 'plugin.keyLink.tavily', url: 'https://app.tavily.com/home' }],
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
    labelKey: 'plugin.provider.custom',
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

// 未知 / 空 id 回退到首个提供方（AnySearch 匿名档：不需要密钥，永远可用）。
export function getProvider(id) {
  return PROVIDERS.find(provider => provider.id === id) || PROVIDERS[0];
}

// 判断某供应商配置缺少哪些必填项，返回缺失字段名数组（空数组=配置完整）。
// 面板「开启联网搜索」前的拦截与 webSearch 执行前的短路共用同一判定，
// 避免两处规则漂移（此前各写一份 if 链）。secretFields 为空的提供方
// （AnySearch 匿名档）不要求密钥，因此恒返回空数组。
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
