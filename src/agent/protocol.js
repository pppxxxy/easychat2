// Agent 事件协议（程序化接口的稳定契约，差距 #3 的 JS 侧基础）。
//
// 把一次 agent 运行过程标准化为一串 JSON 事件（JSONL 一行一条），供外部驱动消费——
// 未来的原生 endpoint（本地 API server 加 /v1/agent）/ SDK / 脚本都按这份契约解析，
// 不依赖内部对象形状。纯逻辑，可 Node 直测。

export const AGENT_PROTOCOL_VERSION = 1;

// 工具参数在事件里的上限（JSON 字符数）。args 是**模型给的、体量不可控**的输入：
// 一次 write_workspace_file 能把整个文件内容塞进 args.content，一次 run_shell 能塞进整段命令。
// 协议出口是流式旁路，一条事件撑到几 MB 会把落盘、传输与消费方一起拖垮。
export const AGENT_EVENT_ARGS_MAX_CHARS = 2000;

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

// 时间戳归一：**只有真正缺失/非法**才回落到当前时间。
// 2026-10-11 审查 P2：原先写的是 `int(at) || Date.now()`——`at = 0`（epoch 起点，回放与测试
// 常用）是**合法时间戳**却被当 falsy 丢掉，回放出来的事件时间戳会变成「现在」，
// 乱序与耗时统计因此失真。null/undefined/空串按缺失处理（Number(null) === 0，不能靠 Number 判）。
function resolveAt(raw) {
  if (raw === null || raw === undefined || raw === '') return Date.now();
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : Date.now();
}

function safeKeys(raw) {
  try {
    return Object.keys(raw);
  } catch (error) {
    return [];
  }
}

// args 归一：只放**能 JSON 往返的纯数据**，并设上限。两件事一起做，因为它们是同一个承诺：
// 文件头那句「只放契约字段，绝不透传内部对象」——原样透传 `source.args` 时它并不成立
// （内部对象、函数、循环引用、超大载荷都会跟着出去）。
//  · 上限内：JSON 往返后原样保留（消费方仍能看到「读的是哪个文件、跑的是什么命令」）；
//  · 超限 / 不可序列化：退化为 `{ keys, truncated: true, ... }`，只给键名与体量，绝不截断后冒充完整值；
//  · 非对象 / 空：null（字符串或数字形态的参数没有契约意义）。
function normalizeArgs(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  let json = null;
  try {
    json = JSON.stringify(raw);
  } catch (error) {
    json = null; // 循环引用等
  }
  if (typeof json !== 'string') {
    return { keys: safeKeys(raw), truncated: true, reason: 'unserializable' };
  }
  if (json.length > AGENT_EVENT_ARGS_MAX_CHARS) {
    return { keys: safeKeys(raw), truncated: true, originalChars: json.length };
  }
  try {
    // 往返一次：把函数、undefined、原型上的东西全部剥掉，只留纯数据。
    return JSON.parse(json);
  } catch (error) {
    return { keys: safeKeys(raw), truncated: true, reason: 'unserializable' };
  }
}

// 归一为线上事件：{ v, type, at, ...白名单字段 }。只放契约字段，绝不透传内部对象。
export function normalizeAgentEvent(type, payload = {}, at = Date.now()) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const base = { v: AGENT_PROTOCOL_VERSION, type: str(type), at: resolveAt(at) };
  switch (type) {
    case AGENT_EVENT.TEXT:
    case AGENT_EVENT.REASONING:
      return { ...base, text: str(source.text) };
    case AGENT_EVENT.TOOL_START:
      return { ...base, name: str(source.name), round: int(source.round), args: normalizeArgs(source.args) };
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
// 失败返回 **null**（不是空串）：空串会被消费方当成「一条空事件」，与失败无法区分——
// 而调用方对这两种情况的处理完全不同（前者可跳过、后者要报警）。另外 JSON.stringify 对
// undefined / 函数 / Symbol 会返回 undefined（不抛异常），同样按失败处理。
export function serializeAgentEvent(event) {
  try {
    const line = JSON.stringify(event);
    return typeof line === 'string' ? line : null;
  } catch (error) {
    return null;
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
