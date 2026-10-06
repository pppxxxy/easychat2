// 协议常量与归一：三协议 id 与常见别名。纯函数。

export const API_PROTOCOLS = ['openai', 'openai-responses', 'anthropic'];

export function normalizeProtocol(value) {
  if (value === 'anthropic') return 'anthropic';
  if (value === 'openai-responses' || value === 'responses') return 'openai-responses';
  return 'openai';
}

export function isKnownProtocol(value) {
  return API_PROTOCOLS.includes(normalizeProtocol(value));
}
