export const VECTOR_PROVIDERS = [
  {
    id: 'openai-embeddings',
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    endpoint: '/embeddings',
    model: 'text-embedding-3-small',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
    timeoutMs: 30000,
    batchSize: 16,
  },
];

export const DEFAULT_VECTOR_PROVIDER = VECTOR_PROVIDERS[0];

export function getVectorProvider(id) {
  return VECTOR_PROVIDERS.find(item => item.id === id) || DEFAULT_VECTOR_PROVIDER;
}

export function buildEmbeddingUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  const provider = DEFAULT_VECTOR_PROVIDER;
  if (!trimmed) return '';
  if (/\/embeddings$/i.test(trimmed)) return trimmed;
  return `${trimmed}${provider.endpoint}`;
}

export function mapEmbeddingError(status) {
  if (status === 401 || status === 403) return '密钥无效或未授权';
  if (status === 429) return '请求过于频繁，请稍后重试';
  return `向量服务请求失败（HTTP ${status}）`;
}
