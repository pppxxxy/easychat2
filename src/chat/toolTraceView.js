// 工具调用轨迹的展示归纳（纯函数，可 Node 直测）。
//
// 消息里持久化的 toolTrace 是「原样」的 agent 消息（assistant(tool_calls) + tool 结果交替），
// 供下一轮展开回上下文用（见 toolTrace.js）。本模块把它归纳成**展示用**的步骤列表：
// 每一步 = 一次工具调用（名字 + 参数摘要 + 结果摘要），供工作区聊天页在助手消息下折叠展示，
// 让用户看得到 agent「做了什么」。只做归纳与截断，不改数据。

export const TOOL_TRACE_STEP_MAX = 40;
export const TOOL_TRACE_PREVIEW_CHARS = 240;

// 压成单行 + 截断（展示用；不保留换行，避免卡片被撑爆）。
function clip(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// toolTrace → [{ name, args, result }]（按调用顺序；结果按 tool_call_id 配对）。
export function summarizeToolTrace(trace, { maxSteps = TOOL_TRACE_STEP_MAX, previewChars = TOOL_TRACE_PREVIEW_CHARS } = {}) {
  const list = Array.isArray(trace) ? trace : [];
  const results = new Map();
  for (const item of list) {
    if (item && item.role === 'tool') {
      results.set(String(item.tool_call_id || ''), String(item.content == null ? '' : item.content));
    }
  }
  const steps = [];
  for (const item of list) {
    if (!item || item.role !== 'assistant' || !Array.isArray(item.tool_calls)) continue;
    for (const call of item.tool_calls) {
      if (!call || !call.name) continue;
      steps.push({
        name: String(call.name),
        args: clip(call.arguments, previewChars),
        result: clip(results.get(String(call.id || '')), previewChars),
      });
    }
  }
  return steps.slice(0, maxSteps);
}

// 轨迹里的工具调用条数（供折叠标题用；不构造步骤对象，超长轨迹也便宜）。
export function countToolCalls(trace) {
  const list = Array.isArray(trace) ? trace : [];
  let count = 0;
  for (const item of list) {
    if (item && item.role === 'assistant' && Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) if (call && call.name) count += 1;
    }
  }
  return count;
}
