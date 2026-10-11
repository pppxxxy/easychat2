// 请求失败的**参数被拒**判定（纯函数，零依赖，Node 直测）。
//
// 为什么需要它（2026-10-11 P1）：`max_tokens` / `reasoning` / `thinking` 这些字段是
// **按每个模型的能力位注入**的（api.js 的 modelCaps.customParams、apiProtocols/body.js
// 的 thinking 字段），所以「主模型不认这个参数」完全不代表降级模型也不认——这恰恰是
// 降级链最有价值的一条路径。此前 400/422 与 401 一起被归成「确定性失败，不换」，
// 于是「换个模型就好的参数错」被白白放弃，用户只看到一条报错。
//
// 判据（保守：宁可少降级，不可把确定性失败当可重试）：
// 只在 HTTP 400 / 422 上生效，且错误文本必须**命中参数名或参数类关键词**。
// 只给状态码、文本里看不出参数问题的 400（如「invalid request」以外的格式错）不判为
// 参数被拒——那可能是请求体真写坏了，换模型也一样。
//
// 判据放在这一层而不是 api.js 里：api.js 顶着行数棘轮基线（801 行），
// 判定逻辑抽出来才放得下，也才能单独直测。

// 参数名 / 参数类关键词（大小写不敏感）。命中任一即认为「上游在抱怨某个参数」。
const PARAM_HINTS = Object.freeze([
  'unknown_parameter',
  'unknown parameter',
  'unrecognized',
  'unsupported_parameter',
  'unsupported parameter',
  'unsupported value',
  'invalid_parameter',
  'invalid parameter',
  'extra_forbidden',
  'not supported',
  'does not support',
  '不支持',
  '未知参数',
  '无法识别',
  '无效参数',
]);

// 具体字段名：模型能力位注入的那几个（见 api.js 的 buildThinkingParams 与
// apiProtocols/body.js），加上各端常见的采样字段。
const PARAM_FIELDS = Object.freeze([
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'reasoning_effort',
  'reasoning',
  'thinking',
  'temperature',
  'top_p',
  'top_k',
  'stream_options',
  'tool_choice',
]);

// 该 HTTP 状态是否属于「参数被拒」的候选（只有 400 / 422）。
export function isParamRejectionStatus(status) {
  const value = Number(status);
  return value === 400 || value === 422;
}

// 错误文本是否指向「某个参数不被接受」。
export function messageLooksLikeParamRejection(message) {
  const text = String(message === undefined || message === null ? '' : message).toLowerCase();
  if (!text) return false;
  if (PARAM_HINTS.some(hint => text.includes(hint.toLowerCase()))) return true;
  return PARAM_FIELDS.some(field => text.includes(field));
}

// 综合判定：状态码是 400/422 **且**文本指向参数问题。
export function isParamRejectedError({ status, message } = {}) {
  if (!isParamRejectionStatus(status)) return false;
  return messageLooksLikeParamRejection(message);
}
