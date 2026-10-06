// 内部消息形态 → 各协议 messages/input 的转换。纯函数。
import { toAnthropicImagePart, toTextParts } from './multimodal.js';

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// OpenAI 兼容：内部形态即目标形态，原样返回。
export function toOpenAiMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => ({ ...message }));
}

// 把内部消息切成 (role, blocks) 序列，供 Anthropic / Responses 复用。
export function eachMessage(messages) {
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
