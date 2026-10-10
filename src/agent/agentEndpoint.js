// /v1/agent 端点契约（纯函数，可 Node 直测）。
//
// 本地 API 服务（Kotlin）新增 POST /v1/agent：把请求体发给 JS，JS 跑 agent 工具循环，
// 再把结果回写。本模块只负责**请求归一**与**响应构造**，不碰网络/存储——便于直测。
//
// 请求体（宽松接受）：{ prompt? | input? | messages?, mode?, max_rounds?, character_id? }
//   - prompt/input：单轮便捷字段；缺省时取 messages 里最后一条 user 内容。
//   - mode：ask / read / write（缺省 read——端点是程序化入口，默认只读更安全）。
//   - messages：可选的多轮历史（OpenAI 风格 [{ role, content }]）。
// 响应体：{ object:'agent.run', model, text, steps, usage? }

export const AGENT_ENDPOINT_PATH = '/v1/agent';
export const AGENT_ENDPOINT_OBJECT = 'agent.run';
export const AGENT_MODES = Object.freeze(['ask', 'read', 'write']);

function messageText(content) {
  if (typeof content === 'string') return content;
  // 多模态 content 数组：拼接其中的 text 片段。
  if (Array.isArray(content)) {
    return content
      .map(part => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

// 纯函数：请求体 → { messages, prompt, mode, maxRounds, characterId }。
export function parseAgentEndpointRequest(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const messages = (Array.isArray(source.messages) ? source.messages : [])
    .filter(item => item && typeof item.role === 'string')
    .map(item => ({ role: String(item.role), content: messageText(item.content) }));
  let prompt = '';
  if (typeof source.prompt === 'string') prompt = source.prompt;
  else if (typeof source.input === 'string') prompt = source.input;
  if (!prompt && messages.length) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') { prompt = messages[index].content; break; }
    }
  }
  const mode = AGENT_MODES.includes(String(source.mode || '').toLowerCase())
    ? String(source.mode).toLowerCase()
    : 'read';
  const rounds = Math.floor(Number(source.max_rounds));
  return {
    messages,
    prompt: String(prompt || '').trim(),
    mode,
    maxRounds: Number.isFinite(rounds) && rounds > 0 ? rounds : 0,
    characterId: String(source.character_id || source.characterId || '').trim(),
  };
}

// 纯函数：agent 运行结果 → 端点响应对象。
export function buildAgentEndpointResponse({ text = '', model = 'local-model', steps = [], usage = null } = {}) {
  const response = {
    object: AGENT_ENDPOINT_OBJECT,
    model: String(model || 'local-model'),
    text: String(text == null ? '' : text),
    steps: (Array.isArray(steps) ? steps : [])
      .filter(item => item && item.name)
      .map(item => ({ name: String(item.name), ...(item.ok === false ? { ok: false } : {}) })),
  };
  if (usage && typeof usage === 'object') response.usage = usage;
  return response;
}
