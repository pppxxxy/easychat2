// 各协议错误载荷 → 可读错误文本。纯函数。
//
// v5 修复 F1：OpenRouter 等聚合上游把真凶放在 error.metadata.raw（HTTP 200 的 SSE
// 流内 error 事件），只读 error.message 会只剩一句 "Provider returned error"。
// 这里把 message + metadata.raw + metadata.provider_name 一并拼进错误文本（截断 500
// 字符防刷屏），让用户直接看到上游原始参数错误，而不是无从排查的笼统提示。
//
// 2026-10-17：本模块的 parseProtocolError 是**非流式路径的唯一失败判定入口**
//（api.js:738 在 parseFinalPayload 之前调用），所以协议级失败状态在这里兜最省。
import { tActive } from '../i18n/index.js';

const MAX_ERROR_CHARS = 500;

function truncateErrorText(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return '';
  return value.length > MAX_ERROR_CHARS ? `${value.slice(0, MAX_ERROR_CHARS)}…` : value;
}

// 从任意错误载荷里抽取可读文本；payload 可为 { error } 或 error 对象本身。
export function describeErrorPayload(error) {
  if (!error) return '';
  if (typeof error === 'string') return truncateErrorText(error);
  if (typeof error !== 'object') return '';

  const parts = [];
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  if (message) parts.push(message);

  const metadata = error.metadata && typeof error.metadata === 'object' && !Array.isArray(error.metadata)
    ? error.metadata
    : null;
  if (metadata) {
    // metadata.raw 是 OpenRouter 透传的上游原始错误（写明参数名/原因），信息量最大。
    const raw = typeof metadata.raw === 'string' ? metadata.raw.trim() : '';
    if (raw && raw !== message) parts.push(raw);
    const provider = typeof metadata.provider_name === 'string' ? metadata.provider_name.trim() : '';
    if (provider && !parts.some(part => part.includes(provider))) parts.push(`上游：${provider}`);
  }

  // code 字段常见于部分聚合服务（如 invalid_request_error 之外的细分类）。
  if (!parts.length && typeof error.code === 'string' && error.code.trim()) parts.push(error.code.trim());
  return truncateErrorText(parts.join('\n'));
}

export function parseProtocolError(protocol, payload) {
  if (!payload || typeof payload !== 'object') return '';
  const error = payload.error;
  const described = describeErrorPayload(error);
  if (described) return described;
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return truncateErrorText(payload.message);
  }
  // Responses API 的 status==='failed'：**明确报失败**，即使它没给出可读原因也必须算失败。
  // 否则这种体（error 为 null/缺失/空对象）会一路走到 finalResponses，被当成
  // text:'' + finishReason:'stop' 的**正常空回复**呈现（竞品警示 #6：GLM 系「只思考不说
  // 话」被当成功；本仓对应缺口）。conversation/ChatScreen 的非流式路径正是靠本函数
  // 在 api.js:738 先拦一道，所以在这里而不是 final.js 兜底 = 零成本覆盖全部非流式调用方。
  // 有可读原因时上面已经返回（保留原文）；这里只兜「报了 failed 却没写原因」。
  if (payload.status === 'failed') return tActive('error.api.responseStatusFailed');
  return '';
}
