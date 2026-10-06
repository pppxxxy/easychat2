// 各协议错误载荷 → 可读错误文本。纯函数。

export function parseProtocolError(protocol, payload) {
  if (!payload || typeof payload !== 'object') return '';
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  return '';
}
