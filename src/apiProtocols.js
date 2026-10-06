// API 协议适配层（纯函数，零 RN/存储依赖，可 Node 直测）。
//
// 对外 barrel：实现已按职责拆到 ./apiProtocols/*.js（本文件只做转发，既有导入方零改动）。
//   ./apiProtocols/constants.js  三协议 id 与归一
//   ./apiProtocols/urls.js       端点 URL 归一 + 鉴权头
//   ./apiProtocols/multimodal.js data URI 解析 + 多模态块
//   ./apiProtocols/tools.js      工具定义 / tool_choice 转换
//   ./apiProtocols/messages.js   内部消息 → 各协议 messages/input
//   ./apiProtocols/body.js       统一请求体构造
//   ./apiProtocols/errors.js     错误载荷解析
//   ./apiProtocols/stream.js     流式（SSE 单条 data）解析
//   ./apiProtocols/final.js      非流式响应解析
//
// 内部统一用 OpenAI Chat Completions 形态的消息与结果：
//   message: { role: 'system'|'user'|'assistant'|'tool', content: string|[part], tool_calls?, tool_call_id? }
//   part:    { type: 'text', text } | { type: 'image_url', image_url: { url } } | { type: 'video_url', video_url: { url } } | { type: 'input_audio', input_audio: { data, format } }
//   result:  { text, reasoning, toolCalls: [{ id, name, arguments }], finishReason }
//
// api.js 只做 XHR 传输、超时与配置守卫，协议细节全部收敛在这组模块里。

export { API_PROTOCOLS, isKnownProtocol, normalizeProtocol } from './apiProtocols/constants.js';
export { buildRequestHeaders, normalizeProtocolUrl } from './apiProtocols/urls.js';
export { parseDataUri } from './apiProtocols/multimodal.js';
export { toAnthropicRequest, toResponsesRequest } from './apiProtocols/messages.js';
export { buildRequestBody } from './apiProtocols/body.js';
export { parseProtocolError } from './apiProtocols/errors.js';
export { normalizeAssistantValue, parseStreamPayload } from './apiProtocols/stream.js';
export { parseFinalPayload } from './apiProtocols/final.js';
