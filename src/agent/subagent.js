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
export const SUBAGENT_TOOL_NAMES = Object.freeze(['list_workspace_files', 'read_workspace_file']);
export const SUBAGENT_SYSTEM_PROMPT = [
  '你是「研究工作区」的子代理：只能读取工作区文件（不能修改任何东西），',
  '任务是把研究工作做完后交回**结论**。',
  '用 list_workspace_files 了解结构、用 read_workspace_file 读内容（大文件可分段读）。',
  '完成后用简洁中文给出结论：先直接回答，再列关键依据（含文件路径）。',
  '不要复述检索过程，不要说「我读了哪些文件」——只交回结论本身。',
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
} = {}) {
  const text = String(task == null ? '' : task).trim();
  if (!text) return { content: '子任务描述为空。', isError: true };
  const streamFn = stream || resolveDefaultStream();
  if (typeof streamFn !== 'function') {
    return { content: '子代理不可用（网络层不可达）。', isError: true };
  }
  // 名字白名单 + 可执行性：名单外的工具（含 run_subagent 自己）在这里被物理挡下。
  const usable = (Array.isArray(tools) ? tools : []).filter(item => (
    item
    && SUBAGENT_TOOL_NAMES.includes(String(item.name || ''))
    && typeof item.execute === 'function'
  ));
  if (!store || usable.length === 0) {
    return { content: '子代理不可用（缺少工作区存储或只读工具）。', isError: true };
  }

  const schemas = usable.map(toFunctionSchema);
  const history = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
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
        outcome = await tool.execute({ store }, args, { characterId });
      } catch (error) {
        if (isAbortError(error) || (signal && signal.aborted)) throw makeAbortError();
        lastError = (error && error.message) || '工具执行失败。';
        outcome = { content: lastError, isError: true };
      }
      const ok = !(outcome && outcome.isError === true);
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
  return { content, isError: false };
}

// E3：并发映射（有界并发、结果保持输入顺序）——并行子代理的执行器。
// 手机端同时开两条独立模型流是上限（网络与限流考虑）；worker 抛错原样上抛
//（调用方决定降级），这里不吞错。
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(limit)) || 1);
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, list.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
