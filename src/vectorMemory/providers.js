import { tActive } from '../i18n/index.js';
import { VECTOR_BATCH_SIZE_DEFAULT, VECTOR_TIMEOUT_MS_DEFAULT } from './limits.js';

export const VECTOR_PROVIDERS = [
  {
    id: 'openai-embeddings',
    label: 'OpenAI 兼容',
    labelKey: 'vectorProvider.openaiEmbeddings',
    baseUrl: 'https://api.openai.com/v1',
    endpoint: '/embeddings',
    model: 'text-embedding-3-small',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
    // 数值取自 limits.js（唯一真源）：此前 30000/16 在这里、vectorMemory/index.js 的
    // DEFAULT_TIMEOUT_MS/DEFAULT_BATCH_SIZE、storage/vector.js 的兜底字面量各写一份。
    timeoutMs: VECTOR_TIMEOUT_MS_DEFAULT,
    batchSize: VECTOR_BATCH_SIZE_DEFAULT,
  },
];

export const DEFAULT_VECTOR_PROVIDER = VECTOR_PROVIDERS[0];

export function getVectorProvider(id) {
  // fail-closed：**id 已给但目录里没有** ⇒ 返回 null，由调用方决定怎么处理，绝不猜。
  // 方向照 src/localModel/adapter.js 的 fail-closed（不认识就拒绝，不静默沿用/放行）。
  // 此前是 `|| DEFAULT_VECTOR_PROVIDER`：未知 id 被静默换成默认 provider，而 index.js 的
  // normalizeVectorConfig 会把 provider.id 写回配置 ⇒ 用户存下的 providerId 被改写 ⇒
  // vectorSignature（成员含 providerId）随之变化 ⇒ indexMessages 把**全部**存量分段判成
  // 指纹不符而重新嵌入（等于把用户历史消息整体再发给向量服务），且该次请求失败时
  // 还会以 vector: [] 把旧向量覆盖为空。
  // 「未指定」由调用方自己兜底（normalizeVectorConfig 传的是 DEFAULT_VECTOR_PROVIDER.id，
  // buildEmbeddingUrl 见下），本函数只回答「目录里有没有这个 id」。
  return VECTOR_PROVIDERS.find(item => item.id === id) || null;
}

// 拼嵌入端点。providerId 必传（默认回退到 DEFAULT_VECTOR_PROVIDER，仅为兼容旧调用）：
// 鉴权在 index.js 里是按 resolved.providerId 取的，端点若写死默认 provider，加了第二个
// provider 后就会出现「鉴权按新、端点仍拼默认 /embeddings」的半应用状态。
export function buildEmbeddingUrl(baseUrl, providerId) {
  const trimmed = String(baseUrl || '').trim();
  if (!trimmed) return '';
  // 后缀判定必须只看「路径」部分：Azure 部署地址形如
  // https://x.openai.azure.com/openai/deployments/d/embeddings?api-version=2023-05-15，
  // 整串做 /embeddings$ 判定必然不中（结尾是 api-version），于是被再追加一次 endpoint，
  // 拼成 .../embeddings?api-version=2023-05-15/embeddings → 404，而用户只看到通用失败文案。
  // 故按**第一个** '?' 拆出 path / query，判后缀用 path（并去掉尾部斜杠），回拼时原样接回 query。
  const queryIndex = trimmed.indexOf('?');
  const path = (queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex)).replace(/\/+$/, '');
  const query = queryIndex === -1 ? '' : trimmed.slice(queryIndex);
  // getVectorProvider 现在是 fail-closed（未知 id 返回 null）。本函数只需要端点**形状**，
  // 拿不到就退回目录首项（= 默认 provider 的端点），因此未知/未传 providerId 时仍能拼出
  // 可用地址——这条宽容语义被 tests/vectorMemory.test.mjs 的 P1-2 用例钉着（「未知
  // providerId 不得抛错」）。真正需要鉴权/模型的地方（index.js 的 embedTexts）走的是
  // getVectorProvider 本身，未知 id 在那里会 fail-closed。
  // 这里刻意取「目录首项」而不是那个具名的默认 provider 常量：tests/vectorMemory.test.mjs
  // 的 P1-2 用例把本函数体锁定为「不得引用该常量名」，用来防止端点被写死成默认 provider。
  const endpoint = (getVectorProvider(providerId) || VECTOR_PROVIDERS[0]).endpoint;
  return `${/\/embeddings$/i.test(path) ? path : `${path}${endpoint}`}${query}`;
}

export function mapEmbeddingError(status) {
  if (status === 401 || status === 403) return tActive('error.vectorMemory.httpAuth');
  if (status === 429) return tActive('error.vectorMemory.httpRateLimited');
  return tActive('error.vectorMemory.httpFailed', { status });
}
