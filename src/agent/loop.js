// Agent 工具调用循环。
//
// 依赖注入面：`streamChatCompletion`（api.js）与工具执行器（tools/registry.js）。
// 循环本身不做持久化，也不直接接触 RN UI。

import { createAbortError, isCanceledError, streamChatCompletion } from '../network/api.js';
import { listToolsForMode, runTool } from './tools/registry.js';

export const DEFAULT_MAX_TOOL_ROUNDS = 5;
export const TOOL_RESULT_LIMIT = 16 * 1024;
export const CAP_NOTICE = '工具调用轮次已达上限，请直接用文字回答。';

function safeCallback(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch (error) {
    // 信息性 UI 回调抛错不得打断循环。
  }
}

function serializeToolResult(result) {
  const content = typeof result === 'string'
    ? result
    : String((result && result.content) || '');
  if (content.length <= TOOL_RESULT_LIMIT) return content;
  return `${content.slice(0, TOOL_RESULT_LIMIT)}…（已截断）`;
}

// text 为空且有 tool_calls 时 content 置 null：部分兼容端点拒绝空串 content。
function toAssistantMessage(result) {
  const text = typeof result.text === 'string' ? result.text : '';
  const message = { role: 'assistant', content: text.length ? text : null };
  if (Array.isArray(result.toolCalls) && result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return message;
}

export async function runAgentTurn(messages, options = {}) {
  const history = Array.isArray(messages) ? [...messages] : [];
  const mode = options.mode;
  const signal = options.signal || null;
  const onToken = options.onToken;
  const onReasoning = options.onReasoning;
  const onToolEvent = options.onToolEvent;
  // 审批钩子（目前只有 run_shell 用得上）：与 onToolEvent 不同，它必须被 await——
  // 循环要停在这里等用户点头，所以不能塞进那个同步、不 await 的信息性回调。
  // 没接钩子时，requiresConfirmation 的工具在 runTool 里按「未确认」被拒绝。
  const onToolApproval = typeof options.onToolApproval === 'function' ? options.onToolApproval : null;
  const context = options.context || {};
  // 聊天内受控工具（联网搜索）的放行开关：必须一路传到 runTool 的执行门控，
  // 否则暴露层放行了、执行层仍会按工作区模式拒绝，表现为「模型调了但总失败」。
  const allowChatTools = options.allowChatTools === true;
  const maxRounds = Number.isInteger(options.maxRounds) && options.maxRounds > 0
    ? options.maxRounds
    : DEFAULT_MAX_TOOL_ROUNDS;
  const tools = Array.isArray(options.tools) && options.tools.length
    ? options.tools
    : listToolsForMode(mode, { allowChatTools });

  // requestOptions 只承载配置守卫等透传项，不允许夹带 tools/toolChoice。
  const {
    tools: _ignoredTools,
    toolChoice: _ignoredToolChoice,
    ...requestOptions
  } = options.requestOptions || {};

  if (signal && signal.aborted) throw createAbortError();

  if (!tools.length) {
    const result = await streamChatCompletion(history, {
      ...requestOptions,
      signal,
      onChunk: text => safeCallback(onToken, text),
      onReasoning: text => safeCallback(onReasoning, text),
    });
    return typeof result.text === 'string' ? result.text : '';
  }

  let streamedText = '';
  let streamedReasoning = '';
  let round = 0;

  // 跨轮累积：streamChatCompletion 每轮回传该轮全量，这里叠加后再上抛 UI。
  const streamRound = roundTools => streamChatCompletion(history, {
    ...requestOptions,
    signal,
    ...(roundTools && roundTools.length ? { tools: roundTools, toolChoice: 'auto' } : {}),
    onChunk: text => safeCallback(onToken, streamedText + text),
    onReasoning: text => safeCallback(onReasoning, streamedReasoning + text),
  });

  while (round < maxRounds) {
    round += 1;
    if (signal && signal.aborted) throw createAbortError();
    const result = await streamRound(tools);
    streamedText += typeof result.text === 'string' ? result.text : '';
    streamedReasoning += typeof result.reasoning === 'string' ? result.reasoning : '';
    history.push(toAssistantMessage(result));
    const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    if (!toolCalls.length) return streamedText;

    for (const call of toolCalls) {
      if (signal && signal.aborted) throw createAbortError();
      const toolRound = round;
      safeCallback(onToolEvent, { phase: 'start', name: call.name, round: toolRound });
      let outcome;
      try {
        outcome = await runTool(call, {
          signal,
          mode,
          allowChatTools,
          characterId: context.characterId,
          sessionId: context.sessionId,
          // 只有接了钩子才把 confirm 传下去：传 undefined 时 runTool 会拒绝需要
          // 确认的工具，这正是「没有 UI 可以问用户 → 不许执行」的默认。
          ...(onToolApproval ? { confirm: onToolApproval } : {}),
        });
      } catch (error) {
        if (isCanceledError(error) || (signal && signal.aborted)) throw createAbortError();
        outcome = { content: (error && error.message) || '工具执行失败。', isError: true };
      }
      const ok = !(outcome && outcome.isError === true);
      const serialized = serializeToolResult(outcome);
      safeCallback(onToolEvent, {
        phase: 'end',
        name: call.name,
        round: toolRound,
        ok,
        ...(ok ? {} : { error: serialized }),
      });
      history.push({ role: 'tool', tool_call_id: call.id, content: serialized });
    }
  }

  // 上限兜底：整体省略 tools 字段（不发 tool_choice），强制文字收尾。
  history.push({ role: 'system', content: CAP_NOTICE });
  const finalResult = await streamRound(null);
  streamedText += typeof finalResult.text === 'string' ? finalResult.text : '';
  return streamedText;
}