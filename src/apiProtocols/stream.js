// 流式（SSE 单条 data payload）解析：三协议 → 统一增量。纯函数。
import { parseProtocolError } from './errors.js';
// 错误文案走 i18n：这里返回的 error 会经 api.js 变成 Error.message，聊天页/诊断直接展示。
// 只 import tActive（非 React 树的同步取词，与 network/api.js 同款）——本模块是纯函数，
// 调用点在 XHR 回调里，拿不到 hook。
import { tActive } from '../i18n/index.js';

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
    // 兜底词条 `error.api.responseStatusFailed`（2026-10-12 迁 i18n）：本条与 api.js 的
    // `error.api.responseError` **不是同一句话**，所以不能复用——「失败状态」说的是
    // response.status（failed / incomplete），而 responseError 说的是「回了 error 载荷但解析不出
    // 原因」。两句主语不同（状态 vs 载荷），合并会让用户分不清「服务端明确报错」与
    // 「服务端只是没成功收尾」。词条已在中英两个 error.js 里补齐（见那里的对照注释）。
    const errorMessage = parseProtocolError('openai-responses', { error: response.error })
      || tActive('error.api.responseStatusFailed');
    return { error: errorMessage };
  }
  if (type === 'error') {
    // 与 network/api.js 的 extractErrorMessage（`error.api.responseError`）**同源同文案**：
    // 两处都是「接口回了 error 载荷但解析不出更具体的原因」这一个兜底。此前这里硬编码
    // 中文、api.js 已迁 i18n ⇒ 同一句话两个来源，一处跟随语言一处不跟随（英文界面里
    // 流式错误冒中文）。复用同一条词条，不新增重复词条。
    return { error: parseProtocolError('openai-responses', payload) || tActive('error.api.responseError') };
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
    // 同 parseResponsesStream 的 error 分支：与 api.js 的 `error.api.responseError` 同源。
    return { error: parseProtocolError('anthropic', payload) || tActive('error.api.responseError') };
  }
  return {};
}

export function parseStreamPayload(protocol, payload) {
  if (protocol === 'anthropic') return parseAnthropicStream(payload);
  if (protocol === 'openai-responses') return parseResponsesStream(payload);
  return parseOpenAiStream(payload);
}
