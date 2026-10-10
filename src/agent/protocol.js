// Agent 事件协议（程序化接口的稳定契约，差距 #3 的 JS 侧基础）。
//
// 把一次 agent 运行过程标准化为一串 JSON 事件（JSONL 一行一条），供外部驱动消费——
// 未来的原生 endpoint（本地 API server 加 /v1/agent）/ SDK / 脚本都按这份契约解析，
// 不依赖内部对象形状。纯逻辑，可 Node 直测。

export const AGENT_PROTOCOL_VERSION = 1;

export const AGENT_EVENT = Object.freeze({
  RUN_START: 'run_start',
  TEXT: 'text', // 流式正文增量
  REASONING: 'reasoning', // 思考增量
  TOOL_START: 'tool_start',
  TOOL_END: 'tool_end',
  USAGE: 'usage',
  RUN_END: 'run_end',
  ERROR: 'error',
});

function str(value) {
  return String(value == null ? '' : value);
}

function int(value) {
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0;
}

// 归一为线上事件：{ v, type, at, ...白名单字段 }。只放契约字段，绝不透传内部对象。
export function normalizeAgentEvent(type, payload = {}, at = Date.now()) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const base = { v: AGENT_PROTOCOL_VERSION, type: str(type), at: int(at) || Date.now() };
  switch (type) {
    case AGENT_EVENT.TEXT:
    case AGENT_EVENT.REASONING:
      return { ...base, text: str(source.text) };
    case AGENT_EVENT.TOOL_START:
      return { ...base, name: str(source.name), round: int(source.round), args: source.args == null ? null : source.args };
    case AGENT_EVENT.TOOL_END:
      return { ...base, name: str(source.name), round: int(source.round), ok: source.ok !== false };
    case AGENT_EVENT.USAGE:
      return {
        ...base,
        round: int(source.round),
        promptTokens: int(source.promptTokens),
        completionTokens: int(source.completionTokens),
        cachedTokens: int(source.cachedTokens),
      };
    case AGENT_EVENT.ERROR:
      return { ...base, message: str(source.message) };
    case AGENT_EVENT.RUN_START:
      return { ...base, ...(source.mode ? { mode: str(source.mode) } : {}) };
    case AGENT_EVENT.RUN_END:
      return { ...base, text: str(source.text) };
    default:
      return base;
  }
}

// JSONL 序列化 / 解析（一行一个事件，便于流式传输与落盘）。
export function serializeAgentEvent(event) {
  try {
    return JSON.stringify(event);
  } catch (error) {
    return '';
  }
}

export function parseAgentEvent(line) {
  try {
    const value = JSON.parse(String(line || ''));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    return null;
  }
}

// 把 agent 循环的回调（onToken/onReasoning/onToolEvent/onUsage）适配成协议事件出口。
// 回调抛错一律吞掉——协议出口是旁路，绝不打断运行。
export function createProtocolEmitter(onEvent) {
  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(normalizeAgentEvent(type, payload));
    } catch (error) {}
  };
  return {
    runStart: payload => emit(AGENT_EVENT.RUN_START, payload),
    text: text => emit(AGENT_EVENT.TEXT, { text }),
    reasoning: text => emit(AGENT_EVENT.REASONING, { text }),
    toolStart: payload => emit(AGENT_EVENT.TOOL_START, payload),
    toolEnd: payload => emit(AGENT_EVENT.TOOL_END, payload),
    usage: payload => emit(AGENT_EVENT.USAGE, payload),
    runEnd: payload => emit(AGENT_EVENT.RUN_END, payload),
    error: message => emit(AGENT_EVENT.ERROR, { message }),
  };
}
