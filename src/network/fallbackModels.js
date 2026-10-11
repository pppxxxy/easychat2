// P0-7：模型降级链（fallback models）——纯判定层。
//
// 目标：主模型「429 / 5xx / 超时 / 网络不可达」时，按用户配的顺序自动换下一个模型重试；
// 其余失败（401 密钥错、404 模型名错、参数错）**不换**——那是确定性失败，换模型只是
// 把同一个错误再犯一遍，还会白花额度。
//
// 为什么判定层单独一个模块：它必须能在 Node 里直测（不需要网络、不需要 RN）。
// 判定依赖**结构化字段**（api.js 在失败时挂的 httpStatus / timeout / network），
// 而不是错误文案——文案会随语言与措辞改动漂移，拿它当判据早晚出错；
// 文案匹配只作为兜底（老版本错误对象、第三方抛出的错误）。
//
// 与「自动压缩」「记忆总结」的关系：无。降级链只影响**这一次请求用哪个模型**，
// 不改会话内容、不写记忆。

export const FALLBACK_MODELS_MAX = 3;
export const FALLBACK_MODEL_NAME_MAX = 120;

// 归一化：接受数组或逗号/空格/换行分隔的字符串；去空、去重、保序、限量。
export function normalizeFallbackModels(raw) {
  const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(/[\s,，;；]+/);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = String(item === undefined || item === null ? '' : item).trim().slice(0, FALLBACK_MODEL_NAME_MAX);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= FALLBACK_MODELS_MAX) break;
  }
  return out;
}

// 可降级失败：429（限流）、5xx（服务端）、超时、网络不可达。
// 明确**不**降级：401/403（密钥/权限）、404（模型名或路径错）、400/422（参数错）、
// 用户中断（AbortError——那是用户的意图，不是失败）。
export function isRetryableFailure(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.canceled === true) return false;
  const status = Number(error.httpStatus);
  if (Number.isFinite(status) && status > 0) return status === 429 || status >= 500;
  if (error.timeout === true) return true;
  if (error.network === true) return true;
  // 兜底：结构化字段缺失时（老错误对象 / 第三方错误）才看文案。
  const message = String(error.message || '');
  if (/HTTP\s*429\b/.test(message)) return true;
  if (/HTTP\s*5\d\d\b/.test(message)) return true;
  if (/超时|timed? ?out/i.test(message)) return true;
  return false;
}

// 尝试顺序：主模型在前，其后是去重后的降级模型（与主模型同名的不重复试）。
export function planFallbackChain({ model, fallbackModels } = {}) {
  const primary = String(model === undefined || model === null ? '' : model).trim();
  const rest = normalizeFallbackModels(fallbackModels).filter(name => name !== primary);
  return primary ? [primary, ...rest] : rest;
}

// 是否应该降级：失败可降级 **且** 这一轮还没有内容产出。
// 「已产出」是硬条件——流式已经吐了半句话再换模型重来，用户会看到两段拼接的回复，
// 那比直接报错更糟。调用方负责把「是否已产出」如实传进来。
export function shouldFallback({ error, emitted = false, attempted = 0, chainLength = 0 } = {}) {
  if (emitted) return false;
  if (!isRetryableFailure(error)) return false;
  const used = Math.max(0, Math.floor(Number(attempted) || 0));
  const total = Math.max(0, Math.floor(Number(chainLength) || 0));
  return used + 1 < total;
}
