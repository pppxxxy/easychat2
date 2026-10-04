// API 协议适配层（纯函数，零 RN/存储依赖，可 Node 直测）。
//
// 内部统一用 OpenAI Chat Completions 形态的消息与结果：
//   message: { role: 'system'|'user'|'assistant'|'tool', content: string|[part], tool_calls?, tool_call_id? }
//   part:    { type: 'text', text } | { type: 'image_url', image_url: { url } } | { type: 'video_url', video_url: { url } } | { type: 'input_audio', input_audio: { data, format } }
//   result:  { text, reasoning, toolCalls: [{ id, name, arguments }], finishReason }
//
// 本模块负责把上述形态翻译成各协议的 URL / 请求头 / 请求体，并把各协议的
// 流式（SSE 单个 data payload）与非流式响应解析回统一结果。api.js 只做 XHR 传输、
// 超时与配置守卫，协议细节全部收敛在这里。

export const API_PROTOCOLS = ['openai', 'openai-responses', 'anthropic'];

export function normalizeProtocol(value) {
  if (value === 'anthropic') return 'anthropic';
  if (value === 'openai-responses' || value === 'responses') return 'openai-responses';
  return 'openai';
}

export function isKnownProtocol(value) {
  return API_PROTOCOLS.includes(normalizeProtocol(value));
}

// ---------- URL / 请求头 ----------

// 与 normalizeChatUrl 同口径：可填根地址、带 /v1，或直接带端点的完整地址。
export function normalizeProtocolUrl(protocol, baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  const base = trimmed || 'https://api.openai.com';
  if (protocol === 'anthropic') {
    if (/\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (protocol === 'openai-responses') {
    if (/\/responses$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/responses`;
    return `${base}/v1/responses`;
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// 鉴权头：沿用 config.authHeader/authScheme，未配置时按协议给默认值
// （OpenAI 系 Authorization: Bearer；Anthropic 系 x-api-key）。
export function buildRequestHeaders(protocol, config, { stream = true } = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const headers = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
  const defaultHeader = protocol === 'anthropic' ? 'x-api-key' : 'Authorization';
  const header = String(source.authHeader || defaultHeader) || defaultHeader;
  const scheme = source.authScheme === undefined || source.authScheme === null
    ? (protocol === 'anthropic' ? '' : 'Bearer ')
    : String(source.authScheme);
  headers[header] = `${scheme}${String(source.apiKey || '')}`;
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = String(source.anthropicVersion || '2023-06-01');
  }
  return headers;
}

// ---------- data URI / 多模态 ----------

export function parseDataUri(uri) {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/s.exec(String(uri || ''));
  if (!match) return null;
  const params = String(match[2] || '');
  const isBase64 = /;base64/i.test(params);
  return {
    mediaType: String(match[1] || 'image/jpeg'),
    isBase64,
    data: String(match[3] || ''),
  };
}

function toAnthropicImagePart(part) {
  const url = String((part.image_url && part.image_url.url) || '');
  const parsed = parseDataUri(url);
  if (parsed && parsed.isBase64) {
    return { type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function toTextParts(content, textType = 'text') {
  if (typeof content === 'string') return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .map(part => {
      if (typeof part === 'string') return { type: textType, text: part };
      if (part && typeof part.text === 'string') return { type: textType, text: part.text };
      return null;
    })
    .filter(Boolean);
}

// ---------- 工具定义 / 选择 ----------

function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map(tool => ({
      name: String((tool && tool.function && tool.function.name) || (tool && tool.name) || ''),
      description: String((tool && tool.function && tool.function.description) || (tool && tool.description) || ''),
      parameters: (tool && tool.function && tool.function.parameters)
        || (tool && tool.parameters)
        || { type: 'object', properties: {} },
    }))
    .filter(tool => tool.name);
}

function buildAnthropicTools(tools) {
  return normalizeTools(tools).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function buildResponsesTools(tools) {
  return normalizeTools(tools).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function buildAnthropicToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return undefined;
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'string') return { type: 'tool', name: toolChoice };
  if (toolChoice && toolChoice.type === 'function' && toolChoice.function) {
    return { type: 'tool', name: String(toolChoice.function.name || '') };
  }
  return { type: 'auto' };
}

function buildResponsesToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'none') return 'none';
  if (toolChoice === 'required') return 'required';
  if (typeof toolChoice === 'string') return { type: 'function', name: toolChoice };
  if (toolChoice && toolChoice.type === 'function' && toolChoice.function) {
    return { type: 'function', name: String(toolChoice.function.name || '') };
  }
  return 'auto';
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// ---------- 消息转换 ----------

// OpenAI 兼容：内部形态即目标形态，原样返回。
function toOpenAiMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => ({ ...message }));
}

// 把内部消息切成 (role, blocks) 序列，供 Anthropic / Responses 复用。
function eachMessage(messages) {
  return (Array.isArray(messages) ? messages : []).filter(item => item && typeof item === 'object');
}

// Anthropic Messages：system 抽到顶层；assistant 的 tool_calls → tool_use；
// tool → tool_result；连续同角色合并；首条必须是 user（否则把开头 assistant 文本
// 并入 system，避免请求被拒）。
export function toAnthropicRequest(messages) {
  const systemParts = [];
  const turns = [];
  const pushTurn = (role, blocks) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      turns.push({ role, content: blocks });
    }
  };

  eachMessage(messages).forEach(message => {
    const role = String(message.role || 'user');
    if (role === 'system') {
      const text = toTextParts(message.content).map(part => part.text).join('\n');
      if (text) systemParts.push(text);
      return;
    }
    if (role === 'tool') {
      const content = typeof message.content === 'string'
        ? message.content
        : toTextParts(message.content).map(part => part.text).join('\n');
      pushTurn('user', [{
        type: 'tool_result',
        tool_use_id: String(message.tool_call_id || ''),
        content,
      }]);
      return;
    }
    if (role === 'assistant') {
      const blocks = [];
      if (typeof message.content === 'string') {
        if (message.content) blocks.push({ type: 'text', text: message.content });
      } else if (Array.isArray(message.content)) {
        message.content.forEach(part => {
          if (typeof part === 'string') blocks.push({ type: 'text', text: part });
          else if (part && typeof part.text === 'string' && part.text) blocks.push({ type: 'text', text: part.text });
        });
      }
      (Array.isArray(message.tool_calls) ? message.tool_calls : []).forEach(call => {
        const fn = (call && call.function) || {};
        blocks.push({
          type: 'tool_use',
          id: String(call && call.id || ''),
          name: String(fn.name || ''),
          input: safeParseJson(String(fn.arguments || '')) || {},
        });
      });
      pushTurn('assistant', blocks);
      return;
    }
    // user
    const blocks = [];
    if (typeof message.content === 'string') {
      if (message.content) blocks.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      message.content.forEach(part => {
        if (!part || typeof part !== 'object') return;
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url') blocks.push(toAnthropicImagePart(part));
        // video_url：Anthropic Messages 不支持内联视频，丢弃，文本部分保留
        //（发送侧只在 OpenAI 兼容协议下解锁视频附件，这里是纵深防御）。
        // input_audio：Anthropic Messages 不支持内联音频，丢弃，文本部分保留。
      });
    }
    pushTurn('user', blocks);
  });

  if (turns.length && turns[0].role === 'assistant') {
    const leading = turns.shift();
    const text = leading.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    if (text) systemParts.push(`[角色此前发言]\n${text}`);
    // 其余非文本块（tool_use）丢弃：缺少对应 user 轮无法成立。
    if (turns.length && turns[0].role === 'assistant') {
      // 连续 assistant 已在 pushTurn 合并，这里不会再触发；留作防御。
    }
  }

  return {
    system: systemParts.join('\n\n'),
    messages: turns,
  };
}

// OpenAI Responses：system → instructions；消息 → input 数组。
// 图片用 input_image（URL 字符串），函数调用/结果用 function_call / function_call_output。
export function toResponsesRequest(messages) {
  const instructionParts = [];
  const input = [];
  eachMessage(messages).forEach(message => {
    const role = String(message.role || 'user');
    if (role === 'system') {
      const text = toTextParts(message.content).map(part => part.text).join('\n');
      if (text) instructionParts.push(text);
      return;
    }
    if (role === 'tool') {
      const output = typeof message.content === 'string'
        ? message.content
        : toTextParts(message.content).map(part => part.text).join('\n');
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || ''),
        output,
      });
      return;
    }
    if (role === 'assistant') {
      if (typeof message.content === 'string' && message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }],
        });
      }
      (Array.isArray(message.tool_calls) ? message.tool_calls : []).forEach(call => {
        const fn = (call && call.function) || {};
        input.push({
          type: 'function_call',
          call_id: String(call && call.id || ''),
          name: String(fn.name || ''),
          arguments: String(fn.arguments || ''),
        });
      });
      return;
    }
    const content = [];
    if (typeof message.content === 'string') {
      if (message.content) content.push({ type: 'input_text', text: message.content });
    } else if (Array.isArray(message.content)) {
      message.content.forEach(part => {
        if (!part || typeof part !== 'object') return;
        if (part.type === 'text' && typeof part.text === 'string') {
          content.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'image_url') {
          content.push({
            type: 'input_image',
            image_url: String((part.image_url && part.image_url.url) || ''),
          });
        } else if (part.type === 'input_audio') {
          content.push({
            type: 'input_audio',
            input_audio: {
              data: String((part.input_audio && part.input_audio.data) || ''),
              format: String((part.input_audio && part.input_audio.format) || 'mp3'),
            },
          });
        }
        // video_url：Responses 协议没有视频输入类型，静默丢弃（纵深防御，见 Anthropic 同注）。
      });
    }
    if (content.length) input.push({ type: 'message', role: 'user', content });
  });

  return {
    instructions: instructionParts.join('\n\n'),
    input,
  };
}

// ---------- 采样参数 ----------

function normalizeSampling(samplingParams) {
  const source = samplingParams && typeof samplingParams === 'object' ? samplingParams : {};
  return {
    maxTokens: Number.isFinite(Number(source.max_tokens)) ? Math.round(Number(source.max_tokens)) : null,
    temperature: Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : null,
    topP: Number.isFinite(Number(source.top_p)) ? Number(source.top_p) : null,
    topK: Number.isFinite(Number(source.top_k)) ? Math.round(Number(source.top_k)) : null,
  };
}

function anthropicThinkingBudget(level) {
  if (level === 'low') return 1024;
  if (level === 'high') return 8192;
  return 4096;
}

// ---------- 请求体 ----------

// 统一入口：返回可直接 send 的请求体对象（不含鉴权头与 URL）。
export function buildRequestBody({
  protocol,
  model,
  messages,
  stream = true,
  tools = null,
  toolChoice = undefined,
  samplingParams = null,
  thinkingParams = null,
  thinkingSettings = null,
  config = null,
} = {}) {
  const sampling = normalizeSampling(samplingParams);
  const toolList = Array.isArray(tools) ? tools : [];
  const thinkingEnabled = !!(thinkingSettings && thinkingSettings.enabled === true)
    && !!(config && config.supportsThinking === true);
  const levelRaw = thinkingSettings && thinkingSettings.level;
  const level = ['low', 'medium', 'high'].includes(levelRaw) ? levelRaw : 'medium';

  if (protocol === 'anthropic') {
    const { system, messages: turns } = toAnthropicRequest(messages);
    const body = {
      model,
      max_tokens: sampling.maxTokens || 4096,
      messages: turns,
    };
    if (system) body.system = system;
    if (thinkingEnabled) {
      const budget = anthropicThinkingBudget(level);
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic 要求开启 thinking 时 max_tokens 大于 budget_tokens。
      body.max_tokens = Math.max(body.max_tokens, budget + 1024);
    } else {
      if (sampling.temperature !== null) body.temperature = sampling.temperature;
    }
    if (sampling.topP !== null) body.top_p = sampling.topP;
    if (sampling.topK !== null) body.top_k = sampling.topK;
    if (toolList.length) {
      body.tools = buildAnthropicTools(toolList);
      const choice = buildAnthropicToolChoice(toolChoice);
      if (choice) body.tool_choice = choice;
    }
    body.stream = stream !== false;
    return body;
  }

  if (protocol === 'openai-responses') {
    const { instructions, input } = toResponsesRequest(messages);
    const body = {
      model,
      input,
      store: false,
      stream: stream !== false,
    };
    if (instructions) body.instructions = instructions;
    if (sampling.maxTokens !== null) body.max_output_tokens = sampling.maxTokens;
    if (sampling.temperature !== null) body.temperature = sampling.temperature;
    if (sampling.topP !== null) body.top_p = sampling.topP;
    if (thinkingEnabled) body.reasoning = { effort: level };
    if (toolList.length) {
      body.tools = buildResponsesTools(toolList);
      if (toolChoice !== undefined) body.tool_choice = buildResponsesToolChoice(toolChoice);
    }
    return body;
  }

  // openai chat completions
  const body = {
    model,
    messages: toOpenAiMessages(messages),
    stream: stream !== false,
    ...(thinkingParams || {}),
    ...(samplingParams || {}),
  };
  if (toolList.length) {
    body.tools = toolList;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }
  return body;
}

// ---------- 错误解析 ----------

export function parseProtocolError(protocol, payload) {
  if (!payload || typeof payload !== 'object') return '';
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  return '';
}

// ---------- 流式解析（单条 SSE data payload）----------

function mapStopReason(reason) {
  if (reason === 'tool_use' || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'stop') return 'stop';
  return reason || null;
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

export function parseStreamPayload(protocol, payload) {
  if (protocol === 'anthropic') return parseAnthropicStream(payload);
  if (protocol === 'openai-responses') return parseResponsesStream(payload);
  return parseOpenAiStream(payload);
}

// ---------- 非流式解析 ----------

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
