// 非流式响应解析：三协议 → 统一结果。纯函数。
import { mapStopReason, normalizeAssistantValue } from './stream.js';

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
