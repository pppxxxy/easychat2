// 流式（SSE 单条 data payload）解析：三协议 → 统一增量。纯函数。
import { parseProtocolError } from './errors.js';

export function mapStopReason(reason) {
  if (reason === 'tool_use' || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'stop') return 'stop';
  return reason || null;
}

// 供 parseOpenAiStream 复用：OpenAI 兼容端 content 可能是字符串或数组 part。
export function normalizeAssistantValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.content === 'string') return part.content;
      return '';
    })
    .join('');
}

// OpenAI Chat Completions 流式分片
function parseOpenAiStream(payload) {
  const choice = payload.choices && payload.choices[0];
  const out = {};
  const delta = choice && choice.delta;
  if (delta) {
    if (delta.content !== undefined && delta.content !== null) {
      const text = normalizeAssistantValue(delta.content);
      if (text) out.text = text;
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
    if (Array.isArray(delta.tool_calls)) {
      out.toolCalls = delta.tool_calls.map(raw => {
        const fn = (raw && raw.function) || {};
        return {
          index: Number.isInteger(raw && raw.index) ? raw.index : 0,
          id: typeof raw.id === 'string' ? raw.id : '',
          name: typeof fn.name === 'string' ? fn.name : '',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
        };
      });
    }
  }
  if (choice && typeof choice.finish_reason === 'string') out.finishReason = choice.finish_reason;
  return out;
}

// OpenAI Responses 流式事件（data.type 即事件类型）
function parseResponsesStream(payload) {
  const type = String(payload.type || '');
  if (!type) return {};
  if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
    return { text: payload.delta };
  }
  if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta')
    && typeof payload.delta === 'string') {
    return { reasoning: payload.delta };
  }
  if (type === 'response.output_item.added') {
    const item = payload.item || {};
    if (item.type === 'function_call') {
      return {
        toolCalls: [{
          index: Number.isInteger(payload.output_index) ? payload.output_index : 0,
          id: String(item.call_id || item.id || ''),
          name: String(item.name || ''),
          arguments: String(item.arguments || ''),
        }],
      };
    }
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      const text = item.summary.map(part => String((part && part.text) || '')).join('');
      if (text) return { reasoning: text };
    }
    return {};
  }
  if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
    return {
      toolCalls: [{
        index: Number.isInteger(payload.output_index) ? payload.output_index : 0,
        id: '',
        name: '',
        arguments: payload.delta,
      }],
    };
  }
  if (type === 'response.completed') {
    const reason = payload.response && payload.response.status;
    return { finishReason: reason === 'incomplete' ? 'length' : 'stop' };
  }
  if (type === 'response.failed' || type === 'response.incomplete') {
    const response = payload.response || {};
    const errorMessage = parseProtocolError('openai-responses', { error: response.error })
      || '接口返回失败状态。';
    return { error: errorMessage };
  }
  if (type === 'error') {
    return { error: parseProtocolError('openai-responses', payload) || '接口返回错误。' };
  }
  return {};
}

// Anthropic Messages 流式事件
function parseAnthropicStream(payload) {
  const type = String(payload.type || '');
  if (!type) return {};
  if (type === 'content_block_start') {
    const block = payload.content_block || {};
    if (block.type === 'tool_use') {
      return {
        toolCalls: [{
          index: Number.isInteger(payload.index) ? payload.index : 0,
          id: String(block.id || ''),
          name: String(block.name || ''),
          arguments: '',
        }],
      };
    }
    return {};
  }
  if (type === 'content_block_delta') {
    const delta = payload.delta || {};
    if (delta.type === 'text_delta' && typeof delta.text === 'string') return { text: delta.text };
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') return { reasoning: delta.thinking };
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      return {
        toolCalls: [{
          index: Number.isInteger(payload.index) ? payload.index : 0,
          id: '',
          name: '',
          arguments: delta.partial_json,
        }],
      };
    }
    return {};
  }
  if (type === 'message_delta') {
    const delta = payload.delta || {};
    if (delta.stop_reason) return { finishReason: mapStopReason(delta.stop_reason) };
    return {};
  }
  if (type === 'message_stop') return { finishReason: 'stop' };
  if (type === 'error') {
    return { error: parseProtocolError('anthropic', payload) || '接口返回错误。' };
  }
  return {};
}

export function parseStreamPayload(protocol, payload) {
  if (protocol === 'anthropic') return parseAnthropicStream(payload);
  if (protocol === 'openai-responses') return parseResponsesStream(payload);
  return parseOpenAiStream(payload);
}
