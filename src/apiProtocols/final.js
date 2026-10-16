// 非流式响应解析：三协议 → 统一结果。纯函数。
import { mapStopReason, normalizeAssistantValue } from './stream.js';
import { parseProtocolError } from './errors.js';
// 错误文案走 i18n：这里返回的 error 会经 api.js 变成 Error.message，聊天页直接展示。
// 与 stream.js 同款只 import tActive（纯函数层拿不到 hook）。
import { tActive } from '../i18n/index.js';

function finalOpenAi(data) {
  const choice = data.choices && data.choices[0];
  const message = (choice && choice.message) || {};
  const reasoning = typeof message.reasoning_content === 'string'
    ? message.reasoning_content
    : (typeof message.reasoning === 'string' ? message.reasoning : '');
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call, index) => {
    const fn = (call && call.function) || {};
    return {
      id: String(call && call.id || ''),
      name: String(fn.name || ''),
      arguments: String(fn.arguments || ''),
      index,
    };
  }).filter(call => call.name);
  return {
    text: normalizeAssistantValue(message.content),
    reasoning,
    toolCalls,
    finishReason: (choice && typeof choice.finish_reason === 'string') ? choice.finish_reason : null,
  };
}

function finalResponses(data) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  const output = Array.isArray(data.output) ? data.output : [];
  output.forEach(item => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach(part => {
        if (part && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      });
    } else if (item.type === 'reasoning') {
      if (Array.isArray(item.summary)) {
        reasoning += item.summary.map(part => String((part && part.text) || '')).join('');
      } else if (typeof item.content === 'string') {
        reasoning += item.content;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || ''),
        name: String(item.name || ''),
        arguments: String(item.arguments || ''),
        index: toolCalls.length,
      });
    }
  });
  const incomplete = data.incomplete_details && data.incomplete_details.reason;
  const finishReason = data.status === 'incomplete'
    ? (incomplete === 'max_output_tokens' ? 'length' : 'stop')
    : 'stop';
  // status==='failed'：Responses API 明确报失败（如工具调用中途出错）。此前没有这个分支，
  // 于是失败体照常返回 text:'' + finishReason:'stop'，上游把失败当成功空回复呈现
  //（竞品警示 #6「GLM 系只思考不说话」在本仓协议层的对应缺口）。
  //
  // 形状选 `{ error }` 哨兵而**不是 throw**：本目录 0 处 throw、4 处 `{ error }`
  //（stream.js:109/123/170），且 api.js:757 的 catch 会把任何抛出的 message 换成笼统的
  //「无法解析的内容」——throw 既违例又丢原因。消费方 api.js:746 读 parsed.error 后抛错，
  // 与流式路径的消费方式一致（那才是能把原文带到错误气泡的路径）。
  //
  // 注意：payload 自带**可描述**的 error 时，api.js:738 的 parseProtocolError 会先拦下，
  // 根本走不到这里；因此本分支实际兜住的是「报了 failed 但没给出可读原因」那类残留
  //（error 为 null/缺失/空对象），此时用既有的 responseStatusFailed 兜底文案，
  // 与 stream.js:100-108 对 response.failed 的处理完全同口径。
  if (data.status === 'failed') {
    const message = parseProtocolError('openai-responses', data) || tActive('error.api.responseStatusFailed');
    return { text, reasoning, toolCalls, finishReason, error: message };
  }
  return { text, reasoning, toolCalls, finishReason };
}

function finalAnthropic(data) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  const content = Array.isArray(data.content) ? data.content : [];
  content.forEach(block => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id || ''),
        name: String(block.name || ''),
        arguments: JSON.stringify(block.input || {}),
        index: toolCalls.length,
      });
    }
  });
  return { text, reasoning, toolCalls, finishReason: mapStopReason(data.stop_reason) };
}

export function parseFinalPayload(protocol, data) {
  if (protocol === 'anthropic') return finalAnthropic(data);
  if (protocol === 'openai-responses') return finalResponses(data);
  return finalOpenAi(data);
}
