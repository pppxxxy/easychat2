// Agent 工具调用循环。
//
// 依赖注入面：`streamChatCompletion`（api.js）与工具执行器（tools/registry.js）。
// 循环本身不做持久化，也不直接接触 RN UI。

import { createAbortError, isCanceledError, streamChatCompletion } from '../network/api.js';
import { serializeToolResultAsync, toAssistantMessage } from './messages.js';
import { listToolsForMode, runTool } from './tools/registry.js';
import { PLAN_NAG_TEXT, PLAN_TOOL_NAME, shouldNudgePlan } from './planNudge.js';
// P1：K1 工具结果清除（对齐 harness microcompact / dsh pruner）——每轮请求前按预算
// 把「已消费、非工作台、超门槛」的旧工具结果落盘 + 占位，压低上下文体积。
import {
  RESULT_CLEARING_BUDGET_BYTES,
  applyResultClearing,
  planResultClearing,
} from './resultClearing.js';
import { createTurnMachine, createTurnState } from './turn/turnState.js';

export const DEFAULT_MAX_TOOL_ROUNDS = 12;
export const TOOL_RESULT_LIMIT = 16 * 1024;
// 两段式预算提醒的第一段（能力升级任务书 A1）：剩 2 轮时注入——模型还有机会把已有
// 信息整理成结论，而不是被下面那句 CAP_NOTICE 硬截断在工具调用中间。
export const ROUND_BUDGET_WARNING = '轮次预算还剩 2 轮，请开始收束：先把已确认的信息整理成结论，需要补的工具调用只做最关键的。';
export const CAP_NOTICE = '工具调用轮次已达上限，请直接用文字回答。';

// E2：重复调用护栏（非阻断）——同工具同参数在上一轮刚调用过、本轮又来一次时，
// 轮末注入一条提醒。**只 nudge 不阻断**：模型可能确实需要重试（比如文件刚被
// 外部改动过），阻断会让正常路径死锁；提醒已足以打断「无意识复读」。
export const REPEAT_CALL_NUDGE = '注意：有工具调用与上一轮参数完全相同。相同参数刚刚调用过——'
  + '如果结果已满足需要，请直接给结论；如确需重试，请换参数或说明为什么要重试。';

// 稳定序列化（键排序）：{a:1,b:2} 与 {b:2,a:1} 是同一组参数，签名必须一致，
// 否则键序抖动会漏检。只处理 JSON 可表示的值（工具参数本来就是 JSON）。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// 工具调用签名（name + 稳定化参数）——E2 重复检测的判据，纯函数可测。
// arguments 兼容两种形态：JSON 字符串（模型原生输出）或已解析对象（宿主直调）。
export function toolCallSignature(call) {
  const name = String((call && call.name) || '');
  let args = call && call.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (error) {
      // 非 JSON 的 arguments（模型输出了半截）保留原文参与签名——同样值得检出。
    }
  }
  let normalized;
  try {
    normalized = stableStringify(args === undefined ? null : args);
  } catch (error) {
    normalized = String(args);
  }
  return `${name}:${normalized}`;
}

// 按场景的轮次预算：写任务天然更长（改-验循环要反复迭代），只读研究次之，其余用默认。
// 管道（options.maxRounds）早已存在，这里只提供统一取值，避免各调用点各写各的数字。
export function workspaceRoundBudget(mode) {
  if (mode === 'write') return 16;
  if (mode === 'read') return 10;
  return DEFAULT_MAX_TOOL_ROUNDS;
}

// A3 二期：工具调用参数 → 对象（解析失败给 null）。onToolEvent 的 start 事件
// 带上它——订阅方（计划进度条）需要 update_plan 的 plan 内容。
// 注意：参数**可能很大**（write 类工具带全文），是引用传递零额外成本，但订阅方
// 只应按需读取（如只看 update_plan），不要整体存储。
export function parseToolArgs(call) {
  const raw = call && call.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function safeCallback(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch (error) {
    // 信息性 UI 回调抛错不得打断循环。
  }
}

export async function runAgentTurn(messages, options = {}) {
  const history = Array.isArray(messages) ? [...messages] : [];
  const requestLength = history.length;
  // 把本轮追加的 agent 消息（assistant(tool_calls) + tool 结果）回抛宿主持久化。
  const emitTranscript = () => {
    if (onTranscript) safeCallback(onTranscript, history.slice(requestLength));
  };
  const mode = options.mode;
  const signal = options.signal || null;
  const onToken = options.onToken;
  const onReasoning = options.onReasoning;
  const onToolEvent = options.onToolEvent;
  // 审批钩子（目前只有 run_shell 用得上）：与 onToolEvent 不同，它必须被 await——
  // 循环要停在这里等用户点头，所以不能塞进那个同步、不 await 的信息性回调。
  // 没接钩子时，requiresConfirmation 的工具在 runTool 里按「未确认」被拒绝。
  const onToolApproval = typeof options.onToolApproval === 'function' ? options.onToolApproval : null;
  // D4-1：结果增强钩子（宿主注入；不注入 = 不增强，行为与旧版一致）。
  const onToolResult = typeof options.onToolResult === 'function' ? options.onToolResult : null;
  // O1：超限结果落盘钩子（宿主注入：写工作区 + 返回 { path }；不注入 = 退回头尾保留）。
  const persistToolResult = typeof options.persistToolResult === 'function' ? options.persistToolResult : null;
  // P1：上下文字节预算（宿主可传「窗口比例」换算后的值；默认 2MB）。
  const contextBudgetBytes = Number.isFinite(Number(options.contextBudgetBytes)) && Number(options.contextBudgetBytes) > 0
    ? Number(options.contextBudgetBytes)
    : RESULT_CLEARING_BUDGET_BYTES;
  // P5：本轮追加的 agent 消息（含 tool 消息）回抛给宿主持久化（transcript 轨迹）。
  const onTranscript = typeof options.onTranscript === 'function' ? options.onTranscript : null;
  // E1：usage 回调（缓存命中观测）——每轮结果里的 usage 原样上抛给宿主累计；
  // 端点不返回 usage 时该回调根本不会被调用（调用方必须容忍零次）。
  const onUsage = typeof options.onUsage === 'function' ? options.onUsage : null;
  // I1：Steering 队列（宿主注入；不注入 = 无中途指令，行为与旧版一致）。
  // 约定对象：{ drain(): string[] }——宿主用 createSteeringQueue() 创建。
  const steering = options.steering && typeof options.steering.drain === 'function'
    ? options.steering
    : null;
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

  // 阶段记账（Z 系采纳 #4）：显式状态机，非法转移直接抛错——不再靠局部变量隐式表达。
  const machine = createTurnMachine(createTurnState({
    sessionId: context.sessionId,
    turnNumber: 1,
    input: '',
  }));
  machine.start();

  if (signal && signal.aborted) throw createAbortError();

  if (!tools.length) {
    machine.startModelRequest();
    const result = await streamChatCompletion(history, {
      ...requestOptions,
      signal,
      onChunk: text => safeCallback(onToken, text),
      onReasoning: text => safeCallback(onReasoning, text),
    });
    const text = typeof result.text === 'string' ? result.text : '';
    machine.receiveModelResponse(text);
    machine.complete(text);
    if (result && result.usage && onUsage) safeCallback(onUsage, { round: 1, ...result.usage });
    return text;
  }

  let streamedText = '';
  let streamedReasoning = '';
  let round = 0;
  // E2：上一轮的工具调用签名集合（重复调用检测的比对基准）。
  let lastRoundSignatures = new Set();
  // O0.2：计划纪律——最近一次 update_plan 的参数 + 距上次更新已过几轮。
  let latestPlanArgs = null;
  let roundsSincePlanUpdate = 0;

  // 跨轮累积：streamChatCompletion 每轮回传该轮全量，这里叠加后再上抛 UI。
  const streamRound = roundTools => streamChatCompletion(history, {
    ...requestOptions,
    signal,
    ...(roundTools && roundTools.length ? { tools: roundTools, toolChoice: 'auto' } : {}),
    onChunk: text => safeCallback(onToken, streamedText + text),
    onReasoning: text => safeCallback(onReasoning, streamedReasoning + text),
  });

  // I1：收束预警的"已提醒"标记（从轮号判断改为标记式——Steering 注入后允许再提醒
  // 一次：模型看到新目标后，旧的收束判断会误导，值得重新收束）。
  let budgetWarned = false;
  while (round < maxRounds) {
    round += 1;
    if (signal && signal.aborted) throw createAbortError();
    // I1：Steering——每轮模型请求前取出用户中途补充的指令，以 system 小段注入。
    // 不中断当前工具链（工具调用的配对结构完整），只是让模型下一轮决策纳入新目标。
    if (steering) {
      const additions = steering.drain();
      if (Array.isArray(additions) && additions.length > 0) {
        for (const text of additions) {
          history.push({ role: 'system', content: `用户中途补充：${text}，请在后续决策中纳入。` });
        }
        budgetWarned = false; // 新目标 → 允许收束预警再提一次
      }
    }
    // P1：K1 挂载——本轮请求前，上下文超预算时把旧工具结果落盘 + 占位。
    // 只改 content、绝不拆散 tool_use↔tool_result；落盘失败保原文。无 persist 钩子则跳过。
    if (persistToolResult) {
      const plan = planResultClearing(history, { budgetBytes: contextBudgetBytes });
      if (plan.indices.length) {
        const cleared = await applyResultClearing(history, plan.indices, { persist: persistToolResult });
        for (const entry of cleared.cleared) {
          history[entry.index] = cleared.messages[entry.index];
        }
      }
    }
    machine.startModelRequest();
    const result = await streamRound(tools);
    const roundText = typeof result.text === 'string' ? result.text : '';
    machine.receiveModelResponse(roundText);
    streamedText += roundText;
    streamedReasoning += typeof result.reasoning === 'string' ? result.reasoning : '';
    // E1：usage 上抛（端点在每轮 SSE 尾部返回时才有）——回调抛错不影响主流程。
    if (result && result.usage && onUsage) safeCallback(onUsage, { round, ...result.usage });
    history.push(toAssistantMessage(result));
    const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    if (!toolCalls.length) {
      machine.complete(streamedText);
      emitTranscript();
      return streamedText;
    }
    machine.scheduleTools(toolCalls);
    machine.startToolExecution();

    // E2：本轮签名收集——与上一轮相同（或本轮内重复）的调用会被 nudge（不阻断）。
    let hasRepeatedCall = false;
    let planUpdatedThisRound = false;
    const signaturesThisRound = new Set();
    for (const call of toolCalls) {
      if (signal && signal.aborted) throw createAbortError();
      const signature = toolCallSignature(call);
      if (lastRoundSignatures.has(signature) || signaturesThisRound.has(signature)) {
        hasRepeatedCall = true;
      }
      signaturesThisRound.add(signature);
      const toolRound = round;
      // A3 二期：start 事件带解析后的参数（订阅方按需读——计划进度条读 update_plan）。
      safeCallback(onToolEvent, {
        phase: 'start',
        name: call.name,
        round: toolRound,
        args: parseToolArgs(call),
      });
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
          ...(onToolResult ? { onToolResult } : {}),
        });
      } catch (error) {
        if (isCanceledError(error) || (signal && signal.aborted)) throw createAbortError();
        outcome = { content: (error && error.message) || '工具执行失败。', isError: true };
      }
      const ok = !(outcome && outcome.isError === true);
      // O0.2：记录计划更新（成功调用了 update_plan）——重置「未更新」计数。
      if (call.name === PLAN_TOOL_NAME && ok) {
        latestPlanArgs = parseToolArgs(call);
        roundsSincePlanUpdate = 0;
        planUpdatedThisRound = true;
      }
      // D2/O1：序列化工具结果。超限时若宿主提供 persistToolResult，先把整份落盘再
      // 用「头尾预览 + 指针」替换（信息只移不丢）；否则退回 D2 头尾保留。
      const serialized = await serializeToolResultAsync(outcome, {
        limit: TOOL_RESULT_LIMIT,
        toolName: call && call.name,
        toolCallId: call && call.id,
        persist: persistToolResult,
      });
      safeCallback(onToolEvent, {
        phase: 'end',
        name: call.name,
        round: toolRound,
        ok,
        ...(ok ? {} : { error: serialized }),
      });
      history.push({ role: 'tool', tool_call_id: call.id, content: serialized });
      machine.completeTool(call.id, { success: ok, content: serialized });
    }

    // 预算预警（两段式第一段）：进入「还剩 2 轮」窗口起提示收束（标记式——
    // I1 起 Steering 注入会重置标记，允许新目标下再提醒一次）。放在轮末：
    // 只有「还会继续循环」才会走到这里（提前给出结论的那轮在上面就 return 了）。
    if (!budgetWarned && round >= maxRounds - 2) {
      history.push({ role: 'system', content: ROUND_BUDGET_WARNING });
      budgetWarned = true;
    }
    // E2：重复调用 nudge（轮末注入，与预算预警同款位置——不打断 tool_calls 与
    // tool 结果的配对结构，模型在下一轮开头看到）。
    if (hasRepeatedCall) {
      history.push({ role: 'system', content: REPEAT_CALL_NUDGE });
    }
    // O0.2：计划未更新 nag——有未完成步骤且连续多轮没更新时，轮末注入一行提醒。
    // 注入后重置计数，避免此后每轮都提醒（每满阈值轮提醒一次）。
    if (!planUpdatedThisRound) roundsSincePlanUpdate += 1;
    if (shouldNudgePlan({ planArgs: latestPlanArgs, roundsSinceUpdate: roundsSincePlanUpdate })) {
      history.push({ role: 'system', content: PLAN_NAG_TEXT });
      roundsSincePlanUpdate = 0;
    }
    lastRoundSignatures = signaturesThisRound;
    machine.aggregateResults();
  }

  // 上限兜底：整体省略 tools 字段（不发 tool_choice），强制文字收尾。
  machine.startModelRequest();
  history.push({ role: 'system', content: CAP_NOTICE });
  const finalResult = await streamRound(null);
  const finalText = typeof finalResult.text === 'string' ? finalResult.text : '';
  machine.receiveModelResponse(finalText);
  streamedText += finalText;
  machine.complete(streamedText);
  emitTranscript();
  return streamedText;
}