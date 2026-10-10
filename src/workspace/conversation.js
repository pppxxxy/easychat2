// W1：工作区会话的行投影（纯函数，Node 直测）。
//
// 为什么需要它：在此之前，工作区聊天的渲染是「遍历 messages，每条画一个气泡」——于是
// 工具调用只有一行转瞬即逝的状态文字（ChatPanel 的 toolStatus），一轮结束后**什么都看不到**；
// 想加「这次改了什么」「压缩发生在哪一步」只能各自去 messages 里现算。这一层把
// 「会话事实 → 行」固定下来，渲染层不再猜。
//
// 行模型（kind + key 是契约，渲染层按 kind 分派、用 key 做 React key）：
//   user       —— 用户消息
//   assistant  —— 助手终稿（含报错/中止形态，isError 如实带出）
//   tool       —— 一次工具调用（名字 + 参数摘要 + 结果状态/预览），来自消息上的 toolTrace
//   compaction —— 历史压缩标记（内容带 COMPACTION_MARKER 的那条）
//
// 两条刻意的取舍（别当成漏做）：
// 1. **没有 plan 行**：计划的「历史」本身就是 update_plan 的工具行（参数里带清单），
//    而「当前进度」是活的会话状态，由底部的计划面板展示（不进滚动流，否则会滚走）。
//    两处合一才是重复，所以这里不造 plan 行。
// 2. **没有 live 行**：本轮正在跑的那次调用由面板的瞬时状态行负责（它在滚动区之外，
//    位置固定）。行投影只负责「已经沉淀下来的事实」，W2 再做实时行与富卡片。
//
// toolTrace 的形状见 src/chat/toolTrace.js：元素是 agent 消息
//（{role:'assistant',content,tool_calls} / {role:'tool',tool_call_id,content}）。

import { COMPACTION_MARKER } from '../chat/compaction.js';

export const CONVERSATION_ROW_KINDS = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  COMPACTION: 'compaction',
});

export const TOOL_RESULT_PREVIEW_CHARS = 120;
export const TOOL_ARGS_SUMMARY_CHARS = 80;

// 参数摘要：不同工具关心的字段不同，取「最能让用户认出这次调用干了什么」的那个。
// 认不出来的工具退回空串——宁可什么都不显示，也不要显示一坨 JSON。
const ARG_KEYS = ['path', 'filepath', 'subdir', 'pattern', 'command', 'code', 'name', 'repo', 'url'];

export function summarizeToolArgs(name, rawArguments) {
  let args = rawArguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (error) {
      args = null;
    }
  }
  if (!args || typeof args !== 'object') return '';
  if (name === 'update_plan') {
    const steps = Array.isArray(args.plan) ? args.plan : [];
    const done = steps.filter(item => item && item.status === 'done').length;
    return steps.length > 0 ? `${done}/${steps.length} 步` : '';
  }
  for (const key of ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      const text = value.replace(/\s+/g, ' ').trim();
      return text.length > TOOL_ARGS_SUMMARY_CHARS ? `${text.slice(0, TOOL_ARGS_SUMMARY_CHARS)}…` : text;
    }
  }
  return '';
}

// 结果预览：首行 + 截断；错误结果原样带上（模型/用户都要看得见失败原因）。
export function previewToolResult(content, { max = TOOL_RESULT_PREVIEW_CHARS } = {}) {
  const text = String(content === undefined || content === null ? '' : content);
  if (!text) return '';
  const firstLine = text.split('\n').find(line => line.trim()) || text;
  const flat = firstLine.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function toolCallName(call) {
  const fn = call && call.function ? call.function : call;
  return String((fn && fn.name) || '').trim();
}

function toolCallArguments(call) {
  const fn = call && call.function ? call.function : call;
  return fn ? fn.arguments : undefined;
}

// 一轮的 toolTrace → 工具行。配对规则：按 tool_call_id 找结果；找不到结果的行
// status 记 'unknown'（轨迹被截断过就会这样），**不假装成功也不假装失败**。
export function toolRowsFromTrace(trace, { messageId = '' } = {}) {
  const list = Array.isArray(trace) ? trace : [];
  const results = new Map();
  for (const item of list) {
    if (item && item.role === 'tool' && item.tool_call_id != null) {
      results.set(String(item.tool_call_id), item);
    }
  }
  const rows = [];
  for (const item of list) {
    if (!item || item.role !== 'assistant' || !Array.isArray(item.tool_calls)) continue;
    for (const call of item.tool_calls) {
      const id = String((call && call.id) || '');
      const name = toolCallName(call);
      if (!name) continue;
      const result = results.get(id);
      const content = result ? String(result.content || '') : '';
      rows.push({
        kind: CONVERSATION_ROW_KINDS.TOOL,
        key: `tool:${messageId}:${id || name}`,
        tool: {
          id,
          name,
          args: summarizeToolArgs(name, toolCallArguments(call)),
          status: !result ? 'unknown' : (/(^|\n)\s*(错误|失败)|isError|Error:/i.test(content) ? 'error' : 'ok'),
          resultLength: content.length,
          resultPreview: previewToolResult(content),
        },
      });
    }
  }
  return rows;
}

// 会话事实 → 行。messages 里的助手消息若带 toolTrace，先出行工具行再出终稿行
//（顺序即发生顺序：先调工具，最后给答复）。
export function buildConversationRows({ messages } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const rows = [];
  for (const item of list) {
    if (!item) continue;
    const id = String(item.id || '');
    if (item.role === 'user') {
      rows.push({ kind: CONVERSATION_ROW_KINDS.USER, key: `msg:${id}`, message: item });
      continue;
    }
    if (item.role !== 'assistant') continue;
    if (Array.isArray(item.toolTrace) && item.toolTrace.length > 0) {
      rows.push(...toolRowsFromTrace(item.toolTrace, { messageId: id }));
    }
    const content = String(item.content || '');
    // 压缩产物：内容带标记的那条不是「助手的回答」，而是历史重建的说明——单独成行，
    // 渲染层可以给它不同的样式（它是系统的动作，不是模型说的话）。
    const kind = content.includes(COMPACTION_MARKER)
      ? CONVERSATION_ROW_KINDS.COMPACTION
      : CONVERSATION_ROW_KINDS.ASSISTANT;
    rows.push({ kind, key: `msg:${id}`, message: item });
  }
  return rows;
}
