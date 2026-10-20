import {
  buildEmbeddingUrl,
  DEFAULT_VECTOR_PROVIDER,
  getVectorProvider,
  mapEmbeddingError,
} from './providers.js';
// 数值边界与默认值只有一处定义（limits.js）：此前 16/30000 在 providers.js 与这里各一份，
// 上限 20/2000/64 与默认 5/400/16 又在这里与 storage/vector.js 各一份。手抄两份的下场是
// 「设置页夹取用的上限」与「发请求时用的上限」可以悄悄不是同一个数。
// 做法照 src/memory/memoryConstants.js（无依赖常量模块，供多层共用）。
import {
  VECTOR_BATCH_SIZE_DEFAULT,
  VECTOR_BATCH_SIZE_MAX,
  VECTOR_MAX_CHARS_DEFAULT,
  VECTOR_MAX_CHARS_MAX,
  VECTOR_TIMEOUT_MS_DEFAULT,
  VECTOR_TOP_K_DEFAULT,
  VECTOR_TOP_K_MAX,
} from './limits.js';
import { registerSecretValues } from '../storage/secrets.js';
import vendorXhr from '../network/vendorHttp.js';
import { tActive } from '../i18n/index.js';

// 下面两条只在本文件使用（全仓单份引用），留在原地——为单份引用再抽一层间接没有收益。
const DEFAULT_MAX_TOTAL_CHARS = 1200;
// 相关性门槛：余弦相似度低于此值的片段不注入。0.2 以下基本是噪声，
// 但保留 keywordRetrieve 兜底（关键词命中天然高置信），故只过滤向量路径。
const DEFAULT_MIN_SCORE = 0.2;

export function normalizeVectorConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // providerId **原样保留**用户存下的值，不再用 provider.id 改写：它是 vectorSignature 的
  // 成员（见下面的 vectorSignature），把「本版本不认识的 id」静默换成默认 id 会立刻改变
  // 指纹 ⇒ indexMessages 把**全部**存量分段判成指纹不符而重新嵌入（等于把历史消息整体再
  // 发给向量服务），该次请求失败时还会以 vector: [] 覆盖旧向量。
  // 查不到目录时只影响「形状」的兜底（批大小/超时/鉴权），**不影响身份**；
  // getVectorProvider 对未知 id 返回 null（fail-closed，见 providers.js）。
  const requestedProviderId = String(source.providerId || DEFAULT_VECTOR_PROVIDER.id);
  const provider = getVectorProvider(requestedProviderId);
  const topK = Math.trunc(Number(source.topK));
  const maxChars = Math.trunc(Number(source.maxChars));
  const batchSize = Math.trunc(Number(source.batchSize));
  return {
    enabled: source.enabled === true,
    providerId: requestedProviderId,
    // 空地址/空模型一律原样保留，**不**用 provider 的默认值兜底：向量 provider 在 UI 上
    // 不可选，兜底等于替用户凭空指定一个第三方目的地。此前这里回填 api.openai.com 后，
    // 用户清空「接口地址」再发消息，聊天正文与他填过的别家 Key 会被 POST 到他从未配置过的
    // 服务；配合 storage/vector.js 里同样一份手抄兜底，设置页输入框还会「自己长回地址」。
    // 缺失由 embedTexts 的守卫报错（照 src/network/api.js:281-286 的先例）。
    baseUrl: String(source.baseUrl || ''),
    apiKey: String(source.apiKey || ''),
    model: String(source.model || ''),
    topK: Number.isFinite(topK) && topK > 0 ? Math.min(VECTOR_TOP_K_MAX, topK) : VECTOR_TOP_K_DEFAULT,
    maxChars: Number.isFinite(maxChars) && maxChars > 0
      ? Math.min(VECTOR_MAX_CHARS_MAX, maxChars)
      : VECTOR_MAX_CHARS_DEFAULT,
    batchSize: Number.isFinite(batchSize) && batchSize > 0
      ? Math.min(VECTOR_BATCH_SIZE_MAX, batchSize)
      // provider 可能为 null（未知 id）：此时只回退到本文件的默认值，不臆造 provider 的值。
      : ((provider && provider.batchSize) || VECTOR_BATCH_SIZE_DEFAULT),
    timeoutMs: (provider && provider.timeoutMs) || VECTOR_TIMEOUT_MS_DEFAULT,
  };
}

export function vectorSignature(raw) {
  const resolved = normalizeVectorConfig(raw);
  return [
    resolved.providerId,
    resolved.baseUrl,
    resolved.model,
    String(resolved.maxChars),
  ].join('\u0000');
}

export function chunkMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : VECTOR_MAX_CHARS_DEFAULT;
  const segments = [];
  list.forEach((message, messageIndex) => {
    if (!message) return;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return;
    const text = String(message.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const base = role === 'user' ? '用户' : (String(message.speakerName || '').trim() || '角色');
    // 消息没有 id（历史遗留数据）时用序号兜底：否则所有分片 id 都会退化成
    // msg-<start>，被 indexMessages 的去重逻辑判为“已索引”而永久不入库。
    const messageKey = message.id || `msg-${messageIndex}`;
    for (let start = 0; start < text.length; start += maxChars) {
      const slice = text.slice(start, start + maxChars).trim();
      if (!slice) continue;
      segments.push({
        id: `${messageKey}-${start}`,
        // 与 id 用同一兜底：否则无 id 的历史消息 messageId 恒为空，删除时
        // （removeVectorIndexForMessages 会 filter(Boolean) 掉空 id）永远清不掉，成为残留记忆。
        messageId: String(message.id || `msg-${messageIndex}`),
        sessionId: String(options.sessionId || ''),
        role,
        at: Number(message.timestamp) || 0,
        text: `${base}：${slice}`,
      });
    }
  });
  return segments;
}

function createVectorAbortError() {
  // 用户主动取消：canceled=true 让调用方静默处理（不弹错误提示）。
  const error = new Error(tActive('error.vectorMemory.aborted'));
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

function xhrPostJson({ url, headers, body, timeoutMs, signal = null }) {
  return vendorXhr({
    method: 'POST',
    url,
    headers,
    body: JSON.stringify(body),
    signal,
    timeoutMs,
    defaultTimeoutMs: VECTOR_TIMEOUT_MS_DEFAULT,
    onTimeoutError: () => new Error(tActive('error.vectorMemory.timeout')),
    onAbortError: () => createVectorAbortError(),
    onAbortEventError: () => new Error(tActive('error.vectorMemory.aborted')),
    onNetworkError: () => new Error(tActive('error.vectorMemory.networkFailed')),
    onHttpError: status => new Error(mapEmbeddingError(status)),
    parse: xhr => JSON.parse(xhr.responseText || '{}'),
    onParseError: () => new Error(tActive('error.vectorMemory.unparseableResponse')),
  });
}

function extractVectors(data, expected) {
  const rows = data && Array.isArray(data.data) ? data.data : [];
  if (rows.length !== expected) throw new Error(tActive('error.vectorMemory.countMismatch'));
  return rows
    .map(row => (Array.isArray(row && row.embedding) ? row.embedding.map(Number) : null))
    .map(vec => (vec && vec.every(Number.isFinite) ? vec : null))
    .map(vec => {
      if (!vec) throw new Error(tActive('error.vectorMemory.invalidVector'));
      return vec;
    });
}

export async function embedTexts({ config, texts, signal = null }) {
  // 空地址守卫必须落在**归一化之前、用原始值**：normalizeVectorConfig 此前会把空 baseUrl
  // 静默回填成 provider 默认地址（api.openai.com），归一化之后再判空永远判不出空——
  // 守卫因此恒不可达，error.vectorMemory.baseUrlRequired 成了死词条。
  // 照 src/network/api.js:281-286 的先例（apiKey 与 baseUrl 都在归一化之前用原始值守卫）。
  if (!String((config && config.baseUrl) || '').trim()) {
    throw new Error(tActive('error.vectorMemory.baseUrlRequired'));
  }
  const resolved = normalizeVectorConfig(config);
  // 登记向量服务密钥：报错文本可能带出裸 Key
  registerSecretValues([resolved.apiKey]);
  // 端点后缀与下面的 auth 取**同一个** provider（providerId 一并传入），避免半应用状态。
  const url = buildEmbeddingUrl(resolved.baseUrl, resolved.providerId);
  if (!/^https?:\/\/[^/\s]+/i.test(url)) {
    throw new Error(tActive('error.vectorMemory.invalidBaseUrl'));
  }
  if (!resolved.apiKey) throw new Error(tActive('error.vectorMemory.apiKeyRequired'));
  const list = (Array.isArray(texts) ? texts : []).map(text => String(text || ''));
  if (list.length === 0) return [];
  if (signal && signal.aborted) throw createVectorAbortError();
  if (!resolved.model) throw new Error(tActive('error.vectorMemory.modelRequired'));
  const provider = getVectorProvider(resolved.providerId);
  // 未知 providerId（getVectorProvider fail-closed 返回 null）：鉴权形状未知 ⇒ **绝不猜**，
  // 直接不发请求。放在这里而不是 normalizeVectorConfig：归一化是纯函数，被 vectorSignature
  // 等只读调用方共用，在那里抛错会连带炸掉指纹计算。
  // 注意 providerId 已在 normalizeVectorConfig 里原样保留，所以指纹不因「不认识」而变化，
  // 不会触发全量重嵌入；这里只是把「无法确定怎么鉴权」如实报出来。
  if (!provider) {
    throw new Error(tActive('vectorProvider.unknownProvider', { id: resolved.providerId }));
  }
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
      signal,
      body: { model: resolved.model, input: batch },
    });
    vectors.push(...extractVectors(data, batch.length));
  }
  return vectors;
}

export function cosineSimilarity(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length === 0 || left.length !== right.length) return 0;
  const length = left.length;
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
  const limit = Number.isFinite(topK) && topK > 0 ? topK : VECTOR_TOP_K_DEFAULT;
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

// 纯函数：按余弦相似度取命中，过滤低于门槛与指纹不匹配的片段。便于单测。
export function selectVectorHits(list, queryVector, { signature = '', topK, minScore } = {}) {
  const threshold = Number.isFinite(minScore) && minScore >= 0 ? minScore : DEFAULT_MIN_SCORE;
  const limit = Number.isFinite(topK) && topK > 0 ? topK : VECTOR_TOP_K_DEFAULT;
  return (Array.isArray(list) ? list : [])
    .filter(item => (
      item
      && Array.isArray(item.vector)
      && item.vector.length > 0
      && (!signature || item.signature === signature)
    ))
    .map(item => ({ item, score: cosineSimilarity(queryVector, item.vector) }))
    // 低于门槛的不算命中：弱相关片段注入只会挤占预算并干扰模型。
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.item);
}

export async function retrieve({ config, index, query, topK, minScore, signal = null }) {
  const resolved = normalizeVectorConfig(config);
  const list = Array.isArray(index) ? index : [];
  const limit = Number.isFinite(topK) && topK > 0 ? topK : resolved.topK;
  if (list.length === 0) return [];
  // 开关必须真的「关」：关闭时不降级到关键词检索，直接不召回。
  // （此前关闭会退回 keywordRetrieve——中文单字 token 命中形同虚设，任何提问都会
  // 把旧对话当「相关记忆」注进 system，见 2026-10-05 审核报告。）
  if (!resolved.enabled) return [];
  try {
    const [queryVector] = await embedTexts({ config: resolved, texts: [query], signal });
    const hits = selectVectorHits(list, queryVector, {
      signature: vectorSignature(resolved),
      topK: limit,
      minScore,
    });
    if (hits.length === 0) return keywordRetrieve({ index: list, query, topK: limit });
    return hits;
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
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
    const remaining = maxTotal - total;
    if (remaining <= 0) break;
    const value = text.length > remaining ? text.slice(0, remaining) : text;
    if (!value) break;
    lines.push(`- ${value}`);
    total += value.length;
  }
  if (lines.length === 0) return '';
  return `[相关记忆]\n${lines.join('\n')}`;
}

export async function indexMessages({ messages, config, existing, sessionId = '', signal = null }) {
  const resolved = normalizeVectorConfig(config);
  const segments = chunkMessages(messages, { maxChars: resolved.maxChars, sessionId });
  const current = Array.isArray(existing) ? existing : [];
  const segmentKey = item => `${String(item && item.sessionId || '')}\u0000${String(item && item.id || '')}`;
  const byId = new Map(current.map(item => [segmentKey(item), item]));
  const added = segments.filter(segment => !byId.has(segmentKey(segment)));
  const signature = vectorSignature(resolved);

  // 写入侧同样设闸：开关关闭时不新增分段（此前只不带向量地照写，存量会被
  // 关键词模式持续召回——同上，见 2026-10-05 审核报告）。
  if (!resolved.enabled) {
    return current;
  }

  const emptyVectors = current.filter(item => (
    item
    && item.text
    && (
      !Array.isArray(item.vector)
      || item.vector.length === 0
      || item.signature !== signature
    )
  ));
  const pending = [...emptyVectors, ...added];
  if (pending.length === 0) return current;
  try {
    const vectors = await embedTexts({
      config: resolved,
      texts: pending.map(segment => segment.text),
      signal,
    });
    const embedded = pending.map((segment, index) => ({
      ...segment,
      signature,
      vector: vectors[index] || [],
    }));
    const embeddedById = new Map(embedded.map(item => [segmentKey(item), item]));
    const merged = current.map(item => embeddedById.get(segmentKey(item)) || item);
    const fresh = added.map(segment => embeddedById.get(segmentKey(segment)) || { ...segment, signature, vector: [] });
    // 引用契约（见 vector.js updateVectorIndex 的注释与守卫）：
    // 「内容没变时返回同一个数组引用」是**性能契约**——返回新引用会让调用方
    // 白做一次 O(条数×维度) 的序列化与整键写盘。
    // 这里必须逐项判定：只有真的换了内容（新分段、或向量/签名被更新）才返回新数组。
    const next = [...merged, ...fresh];
    return sameIndexContent(next, current) ? current : next;
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    // ⚠️ 这里曾无条件 `return [...current, ...added.map(...)]`（真机日志 2026-10-20 抓到）：
    // embedTexts 失败（网络/超时）且**没有新消息**时，added 为空 ⇒ 等价于 `[...current]`，
    // 即「新引用 + 内容完全相同」⇒ 触发引用契约诊断，且每次落盘白做一次序列化。
    // 现在：没有新增就原样返回 current（失败时什么都没变，本就不该写盘）。
    if (added.length === 0) return current;
    return [...current, ...added.map(segment => ({ ...segment, signature, vector: [] }))];
  }
}

// 判断两份索引的**内容**是否等价（只比对象字段，不比引用）。
// 用于「内容没变就别返回新引用」的判定；保守实现：任何拿不准都当作「变了」，
// 因为漏报一次退化只是少省一次写盘，而误判成「没变」会丢改动。
function sameIndexContent(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    // 分段身份
    const lkey = `${String(left.sessionId || '')}\u0000${String(left.id || '')}`;
    const rkey = `${String(right.sessionId || '')}\u0000${String(right.id || '')}`;
    if (lkey !== rkey) return false;
    // 签名与向量长度：变了就必须写盘
    if (String(left.signature || '') !== String(right.signature || '')) return false;
    const lv = Array.isArray(left.vector) ? left.vector : [];
    const rv = Array.isArray(right.vector) ? right.vector : [];
    if (lv.length !== rv.length) return false;
    for (let k = 0; k < lv.length; k += 1) {
      if (lv[k] !== rv[k]) return false;
    }
    // 其余元数据（text/dim/mergedFrom…）也决定落盘内容，用 JSON 比一次（字段都小）。
    const { vector: _lv, ...lrest } = left;
    const { vector: _rv, ...rrest } = right;
    if (JSON.stringify(lrest) !== JSON.stringify(rrest)) return false;
  }
  return true;
}

export async function testVectorConnection(config) {
  const resolved = normalizeVectorConfig(config);
  const [vector] = await embedTexts({ config: resolved, texts: ['连接测试'] });
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(tActive('error.vectorMemory.noValidVector'));
  }
  return vector.length;
}
