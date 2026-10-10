// 内部消息形态 → 各协议 messages/input 的转换。纯函数。
import { toAnthropicImagePart, toTextParts } from './multimodal.js';
// Z/M/D 整合：system 断点位置由 prompt/systemSections 的稳定前缀决定（systemCache），
// TTL/off 开关复用 D 系 cacheControl——两边合成一套。
import { DEFAULT_PROMPT_CACHE_TTL, cacheControlFor } from './cacheControl.js';

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// OpenAI 兼容：内部形态即目标形态，原样返回。
// systemCache 是内部缓存计划字段（见 prompt/systemSections.js），绝不能泄漏给端点。
export function toOpenAiMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (!message || typeof message !== 'object') return message;
    if (!message.systemCache) return { ...message };
    const copy = { ...message };
    delete copy.systemCache;
    return copy;
  });
}

// 把内部消息切成 (role, blocks) 序列，供 Anthropic / Responses 复用。
export function eachMessage(messages) {
  return (Array.isArray(messages) ? messages : []).filter(item => item && typeof item === 'object');
}

// Anthropic Messages：system 抽到顶层；assistant 的 tool_calls → tool_use；
// tool → tool_result；连续同角色合并；首条必须是 user（否则把开头 assistant 文本
// 并入 system，避免请求被拒）。
export function toAnthropicRequest(messages, { cacheTtl = DEFAULT_PROMPT_CACHE_TTL } = {}) {
  // off → null → 系统前缀不打标（不缓存）；'1h' → 带 ttl。与 D 系 cacheControl 同源。
  const cacheControl = cacheControlFor(cacheTtl);
  const systemParts = [];
  // 带缓存断点的分块（仅当系统消息携带 systemCache，见 prompt/systemSections.js）。
  // Anthropic 的 system 接受 content block 数组，末块可带 cache_control。
  const systemBlocks = [];
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
      if (!text) return;
      // 供应商 prompt 缓存：稳定前缀打 ephemeral 断点（缓存到此处为止），其余不缓存。
      if (message.systemCache && message.systemCache.prefixText) {
        systemBlocks.push({
          type: 'text',
          text: message.systemCache.prefixText,
          ...(cacheControl ? { cache_control: cacheControl } : {}),
        });
        if (message.systemCache.restText) {
          systemBlocks.push({ type: 'text', text: message.systemCache.restText });
        }
        return;
      }
      systemParts.push(text);
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

  // 有缓存分块时 system 用 block 数组（顺序：缓存前缀 → 其余 → 追加的系统文本）；
  // 否则维持原来的字符串形态（零行为变化）。
  const system = systemBlocks.length > 0
    ? [
      ...systemBlocks,
      ...(systemParts.length > 0 ? [{ type: 'text', text: systemParts.join('\n\n') }] : []),
    ]
    : systemParts.join('\n\n');

  return {
    system,
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
