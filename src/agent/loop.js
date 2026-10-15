// Agent 工具调用循环。
//
// 依赖注入面：`streamChatCompletion`（api.js）与工具执行器（tools/registry.js）。
// 循环本身不做持久化，也不直接接触 RN UI。

import { createAbortError, isCanceledError, streamChatCompletion } from '../network/api.js';
// TOOL_RESULT_LIMIT 由 messages.js 定义（序列化就在那里），这里 import 而非再定义一份：
// 2026-10-10 前两处各写 16*1024，改一处漏一处不会报错（审查报告 §0.4 第 2 条）。
// M 系 O1 起序列化是异步的（超限先落盘再头尾预览），用 serializeToolResultAsync。
import { TOOL_RESULT_LIMIT, serializeToolResultAsync, toAssistantMessage } from './messages.js';

// 再导出：loop.js 曾是 TOOL_RESULT_LIMIT 的对外出口（M 系测试从 runAgentTurn 的模块取它）。
// D 系把唯一定义收敛到 messages.js 后，这里保留 re-export 以免调用点/测试拿到 undefined。
export { TOOL_RESULT_LIMIT };
import { listToolsForMode, runTool } from './tools/registry.js';
import { createTurnMachine, createTurnState } from './turn/turnState.js';
import { PLAN_NAG_TEXT, PLAN_TOOL_NAME, shouldNudgePlan } from './planNudge.js';
// P1：K1 工具结果清除（对齐 harness microcompact / dsh pruner）——每轮请求前按预算
// 把「已消费、非工作台、超门槛」的旧工具结果落盘 + 占位，压低上下文体积。
import {
  RESULT_CLEARING_BUDGET_BYTES,
  applyResultClearing,
  planResultClearing,
} from './resultClearing.js';

export const DEFAULT_MAX_TOOL_ROUNDS = 12;

// FEAT-AC7 P0-B：**回合总时长上限**（本文件此前缺失的那一层）。
//
// 已核实的事实（与任务书的措辞不同，故在此写清）：单个 HTTP 请求**有**超时
//（src/network/requestTimeout.js：流式首字节 120s / 空闲 30s / 非流式 300s，
// api.js 的 armIdleTimer 在 send 与每次 onprogress 上挂表）。
// 缺的是**回合级**上限：一轮回合 = 最多 12 轮模型请求 × 每轮最多 4 个模型
//（1 主 + FALLBACK_MODELS_MAX=3 降级链）× 每请求 120s ⇒ 最坏约 **96 分钟**。
// 对用户而言这与「永远卡住」不可区分——截图 #286/287 的「正在调用…」不动就是这个形态。
// 所以补的是**把乘法收成一个上限**，而不是「给请求加超时」（那件事早已存在）。
//
// 取 180s（任务书 §二 P0-B 的取值）：足够一次正常的多轮工具回合跑完，
// 又远小于「用户会以为卡死」的时间尺度。
//
// 为什么不在本层再压一个 60s 首字节超时（任务书 §二 P0-B 的另一半）：那会**比既有
// 策略更严**并造成真回归——requestTimeout.js 的注释明确写着「推理模型思考期间可能
// 几十秒不吐字，放宽到 120s，否则会误报超时」。压到 60s 会把正常的慢思考判成超时。
// 单请求超时沿用既有三档（那是经过审计的取值），本层只补总时长。
export const DEFAULT_TURN_BUDGET_MS = 180000;

// 回合超时的错误：与用户主动中止**必须可区分**（前者要如实报「超时未响应」，
// 后者是用户的意图，不该报错——见 workspaceWatchTurn 的收尾分流）。
export function createTurnTimeoutError({ model = '', round = 0, elapsedMs = 0 } = {}) {
  const seconds = Math.max(1, Math.round(Number(elapsedMs) / 1000));
  const error = new Error(
    `回合超时（${seconds}s 未完成）：模型 ${model || '未知'}，卡在第 ${round || '?'} 轮。`
    + '可换一个更快的模型，或把任务拆小后重试。'
  );
  error.name = 'TurnTimeoutError';
  error.timedOut = true;
  error.model = String(model || '');
  error.round = Number(round) || 0;
  return error;
}
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
  // P1（2026-10-11）：工作区钩子的 before_tool / before_shell 规则（deny / ask）。
  // **必须单独一路传下去**：审批钩子只在「需要确认的工具」上被调用，而钩子规则的语义是
  // 「拦下任意工具」——写工具按设计不逐条确认，只接 onToolApproval 等于规则永不生效。
  // 允许传函数（每次调用时取，宿主据此读到最新的 hooks.json）。
  const permissionRules = typeof options.permissionRules === 'function' || Array.isArray(options.permissionRules)
    ? options.permissionRules
    : null;
  // ask_user：宿主注入「问用户」钩子（提选择题、等回答）；不注入 = 工具不可用。
  const onAskUser = typeof options.onAskUser === 'function' ? options.onAskUser : null;
  // AS2：confirm_flow 的多题确认钩子（宿主注入；不注入 = 工具按「问不到 = 不执行」拒绝）。
  // choices 是配套的宿主选项源（list 题只写 source 名，真实选项由它注入）。
  const onConfirmFlow = typeof options.onConfirmFlow === 'function' ? options.onConfirmFlow : null;
  const choicesSource = typeof options.choices === 'function' ? options.choices : null;
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
  // P0-7：降级链换模型的通知（宿主注入；不注入 = 静默重试，行为与旧版一致）。
  // 只是信息性回调，重试本身由 streamChatCompletion 决定，这里不参与判定。
  const onModelFallback = typeof options.onModelFallback === 'function' ? options.onModelFallback : null;
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

  // FEAT-AC7 P0-B/P0-D：回合总时长上限 + 回合打点。
  //
  // 实现要点：**不改调用方传进来的 signal**，而是派生一个「本回合的有效信号」——
  // 到点 abort 它。这样：
  //   · 调用方的 signal（用户点「停止」）语义逐字不变；
  //   · 超时中止与用户中止在**抛出物**上可区分（前者 TurnTimeoutError，后者 AbortError），
  //     宿主据此给「超时未响应」而不是「已停止」——两者对用户的含义完全不同。
  const turnBudgetMs = Number.isFinite(Number(options.turnBudgetMs)) && Number(options.turnBudgetMs) > 0
    ? Number(options.turnBudgetMs)
    : DEFAULT_TURN_BUDGET_MS;
  const onTurnEvent = typeof options.onTurnEvent === 'function' ? options.onTurnEvent : null;
  const emitTurnEvent = (event, fields) => safeCallback(onTurnEvent, { event, ...fields });
  const turnStartedAt = Date.now();
  // 记录「当前正在跑哪一轮 / 哪个模型」，供超时错误与打点说出卡点。
  let currentRound = 0;
  let currentModel = '';
  let timedOut = false;
  const budgetController = typeof AbortController === 'function' ? new AbortController() : null;
  const budgetTimer = budgetController
    ? setTimeout(() => {
      timedOut = true;
      budgetController.abort();
    }, turnBudgetMs)
    : null;
  // 组合信号：调用方 signal 或超时任一触发都中止。
  //
  // ⚠️ 不用 AbortSignal.any：它在 Hermes/旧 RN 上未必存在（本仓 no-undef 门禁直接报
  // 「AbortSignal is not defined」——那正是它在 RN 全局里不保证可用的信号）。
  // 手工转发两个来源，行为等价且到处都能跑。
  let detachCallerSignal = null;
  const effectiveSignal = budgetController
    ? (() => {
      if (!signal) return budgetController.signal;
      const controller = budgetController;
      const onCallerAbort = () => controller.abort();
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onCallerAbort);
        detachCallerSignal = () => signal.removeEventListener('abort', onCallerAbort);
        if (signal.aborted) controller.abort();
      } else if (signal.aborted) {
        controller.abort();
      }
      return controller.signal;
    })()
    : signal;
  const clearBudget = () => {
    if (budgetTimer) clearTimeout(budgetTimer);
    if (detachCallerSignal) {
      try {
        detachCallerSignal();
      } catch (error) {}
      detachCallerSignal = null;
    }
  };
  // 超时/中止的统一抛出点：把「为什么停」翻译成调用方能分辨的错误。
  const throwIfStopped = () => {
    if (timedOut) {
      throw createTurnTimeoutError({
        model: currentModel,
        round: currentRound,
        elapsedMs: Date.now() - turnStartedAt,
      });
    }
    if (effectiveSignal && effectiveSignal.aborted) throw createAbortError();
  };
  emitTurnEvent('turn-start', { round: 0, model: currentModel || undefined });

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

  if (effectiveSignal && effectiveSignal.aborted) throwIfStopped();

  if (!tools.length) {
    machine.startModelRequest();
    const result = await streamChatCompletion(history, {
      ...requestOptions,
      signal: effectiveSignal,
      onChunk: text => safeCallback(onToken, text),
      onReasoning: text => safeCallback(onReasoning, text),
      ...(onModelFallback ? { onModelFallback } : {}),
    });
    const text = typeof result.text === 'string' ? result.text : '';
    machine.receiveModelResponse(text);
    machine.complete(text);
    if (result && result.usage && onUsage) safeCallback(onUsage, { round: 1, model: result.model, ...result.usage });
    clearBudget();
    emitTurnEvent('turn-done', { round: 1, model: (result && result.model) || undefined, elapsed: Date.now() - turnStartedAt });
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
    signal: effectiveSignal,
    ...(roundTools && roundTools.length ? { tools: roundTools, toolChoice: 'auto' } : {}),
    onChunk: text => safeCallback(onToken, streamedText + text),
    onReasoning: text => safeCallback(onReasoning, streamedReasoning + text),
    ...(onModelFallback ? { onModelFallback } : {}),
  });

  // I1：收束预警的"已提醒"标记（从轮号判断改为标记式——Steering 注入后允许再提醒
  // 一次：模型看到新目标后，旧的收束判断会误导，值得重新收束）。
  let budgetWarned = false;
  // P5（2026-10-11 P1）：**中止路径也要回抛 transcript**。宿主（useChatSend.js）只在
  // 成功路径 attach toolTrace，而中止是从循环里直接抛出的（signal.aborted 检查 / runTool
  // 抛 AbortError）——不在这里兜一把，被中止那一轮已经发生的工具调用轨迹就全丢了。
  // 已发生的调用是**事实**（副作用可能已经落地），丢了它下一轮组装请求时看不到自己做过什么。
  try {
    while (round < maxRounds) {
      round += 1;
      currentRound = round;
      if (effectiveSignal && effectiveSignal.aborted) throwIfStopped();
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
      machine.startModelRequest();
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
      const result = await streamRound(tools);
      const roundText = typeof result.text === 'string' ? result.text : '';
      machine.receiveModelResponse(roundText);
      streamedText += roundText;
      streamedReasoning += typeof result.reasoning === 'string' ? result.reasoning : '';
      // P0-D：记下本轮实际产出内容的模型（降级后可能与主模型不同）——超时错误要能说出
      // 「卡在哪个模型」，那是用户换模型重试的直接依据。
      if (result && result.model) currentModel = String(result.model);
      // E1：usage 上抛（端点在每轮 SSE 尾部返回时才有）——回调抛错不影响主流程。
      if (result && result.usage && onUsage) safeCallback(onUsage, { round, model: result.model, ...result.usage });
      history.push(toAssistantMessage(result));
      const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      if (!toolCalls.length) {
        machine.complete(streamedText);
        emitTranscript();
        clearBudget();
        emitTurnEvent('turn-done', { round, model: currentModel || undefined, elapsed: Date.now() - turnStartedAt });
        return streamedText;
      }
      machine.scheduleTools(toolCalls);
      machine.startToolExecution();

      // E2：本轮签名收集——与上一轮相同（或本轮内重复）的调用会被 nudge（不阻断）。
      let hasRepeatedCall = false;
      let planUpdatedThisRound = false;
      const signaturesThisRound = new Set();
      for (const call of toolCalls) {
        if (effectiveSignal && effectiveSignal.aborted) throwIfStopped();
        const signature = toolCallSignature(call);
        if (lastRoundSignatures.has(signature) || signaturesThisRound.has(signature)) {
          hasRepeatedCall = true;
        }
        signaturesThisRound.add(signature);
        const toolRound = round;
        // P0-D：工具打点（info 级）——「卡在哪个工具」是排查的第一步。
        const toolStartedAt = Date.now();
        emitTurnEvent('turn-tool', { round: toolRound, tool: call.name });
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
            signal: effectiveSignal,
            mode,
            allowChatTools,
            characterId: context.characterId,
            sessionId: context.sessionId,
            // 只有接了钩子才把 confirm 传下去：传 undefined 时 runTool 会拒绝需要
            // 确认的工具，这正是「没有 UI 可以问用户 → 不许执行」的默认。
            ...(onToolApproval ? { confirm: onToolApproval } : {}),
            ...(permissionRules ? { permissionRules } : {}),
            ...(onAskUser ? { ask: onAskUser } : {}),
            ...(onConfirmFlow ? { confirmFlow: onConfirmFlow } : {}),
            ...(choicesSource ? { choices: choicesSource } : {}),
            ...(onToolResult ? { onToolResult } : {}),
          });
        } catch (error) {
          if (isCanceledError(error) || (effectiveSignal && effectiveSignal.aborted)) throwIfStopped();
          outcome = { content: (error && error.message) || '工具执行失败。', isError: true };
        }
        // 工具耗时进打点：某工具一直不返回时，这条是唯一能指出它的记录。
        emitTurnEvent('turn-tool', {
          round: toolRound,
          tool: call.name,
          elapsed: Date.now() - toolStartedAt,
        });
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
        // P0 加固：把权威错误标记随 tool 消息带下去（供 toolTrace 保留 → 展示层判状态）。
        // API 侧的工具消息是**显式构造**的（apiProtocols/messages.js），此字段不会进请求体。
        //
        // 界面侧提示（toolDefs/toolNotices.js）：content 是给模型读的中文正文（一个字都不改），
        // noticeKey/noticeParams 是**同一句话的界面侧词条引用**，给工作区工具行按当前语言渲染。
        // 与 isError 同款随 tool 消息带下去，extractToolTrace 才能把它搬到展示层。
        //
        // 这两个字段同样是**内部字段，绝不能进请求体**——三条发送路径现在口径统一
        //（2026-10-12 核实，白名单口径）：anthropic / openai-responses 由 toAnthropicRequest /
        // toResponsesRequest 逐条显式构造（只取 content / tool_call_id），天然不进；
        // openai（chat completions）的 toOpenAiMessages 也已从「整体展开 + 黑名单剥离」
        // 改成**白名单（默认拒绝）**——只搬 apiProtocols/messages.js 的 OPENAI_MESSAGE_FIELDS
        // 里列出的协议字段。故 isError / noticeKey / noticeParams 属内部字段，**天然不出网**，
        // 新增内部字段也无需登记任何「内部字段名单」（已无该名单）。
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: serialized,
          isError: !ok,
          // 缺失时不造 undefined 键：老形态/无提示的工具保持「无该字段」，展示层回落中文正文。
          // 判据是正向的（`outcome && … !== undefined`）——反向写会在 outcome 为空时读它抛错。
          ...(outcome && outcome.noticeKey !== undefined ? { noticeKey: outcome.noticeKey } : {}),
          ...(outcome && outcome.noticeParams !== undefined ? { noticeParams: outcome.noticeParams } : {}),
        });
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
    clearBudget();
    emitTurnEvent('turn-done', { round, model: currentModel || undefined, elapsed: Date.now() - turnStartedAt });
    return streamedText;
  } catch (error) {
    // 中止（或任何抛出）之前已经发生的工具调用与结果都是事实，必须回抛给宿主持久化。
    // emitTranscript 自身不抛（safeCallback 包着），不会把原错误盖掉。
    emitTranscript();
    // P0-D：把「这轮怎么结束的」写进打点——超时与中止都带耗时，日志里能直接看出卡了多久。
    if (error && error.timedOut === true) {
      emitTurnEvent('turn-timeout', {
        round: currentRound,
        model: currentModel || undefined,
        elapsed: Date.now() - turnStartedAt,
        error,
      });
    }
    throw error;
  } finally {
    // 无论如何都要清掉回合预算计时器：留着会让一个已结束的回合在 180s 后
    // abort 一个复用的 signal（若调用方把同一 signal 用于后续回合，会莫名中止）。
    clearBudget();
  }
}
