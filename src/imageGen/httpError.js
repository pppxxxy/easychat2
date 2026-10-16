// FEAT-AC13 P0-1：HTTP 错误响应体 → 可读细节（纯函数，Node 直测）。
//
// 事故（用户报告「上一回改图的问题还在」）：改图/生图失败时上游响应体里的
// error.message 被**整个丢弃**——xhrRequest 的 onHttpError 只拿到状态码，
// mapHttpError 把它压成一句「生成失败（HTTP 400）」。HEIC 被拒、参数被拒、
// 端点 404 在用户眼里长得一模一样，无从自查，也无从排障。
//
// 为什么抽成共用函数而不是在主路径里另写一套：
//   同文件 SSE 流式路径**早就有**这个提取（`JSON.parse(...)?.error?.message || ?.message`，
//   见 index.js 的 xhr.onload 非 2xx 分支）。两条路径各写一份的下场必然是漂移
//   （一处改进、另一处不动）。统一成一个函数，两处口径永远一致。
//
// 为什么复用 chat 链路的 describeErrorPayload 而不是重写：
//   它已经是「错误载荷 → 可读文本」的**唯一实现**（F1 修复），并且多认两件事：
//   `error.metadata.raw`（OpenRouter 等聚合上游把真凶放这里）与 `metadata.provider_name`，
//   截断口径也是同一份（500 字符 + 省略号）。自己再写一遍就等于把 F1 的成果
//   在生图链路上重新丢掉一次。

import { describeErrorPayload } from '../apiProtocols/errors.js';

/**
 * 从 HTTP 响应体文本里提取上游错误细节。
 *
 * 契约（与 SSE 路径的既有行为对齐，且是它的**严格超集**）：
 *  - 响应体不是合法 JSON → 返回 ''（调用方回落到按状态码的文案）；
 *  - `{"error":{"message":"…"}}` → 返回该 message；
 *  - `{"error":{"message":…,"metadata":{"raw":…}}}` → message + raw 一并返回（F1 口径）；
 *  - `{"message":"…"}` → 返回该 message；
 *  - 其它形状 → 返回 ''。
 *
 * ⚠️ 有意**不**回落成「原样吐出响应体」：非 JSON 的响应体可能是整页 HTML
 *（网关错误页），原样透传对用户毫无价值、还会刷屏。宁可回落到状态码文案。
 *
 * @param {string} responseText XHR 的 responseText
 * @returns {string} 可读细节；没有可提取内容时为空串
 */
export function describeHttpErrorBody(responseText) {
  const raw = String(responseText === undefined || responseText === null ? '' : responseText).trim();
  if (!raw) return '';
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return '';
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';

  // 主形状：{ error: {...} }（OpenAI / Anthropic / 多数聚合网关）
  const described = describeErrorPayload(payload.error);
  if (described) return described;
  // 次形状：{ message: "..." }（部分网关把错误摊平在顶层）
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return describeErrorPayload(payload.message);
  }
  return '';
}

/**
 * 把「状态码文案 + 上游细节」拼成最终错误文本。
 *
 * 顺序有意如此（任务书 P0-1）：**状态码文案在前**——它给出确定的分类
 *（鉴权/限流/参数），上游细节在后作为可展开的原因。反过来会让用户先看到
 * 一长串上游英文，反而不知道这是 401 还是 400。
 *
 * @param {string} base mapHttpError 生成的文案
 * @param {string} responseText XHR 响应体
 * @returns {string} 最终文案（无细节时原样返回 base）
 */
export function composeHttpErrorMessage(base, responseText) {
  const detail = describeHttpErrorBody(responseText);
  if (!detail) return base;
  return `${base}\n${detail}`;
}
