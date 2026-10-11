// 子代理（run_subagent 工具的实现，spec 2026-10-09-agent-extensibility T8）。
//
// 干什么：把一次「研究型子任务」（翻很多文件找答案）放进**独立的 agent 循环**——
// 子代理自己读文件、自己多轮迭代，只把整理好的结论交回主对话。中间过程（几十个
// 文件内容与工具结果）不进入主对话的上下文，这是它存在的全部理由。
//
// 两条硬边界（结构性保证，不是靠"记得别给"）：
// 1. **只读**：工具表按 SUBAGENT_TOOL_NAMES **名字白名单**过滤——注意 run_subagent
//    自己也是 readOnly:true 的工具，只看 readOnly 标志会把它放进来 → 无限递归。
//    所以这里按名字收，且名单里永远不含 run_subagent。
// 2. **不得递归**：本模块**不接触全局注册表**（registry）——子代理看不到、也拿不到
//    注册表里有什么；工具由调用方（tools.js）以只读三项过滤后注入。
//
// 循环结构与主循环（loop.js）同款：stream → 有 toolCalls 就执行并回填 → 直到给出
// 文字结论或到轮次上限。子代理**不往 UI 抛 token**（两路文字混在一起没法看），
// 只通过 onEvent 报工具开始/结束，供调用方决定要不要显示。
//
// 模型与配置：沿用 streamChatCompletion 的默认取配置路径（与主循环同一份活动配置）。
// **惰性 require**（不用静态 import）：本模块被工作区工具定义静态引用，而工具定义的
// 测试在纯 Node 里跑——静态拉起网络层会把 expo-file-system 一并拖进来直接炸。
// 拿不到网络层时子代理如实报「不可用」，而不是让整个模块加载失败（与 shell.js 同款）。

import { serializeToolResult, toAssistantMessage } from './messages.js';
import { boardPromptSuffix } from './blackboard.js';

let cachedStream;
function resolveDefaultStream() {
  if (cachedStream !== undefined) return cachedStream;
  try {
    cachedStream = require('../network/api.js').streamChatCompletion;
  } catch (error) {
    cachedStream = null;
  }
  return cachedStream;
}

// 中止错误自建（不依赖网络层）：语义与 api.js 的 AbortError 一致（canceled 标记）。
function makeAbortError() {
  const error = new Error('已停止生成');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

function isAbortError(error) {
  return !!error && (error.canceled === true || error.name === 'AbortError');
}

export const SUBAGENT_MAX_ROUNDS = 6;
export const SUBAGENT_RESULT_LIMIT = 8 * 1024;
export const SUBAGENT_TOOL_RESULT_LIMIT = 8 * 1024;
// 名字白名单：**永远不含 run_subagent**（防递归的第一道结构保证）。
export const SUBAGENT_TOOL_NAMES = Object.freeze(['list_workspace_files', 'read_workspace_file', 'search_workspace']);
// 写子代理（opt-in，mode:'write'）额外允许的写工具：**永远不含 run_subagent / 执行类
// （run_shell/run_python）/ 远端类**——防递归 + 防越权。每次写都需宿主逐条审批。
export const SUBAGENT_WRITE_TOOL_NAMES = Object.freeze(['write_workspace_file', 'edit_workspace_file', 'create_workspace_dir']);
export const SUBAGENT_SYSTEM_PROMPT = [
  '你是「研究工作区」的子代理：只能读取工作区文件（不能修改任何东西），',
  '任务是把研究工作做完后交回**结论**。',
  '用 list_workspace_files 了解结构、用 search_workspace 定位、用 read_workspace_file 读内容（大文件可分段读）。',
  '完成后用简洁中文给出结论：先直接回答，再列关键依据（含文件路径）。',
  '不要复述检索过程，不要说「我读了哪些文件」——只交回结论本身。',
].join('');

// write 模式（opt-in）的系统提示：可改文件，但每次写都要用户确认；未批准不要重试。
export const SUBAGENT_WRITE_SYSTEM_PROMPT = [
  '你是「工作区执行」的子代理：可以读取并**修改**工作区文件（不能调用 shell/python）。',
  '每一次写操作（write/edit/create_dir）都会先请用户确认——被拒绝时不要重试同一改动，',
  '改走别的思路或如实说明无法完成。',
  '任务是把子任务做完后交回**结论**：先用 list/search/read 了解现状，再用写工具落地改动。',
  '完成后用简洁中文给出结论：先直接回答，再列关键改动（含文件路径）。不要复述过程。',
].join('');

function toFunctionSchema(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

// 子代理循环。stream 可注入（测试用假流）。返回 { content, isError }。
export async function runSubagent({
  task,
  tools,
  store,
  characterId,
  signal = null,
  requestOptions = {},
  stream = null,
  maxRounds = SUBAGENT_MAX_ROUNDS,
  onEvent = null,
  mode = 'read',
  workspaceMode = '',
  confirm = null,
  // 团队通信：同一批次的多个分身共享一块黑板（blackboard.js）。extraTools 是随黑板
  // 一起注入的额外工具（board_post/board_read），agentName 是发布者署名。
  board = null,
  extraTools = [],
  agentName = '',
} = {}) {
  // P0-2（纵深防御第二层）：run_subagent / run_workflow 自身都是 readOnly 工具，**在 READ 模式
  // 也能被模型调用**；而本函数内部直接调 tool.execute，绕过了 registry.canRunTool 的模式闸门
  //（本模块按设计不接触全局注册表）。于是「READ 模式 + run_subagent{mode:'write'}」曾能落盘，
  // 且按 P0-1 之前连确认都不会问。
  //
  // 因此这里**不信调用方**：write 模式必须由宿主明确声明「当前是可改模式」才放行。
  // 第一层闸门在 workspace/toolDefs/subagentTool.js 与 workflowTool.js（同样判 workspaceMode），
  // 这里再判一次是纵深防御——任一层被漏改，写操作仍然进不来。
  if (mode === 'write' && workspaceMode !== 'write') {
    return { content: '写子代理不可用：当前不是「可改」模式（未执行）。', isError: true };
  }
  const text = String(task == null ? '' : task).trim();
  if (!text) return { content: '子任务描述为空。', isError: true };
  const streamFn = stream || resolveDefaultStream();
  if (typeof streamFn !== 'function') {
    return { content: '子代理不可用（网络层不可达）。', isError: true };
  }
  // 名字白名单 + 可执行性：名单外的工具（含 run_subagent 自己）在这里被物理挡下。
  // write 模式在只读名单上叠加写名单（仍不含 run_subagent / 执行类）。extraToolNames
  // 是随黑板注入的额外工具名（board_post/board_read）——只加名字，工具实体仍由调用方传。
  const extraToolNames = (Array.isArray(extraTools) ? extraTools : [])
    .map(item => String((item && item.name) || ''))
    .filter(Boolean);
  const allowedNames = mode === 'write'
    ? [...SUBAGENT_TOOL_NAMES, ...SUBAGENT_WRITE_TOOL_NAMES, ...extraToolNames]
    : [...SUBAGENT_TOOL_NAMES, ...extraToolNames];
  const usable = (Array.isArray(tools) ? tools : []).filter(item => (
    item
    && allowedNames.includes(String(item.name || ''))
    && typeof item.execute === 'function'
  ));
  if (!store || usable.length === 0) {
    return { content: '子代理不可用（缺少工作区存储或只读工具）。', isError: true };
  }

  const schemas = usable.map(toFunctionSchema);
  const basePrompt = mode === 'write' ? SUBAGENT_WRITE_SYSTEM_PROMPT : SUBAGENT_SYSTEM_PROMPT;
  const history = [
    { role: 'system', content: board ? `${basePrompt}${boardPromptSuffix()}` : basePrompt },
    { role: 'user', content: text },
  ];
  const emit = payload => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(payload);
    } catch (error) {}
  };

  // 结论只取**结论轮**（无工具调用的那一轮）的文本：前面各轮的文字是「我先看看
  // 目录…」这类过渡语，拼进来会漏给主对话——提示词压不住不老实的模型，这里
  // 结构上直接不采。lastText 只服务异常兜底（达轮次上限时没有结论轮）。
  let conclusionText = '';
  let lastText = '';
  let round = 0;
  let capped = false;
  let lastError = '';
  // P1（2026-10-11）：本轮子代理里**失败的工具调用**计数。子代理「跑完了」不等于
  // 「做成了」——写工具被拒（用户没批 / 问不到用户）时它照样会产出一段结论文字，
  // 调用方若只看 content 就会把「没写的」当成「写成了」。计数上抛给编排层判定。
  let toolErrors = 0;
  while (round < maxRounds) {
    round += 1;
    if (signal && signal.aborted) throw makeAbortError();
    const result = await streamFn(history, {
      ...requestOptions,
      signal,
      tools: schemas,
      toolChoice: 'auto',
    });
    const roundText = typeof (result && result.text) === 'string' ? result.text : '';
    if (roundText.trim()) lastText = roundText;
    history.push(toAssistantMessage(result));
    const calls = Array.isArray(result && result.toolCalls) ? result.toolCalls : [];
    if (calls.length === 0) {
      conclusionText = roundText;
      capped = false;
      break;
    }
    if (round >= maxRounds) {
      // 最后一轮还在调工具：不再执行，直接收尾（省一次无意义的工具调用）。
      capped = true;
      break;
    }
    for (const call of calls) {
      if (signal && signal.aborted) throw makeAbortError();
      emit({ phase: 'start', name: call.name, round });
      let outcome;
      try {
        const tool = usable.find(item => item.name === call.name);
        if (!tool) throw new Error(`子代理不允许调用工具：${call.name}`);
        let args = {};
        try {
          args = call.arguments === undefined || call.arguments === null || call.arguments === ''
            ? {}
            : JSON.parse(call.arguments);
        } catch (error) {
          args = {};
        }
        // 写子代理：需要确认的工具**逐条**先问用户，未批准则不执行（与主循环同款纪律）。
        //
        // 判据是 `readOnly !== true`（fail-closed），**不是**只看 `requiresConfirmation`：
        // 真实写工具（workspace/toolDefs/writeTools.js 的三个）只声明 `readOnly: false`，
        // 从不声明 requiresConfirmation——只看那个字段等于「写操作直接执行」，而本文件与
        // subagentTool / workflowTool 的文案都写着「每一次写操作都会先请用户确认」
        //（2026-10-11 逐行审查 P0-1：该分支曾是死代码）。
        //
        // 为什么挂在 readOnly 上而不是「给三个写工具加 requiresConfirmation」：
        //   1) readOnly 本来就是**安全字段**——注册表的模式门控（canRunTool）靠它，
        //      新写工具必须正确声明它才可能被放行，因此这个判据不会随「忘记加标志」再次失效；
        //   2) 给写工具定义加 requiresConfirmation 会**连带改变主循环**（tools.js 透传该字段，
        //      runTool 随即对每次写入弹审批），与 paths.js 明文记录的设计相反：
        //      「写工具（write_workspace_file / edit_workspace_file）不需要逐条确认，
        //        因此根本不走权限规则求值」。
        // 取 `!== true` 而非 `=== false`：readOnly 缺失/写错的工具按「可能写」处理（fail-closed），
        // 宁可多问一次，不可静默放行。
        const needsConfirm = tool.requiresConfirmation === true || tool.readOnly !== true;
        if (needsConfirm && typeof confirm !== 'function') {
          outcome = { content: '该工具需要用户确认，但当前环境无法询问用户（未执行）。', isError: true };
        } else if (needsConfirm) {
          const approved = await confirm({ name: call.name, args });
          outcome = approved ? undefined : { content: '用户拒绝了此操作（未执行）。', isError: true };
        }
        if (outcome === undefined) {
          // ctx 与主循环（registry.runTool）同形：signal / confirm 必须传进去——
          // 工具内部若还要再问一次（或要能被中止），拿不到钩子就只能失败。
          // board / agentName 供黑板（团队 / 并行批次）使用。
          outcome = await tool.execute({ store }, args, {
            characterId,
            board,
            agentName,
            signal,
            confirm: typeof confirm === 'function' ? confirm : null,
          });
        }
      } catch (error) {
        if (isAbortError(error) || (signal && signal.aborted)) throw makeAbortError();
        lastError = (error && error.message) || '工具执行失败。';
        outcome = { content: lastError, isError: true };
      }
      const ok = !(outcome && outcome.isError === true);
      if (!ok) toolErrors += 1;
      emit({ phase: 'end', name: call.name, round, ok });
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResult(outcome, SUBAGENT_TOOL_RESULT_LIMIT),
      });
    }
  }

  // 结论轮优先；达上限（异常路径）退回「最后一次有文本的轮」并附提示——
  // 部分信息也比空手好，但要说明它可能不是完整结论。
  const conclusion = String((conclusionText || lastText) || '').trim();
  let content;
  if (conclusion) {
    content = capped ? `${conclusion}\n\n（子代理达到轮次上限，结论可能不完整）` : conclusion;
  } else if (lastError) {
    content = `子代理没有给出结论（工具执行遇到问题：${lastError}）。`;
  } else {
    content = '子代理没有给出结论（可能工作区里没有相关信息）。';
  }
  if (content.length > SUBAGENT_RESULT_LIMIT) {
    content = `${content.slice(0, SUBAGENT_RESULT_LIMIT)}…（子代理结论过长已截断）`;
  }
  // 结论照给（部分信息比空手好），但**有工具失败时如实标记**：调用方（工作流编排、
  // 写子代理）据此把这一步判为未完成，而不是只看有没有文字就报成功。
  // 只读子代理的调用方（run_subagent）不受影响——它按 content 消费，不看这个字段。
  return { content, isError: false, toolErrors };
}

// E3：并发映射（有界并发、结果保持输入顺序）——并行子代理的执行器。
//
// 失败语义（2026-10-11 P1 修）：**首个 worker 抛错后不再派新活**（兄弟 worker 把手上
// 这一件跑完就停，已开工的不强行打断——JS 侧停不掉已发出的 promise），等所有 worker
// 结算后把首个错误抛出。抛出的错误上挂 `partialResults` / `completedIndices` /
// `failedIndex`，调用方可以据此展示「已完成的部分」而不是全丢。
//
// 为什么不是「让兄弟继续跑完」：那是纯浪费——失败往往是共同的（模型/网络/授权），
// 后面每一件都会以同样的方式失败，白花额度与时间；而结果又因为 Promise.all 的
// reject 语义全部丢弃，等于既付了代价又拿不到东西。
//
// 注意：worker **自己吞掉错误**（如 subagentTool 的并行批次）时本函数感知不到失败，
// 兄弟照常跑完——那是调用方的选择（单路失败不拖垮整批），语义不变。
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(limit)) || 1);
  const results = new Array(list.length);
  const completedIndices = [];
  let cursor = 0;
  let firstError = null;
  let failedIndex = -1;
  const runners = Array.from({ length: Math.min(size, list.length) }, async () => {
    for (;;) {
      if (firstError) return; // 已经失败：不再派新活（在飞的那一件仍会跑完）
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
        completedIndices.push(index);
      } catch (error) {
        if (!firstError) {
          firstError = error;
          failedIndex = index;
        }
        return;
      }
    }
  });
  // allSettled：等所有 worker 结算（在飞的那一件跑完），避免「后台还有活而调用方已
  // 拿到错误」的悬空状态——那个 promise 的 rejection 会成为未捕获拒绝。
  await Promise.allSettled(runners);
  if (firstError) {
    if (firstError && typeof firstError === 'object') {
      firstError.partialResults = results;
      firstError.completedIndices = completedIndices.slice().sort((a, b) => a - b);
      firstError.failedIndex = failedIndex;
    }
    throw firstError;
  }
  return results;
}
