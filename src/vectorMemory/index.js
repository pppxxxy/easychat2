import {
  buildEmbeddingUrl,
  DEFAULT_VECTOR_PROVIDER,
  getVectorProvider,
  mapEmbeddingError,
} from './providers';

const DEFAULT_MAX_CHARS = 400;
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_TOTAL_CHARS = 1200;

export function normalizeVectorConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const provider = getVectorProvider(source.providerId || DEFAULT_VECTOR_PROVIDER.id);
  const topK = Math.trunc(Number(source.topK));
  const maxChars = Math.trunc(Number(source.maxChars));
  const batchSize = Math.trunc(Number(source.batchSize));
  return {
    enabled: source.enabled === true,
    providerId: provider.id,
    baseUrl: String(source.baseUrl || provider.baseUrl || ''),
    apiKey: String(source.apiKey || ''),
    model: String(source.model || provider.model || ''),
    topK: Number.isFinite(topK) && topK > 0 ? Math.min(20, topK) : DEFAULT_TOP_K,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.min(2000, maxChars) : DEFAULT_MAX_CHARS,
    batchSize: Number.isFinite(batchSize) && batchSize > 0
      ? Math.min(64, batchSize)
      : (provider.batchSize || DEFAULT_BATCH_SIZE),
    timeoutMs: provider.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
}

export function chunkMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DEFAULT_MAX_CHARS;
  const segments = [];
  list.forEach(message => {
    if (!message) return;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return;
    const text = String(message.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const base = role === 'user' ? '用户' : (String(message.speakerName || '').trim() || '角色');
    for (let start = 0; start < text.length; start += maxChars) {
      const slice = text.slice(start, start + maxChars).trim();
      if (!slice) continue;
      segments.push({
        id: `${message.id || 'msg'}-${start}`,
        messageId: String(message.id || ''),
        role,
        at: Number(message.timestamp) || 0,
        text: `${base}：${slice}`,
      });
    }
  });
  return segments;
}

function xhrPostJson({ url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        xhr.abort();
      } catch (error) {}
      reject(new Error('向量请求超时'));
    }, timeoutMs || DEFAULT_TIMEOUT_MS);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    xhr.open('POST', url);
    Object.entries(headers || {}).forEach(([key, value]) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch (error) {}
    });
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(reject, new Error(mapEmbeddingError(xhr.status)));
        return;
      }
      try {
        finish(resolve, JSON.parse(xhr.responseText || '{}'));
      } catch (error) {
        finish(reject, new Error('向量服务返回无法解析'));
      }
    };
    xhr.onerror = () => finish(reject, new Error('向量服务网络请求失败'));
    xhr.onabort = () => finish(reject, new Error('向量请求已中断'));
    try {
      xhr.send(JSON.stringify(body));
    } catch (error) {
      finish(reject, error);
    }
  });
}

function extractVectors(data, expected) {
  const rows = data && Array.isArray(data.data) ? data.data : [];
  if (rows.length !== expected) throw new Error('向量数量与文本数量不一致');
  return rows
    .map(row => (Array.isArray(row && row.embedding) ? row.embedding.map(Number) : null))
    .map(vec => (vec && vec.every(Number.isFinite) ? vec : null))
    .map(vec => {
      if (!vec) throw new Error('向量格式无效');
      return vec;
    });
}

export async function embedTexts({ config, texts }) {
  const resolved = normalizeVectorConfig(config);
  const url = buildEmbeddingUrl(resolved.baseUrl);
  if (!url) throw new Error('请先填写向量服务地址');
  if (!resolved.apiKey) throw new Error('请先填写向量服务密钥');
  const list = (Array.isArray(texts) ? texts : []).map(text => String(text || ''));
  if (list.length === 0) return [];
  if (!resolved.model) throw new Error('请先填写向量模型');
  const provider = getVectorProvider(resolved.providerId);
  const headers = { 'Content-Type': 'application/json' };
  if (provider.auth && provider.auth.type === 'header') {
    headers[provider.auth.keyName] = `${provider.auth.prefix || ''}${resolved.apiKey}`;
  }
  const vectors = [];
  for (let start = 0; start < list.length; start += resolved.batchSize) {
    const batch = list.slice(start, start + resolved.batchSize);
    const data = await xhrPostJson({
      url,
      headers,
      timeoutMs: resolved.timeoutMs,
      body: { model: resolved.model, input: batch },
    });
    vectors.push(...extractVectors(data, batch.length));
  }
  return vectors;
}

export function cosineSimilarity(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const x = Number(left[index]) || 0;
    const y = Number(right[index]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenize(text) {
  const source = String(text || '').toLowerCase();
  const tokens = [];
  const words = source.match(/[a-z0-9_]+/g);
  if (words) tokens.push(...words);
  const han = source.match(/[\u4e00-\u9fff]/g);
  if (han) {
    for (let index = 0; index < han.length; index += 1) {
      tokens.push(han[index]);
      if (index + 1 < han.length) tokens.push(han[index] + han[index + 1]);
    }
  }
  return tokens;
}

export function keywordRetrieve({ index, query, topK }) {
  const list = Array.isArray(index) ? index : [];
  const tokens = Array.from(new Set(tokenize(query)));
  if (tokens.length === 0 || list.length === 0) return [];
  const limit = Number.isFinite(topK) && topK > 0 ? topK : DEFAULT_TOP_K;
  const scored = [];
  list.forEach(item => {
    const text = String((item && item.text) || '');
    if (!text) return;
    const lower = text.toLowerCase();
    let score = 0;
    tokens.forEach(token => {
      if (lower.includes(token)) score += token.length;
    });
    if (score > 0) scored.push({ item, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(entry => entry.item);
}

export async function retrieve({ config, index, query, topK }) {
  const resolved = normalizeVectorConfig(config);
  const list = Array.isArray(index) ? index : [];
  const limit = Number.isFinite(topK) && topK > 0 ? topK : resolved.topK;
  if (list.length === 0) return [];
  if (!resolved.enabled) return keywordRetrieve({ index: list, query, topK: limit });
  try {
    const [queryVector] = await embedTexts({ config: resolved, texts: [query] });
    const scored = list
      .filter(item => item && Array.isArray(item.vector) && item.vector.length > 0)
      .map(item => ({ item, score: cosineSimilarity(queryVector, item.vector) }));
    if (scored.length === 0) return keywordRetrieve({ index: list, query, topK: limit });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(entry => entry.item);
  } catch (error) {
    return keywordRetrieve({ index: list, query, topK: limit });
  }
}

export function buildMemoryContext(snippets, options = {}) {
  const list = (Array.isArray(snippets) ? snippets : [])
    .map(item => String((item && item.text) || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (list.length === 0) return '';
  const maxTotal = Number.isFinite(options.maxTotalChars) && options.maxTotalChars > 0
    ? options.maxTotalChars
    : DEFAULT_MAX_TOTAL_CHARS;
  const lines = [];
  let total = 0;
  for (const text of list) {
    if (total + text.length > maxTotal && lines.length > 0) break;
    lines.push(`- ${text}`);
    total += text.length;
  }
  if (lines.length === 0) return '';
  return `[相关记忆]\n${lines.join('\n')}`;
}

export async function indexMessages({ characterId, messages, config, existing }) {
  const resolved = normalizeVectorConfig(config);
  const segments = chunkMessages(messages, { maxChars: resolved.maxChars });
  const current = Array.isArray(existing) ? existing : [];
  const byId = new Map(current.map(item => [item && item.id, item]));
  const added = segments.filter(segment => !byId.has(segment.id));

  if (!resolved.enabled) {
    return [...current, ...added.map(segment => ({ ...segment, vector: [] }))];
  }

  const emptyVectors = current.filter(item => (
    item && item.text && (!Array.isArray(item.vector) || item.vector.length === 0)
  ));
  const pending = [...emptyVectors, ...added];
  if (pending.length === 0) return current;
  try {
    const vectors = await embedTexts({
      config: resolved,
      texts: pending.map(segment => segment.text),
    });
    const embedded = pending.map((segment, index) => ({
      ...segment,
      vector: vectors[index] || [],
    }));
    const embeddedById = new Map(embedded.map(item => [item.id, item]));
    const merged = current.map(item => embeddedById.get(item.id) || item);
    const fresh = added.map(segment => embeddedById.get(segment.id) || { ...segment, vector: [] });
    return [...merged, ...fresh];
  } catch (error) {
    return [...current, ...added.map(segment => ({ ...segment, vector: [] }))];
  }
}

export async function testVectorConnection(config) {
  const resolved = normalizeVectorConfig(config);
  const [vector] = await embedTexts({ config: resolved, texts: ['连接测试'] });
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('未返回有效向量');
  }
  return vector.length;
}

export const VECTOR_DEFAULTS = {
  topK: DEFAULT_TOP_K,
  maxChars: DEFAULT_MAX_CHARS,
  maxTotalChars: DEFAULT_MAX_TOTAL_CHARS,
};
