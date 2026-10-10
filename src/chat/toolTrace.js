// P5：agent transcript 的工具轨迹（对齐参考 harness「持久化含 tool 消息的完整 transcript」）。
//
// easychat2 采用**嵌套**方案：把一轮里「assistant(tool_calls) + tool 结果」的轨迹挂在
// 该轮助手终稿消息的 `toolTrace` 字段上（消息形状不变，无需存储迁移）。下一轮组装请求时
// 展开回 agent 历史，让 K1（跨轮清除）/ N2（跨轮压缩）真正看得到工具结果。
// 展示 / 搜索 / 导出 / 分支只读 `text`，对 `toolTrace` 无感。
//
// 轨迹元素形状 = agent 消息：
//   { role:'assistant', content, tool_calls } | { role:'tool', tool_call_id, content }

export const TOOL_TRACE_MAX_BYTES = 256 * 1024;
export const TOOL_TRACE_TOOL_CONTENT_MAX = 16 * 1024;
const TRACE_TRUNCATE_MARK = '…（轨迹截断）…';

function traceBytes(trace) {
  try {
    return JSON.stringify(trace).length;
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function clipToolContent(content) {
  const text = String(content == null ? '' : content);
  if (text.length <= TOOL_TRACE_TOOL_CONTENT_MAX) return text;
  const half = Math.floor(TOOL_TRACE_TOOL_CONTENT_MAX / 2);
  return `${text.slice(0, half)}\n${TRACE_TRUNCATE_MARK}\n${text.slice(text.length - half)}`;
}

// 逐条截断 tool 内容；仍超总预算 → null（宁缺毋滥，绝不把会话撑爆）。
export function sanitizeTrace(trace, { maxBytes = TOOL_TRACE_MAX_BYTES } = {}) {
  const list = (Array.isArray(trace) ? trace : []).map(item => (
    item && item.role === 'tool' ? { ...item, content: clipToolContent(item.content) } : item
  ));
  if (!list.length) return null;
  return traceBytes(list) > maxBytes ? null : list;
}

// 从循环追加的消息里提取轨迹：保留 assistant(tool_calls) 与其后的 tool 结果，
// 丢掉纯文本的助手终稿（它已是展示消息本身）。
export function extractToolTrace(appendedMessages, options = {}) {
  const list = Array.isArray(appendedMessages) ? appendedMessages : [];
  const trace = [];
  for (const item of list) {
    if (!item) continue;
    if (item.role === 'tool') {
      trace.push({
        role: 'tool',
        tool_call_id: item.tool_call_id,
        content: String(item.content == null ? '' : item.content),
      });
    } else if (item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      trace.push({
        role: 'assistant',
        content: item.content == null ? null : String(item.content),
        tool_calls: item.tool_calls,
      });
    }
  }
  return sanitizeTrace(trace, options);
}

// 展开：把每条带 toolTrace 的消息替换为 [...trace, 消息本身]（供 buildHistory 用）。
export function expandHistoryWithTraces(historyMessages) {
  const list = Array.isArray(historyMessages) ? historyMessages : [];
  const out = [];
  for (const item of list) {
    if (item && Array.isArray(item.toolTrace) && item.toolTrace.length) {
      for (const traceItem of item.toolTrace) out.push(traceItem);
    }
    out.push(item);
  }
  return out;
}

// 把轨迹挂到本轮新产出的首个助手正文分段上（展示层读 text，无感）。
export function attachToolTrace(messages, replyParts, trace) {
  if (!Array.isArray(trace) || trace.length === 0) return messages;
  const partIds = new Set((Array.isArray(replyParts) ? replyParts : [])
    .filter(part => part && !part.kind && part.id)
    .map(part => String(part.id)));
  if (partIds.size === 0) return messages;
  let attached = false;
  return (Array.isArray(messages) ? messages : []).map(item => {
    if (!attached && item && partIds.has(String(item.id))) {
      attached = true;
      return { ...item, toolTrace: trace };
    }
    return item;
  });
}
