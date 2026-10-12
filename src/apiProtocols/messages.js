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

// OpenAI Chat Completions 请求里**合法的消息字段白名单**（fail-closed：只搬列在这里的字段）。
//
// 为什么用白名单而不是黑名单：黑名单的语义是**默认放行（fail-open）**——内部消息上加任何
// 新字段都会静默出网，直到有人记得把它登记进「内部字段名单」；而部分 OpenAI 兼容实现遇到
// 未知字段直接 400（见 tests/promptCache 的「不泄漏给端点」不变量）。白名单是**默认拒绝**：
// 忘了登记新字段的后果只是「该字段不出网」（安全方向），而不是「内部字段出网」（危险方向）。
// 这个区别不是理论上的——本函数原先就是黑名单，tool 消息上新增的 noticeKey/noticeParams
//（界面侧词条引用，toolDefs/toolNotices.js）确实漏出去过一次，只能事后补登记。
//
// 与同族写法一致：toAnthropicRequest / toResponsesRequest 一直是**逐条显式构造**（只取它们
// 认识的字段），此前只有本函数是「整体展开 + 黑名单剥离」。同族一处 fail-closed、一处
// fail-open，正是「新增字段静默出网」这一整类风险的根因；现在三处口径统一为默认拒绝。
//
// ⚠️ 给内部消息新增字段时的正确做法：
//   · 是协议字段（端点认识它）→ 加进下面的白名单，并在注释里写明协议依据；
//   · 是内部字段（只服务本地：systemCache / isError / noticeKey / noticeParams …）
//     → **什么都不用做**。白名单天然挡住它，不需要维护任何「内部字段名单」。
//
// 字段与协议依据（OpenAI Chat Completions 的请求消息 schema；见
// https://platform.openai.com/docs/api-reference/chat/create 的 messages 一节，
// 与 openai-node 的 ChatCompletionXxxMessageParam 类型一一对应）：
const OPENAI_MESSAGE_FIELDS = [
  // 必填：system / user / assistant / tool（developer、function 是同族旧值，同样放行）。
  'role',
  // 正文：string 或 parts 数组（assistant 可以是 null）。**原样带出，不做任何规范化**——
  // parts 里还可能有 image_url / video_url / input_audio，形状由调用方与端点约定。
  'content',
  // 可选的参与者名（system / user / assistant 消息）。
  'name',
  // assistant 的 function 调用列表。⚠️ 漏了它会直接打断工具调用链（tool 结果就配不上对了）。
  'tool_calls',
  // tool 消息回指的调用 id（与上一条配对）。
  'tool_call_id',
  // 旧版函数调用字段：已被 tool_calls 取代，但老网关/老历史仍会出现，属请求 schema 的一部分。
  'function_call',
  // assistant 的结构化拒答文本（refusal 字段与 content parts 里的 refusal 块同源）。
  'refusal',
  // assistant 的历史音频引用（多轮音频输出场景，请求侧同样合法）。保留而不丢：白名单只挡
  // **内部**字段，合法协议字段一律不能因为「暂时用不到」被静默删掉。
  'audio',
];
// 明确**不在**白名单里、且必须继续保持不出的字段（写在这里是为了让「故意排除」可见）：
//   systemCache     —— 内部缓存计划（prompt/systemSections.js）
//   isError         —— agent 工具结果的权威错误标记（loop.js 带上、toolTrace 保留给展示层）
//   noticeKey / noticeParams —— 工具结果的界面侧词条引用（toolDefs/toolNotices.js）
//   reasoning / reasoning_content —— 只服务展示层；且部分端点（如 DeepSeek）**拒绝**回传
export function toOpenAiMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (!message || typeof message !== 'object') return message;
    const wire = {};
    for (const field of OPENAI_MESSAGE_FIELDS) {
      // 只搬**自有**字段（与原先 `{ ...message }` 展开的口径一致）：原型链上的东西不算
      // 消息字段，别被继承来的同名属性蒙混过去。
      if (Object.prototype.hasOwnProperty.call(message, field)) wire[field] = message[field];
    }
    return wire;
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
      // 供应商 prompt 缓存：把**最长 stable 连续段**所在的块打上 ephemeral 断点。
      // 用块数组而不是 prefix/rest 两段（2026-10-11 P1）：断点落在稳定块末尾时，
      // 它之前的全部内容（含排在系统提示最前的动态世界书）都进缓存前缀——
      // 而「两段切分」只能表达「从第 0 段起连续 stable」，有世界书时一个断点都打不了。
      // 块间用空行拼接，逐字节等于原来的 systemContent（见 buildSystemChunks）。
      if (message.systemCache && Array.isArray(message.systemCache.chunks) && message.systemCache.chunks.length) {
        const markIndex = Number.isInteger(message.systemCache.markIndex) ? message.systemCache.markIndex : -1;
        message.systemCache.chunks.forEach((chunk, index) => {
          const text = String(chunk && chunk.text ? chunk.text : '');
          if (!text) return;
          systemBlocks.push({
            type: 'text',
            text,
            ...(index === markIndex && cacheControl ? { cache_control: cacheControl } : {}),
          });
        });
        return;
      }
      // 旧形状（只有 prefixText/restText）兜底：单块打标。
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
