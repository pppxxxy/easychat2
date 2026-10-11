// 子代理工具定义（run_subagent）。
//
// 只读对象**从 readTools.js 直接引**（不是从全量工具表过滤）：防递归的名单天然
// 只包含只读两项，且这条引用关系不经过「注册表」——子代理在结构上就拿不到
// 别的工具（含它自己）。run_subagent 自身也是 readOnly 工具，按标志过滤会
// 把它放进来递归，所以只读白名单按**名字**收（见 agent/subagent.js）。
//
// E3 扩展：agent（可选分身名，从 .easychat/agents/<name>.md 取档案收窄工具集与
// 轮次）+ task 支持数组（≤3 个，并发上限 2，按序合并结论）。

import { mapWithConcurrency, runSubagent } from '../../agent/subagent.js';
import { createBlackboard } from '../../agent/blackboard.js';
import { readWorkspaceAgents } from '../agents.js';
// 工具表来自**唯一装配点**（readTools + searchTool；write 模式再叠加 writeTools）——
// 与 run_workflow 共用同一个函数，杜绝「修了一处忘了另一处」（P1-3）。
import { buildSubagentTools } from './subagentTools.js';
import { BOARD_TOOL_DEFINITIONS } from './boardTools.js';

// 并行任务数上限：手机端同时两条模型流是上限（网络与速率限制考虑）。
export const SUBAGENT_BATCH_LIMIT = 3;
export const SUBAGENT_CONCURRENCY = 2;

export const SUBAGENT_TOOL_DEFINITION = {
  name: 'run_subagent',
  description: '把一个「研究型子任务」委托给助手的一个独立分身：默认只能读工作区文件'
    + '（不能改任何东西），完成后把整理好的结论交回来。适合「翻很多文件找答案」'
    + '这类会刷屏的任务——中间过程不会占用当前对话的上下文。task 里要写清'
    + '「要找什么、要回答什么」，结论回来后再由你转述或继续加工。'
    + 'task 也可以传数组（最多 3 个）并行执行，结论按顺序合并；并行时多个分身共享'
    + '一块黑板（board_post / board_read 互相传递中间结论）。'
    + 'agent 可选：用工作区 .easychat/agents/ 里定义的分身档案（清单见系统提示的'
    + '「子代理分身」段），未定义档案时按默认分身执行。'
    + 'mode 可选：默认 read（只读）；write 时额外允许改文件（write/edit/create_dir），'
    + '但**每一次写都会先请用户确认**，未批准则不执行；且**仅当工作区处于「可改」模式时生效**'
    + '（只读模式下请求 write 会被忽略，子代理仍按只读跑）。',
  readOnly: true,
  // 子代理要跑多轮模型请求，默认工具超时（十几秒）不够；300s 是防跑飞的上限
  //（E3 起从 180s 提高——并行批次的完成时间按最慢一路算）。
  timeoutMs: 300000,
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description: '子任务描述（要找什么、要回答什么）；数组 = 多个子任务并行。',
      },
      agent: { type: 'string', description: '可选：分身档案名（.easychat/agents/<name>.md）。' },
      mode: {
        type: 'string',
        enum: ['read', 'write'],
        description: '可选：read（默认，只读）/ write（额外允许改文件，逐写需用户确认）。',
      },
    },
    required: ['task'],
  },
  execute: async (options, args, ctx) => {
    // 防递归（不含 run_subagent——它自己也是 readOnly，只看标志会递归）由工具表装配点
    // 按**名字白名单**结构性保证，见 toolDefs/subagentTools.js。
    const writeMode = String((args && args.mode) || 'read').toLowerCase() === 'write';
    // P0-2（纵深防御第一层）：run_subagent 是 readOnly 工具，**READ 模式也能被模型调用**；
    // 而 runSubagent 内部直接调 tool.execute，绕过了 registry.canRunTool 的模式闸门。
    // 因此这里必须自己看工作区模式——否则「READ 模式 + mode:'write'」就能越权落盘。
    // 明确拒绝而不是静默降级为只读：模型要的是写，降级后它只会得到一句「没写成」，
    // 而「为什么不成」才是它（和用户）需要知道的信息。
    const workspaceMode = String((ctx && ctx.workspaceMode) || '');
    if (writeMode && workspaceMode !== 'write') {
      return {
        content: '写子代理不可用：当前是只读模式，写操作需要用户切到「可改」模式（未执行）。',
        isError: true,
      };
    }
    // 工具表由**唯一装配点**给出（readTools + searchTool，write 模式再叠加 writeTools）——
    // 与 run_workflow 共用同一个函数，杜绝「修了一处忘了另一处」（P1-3）。
    let subagentTools = buildSubagentTools(writeMode ? 'write' : 'read');
    let maxRounds;
    // E3：分身档案（可选）——tools 已在解析层 ∩ 只读白名单；这里再按档案收窄
    // 工具表（名单外的名字在 parseAgentMarkdown 已丢，这里只是执行映射）。
    const agentName = String((args && args.agent) || '').trim();
    if (agentName) {
      try {
        const profiles = await readWorkspaceAgents(options.store, ctx && ctx.characterId, [agentName]);
        const profile = profiles[0];
        if (profile) {
          if (Array.isArray(profile.tools) && profile.tools.length > 0) {
            subagentTools = subagentTools.filter(item => profile.tools.includes(item.name));
          }
          if (Number.isFinite(profile.maxRounds)) maxRounds = profile.maxRounds;
        }
      } catch (error) {
        // 档案读失败按默认分身继续——研究任务不该因档案问题不可用。
      }
    }
    const rawTasks = Array.isArray(args && args.task) ? args.task : [args && args.task];
    const tasks = rawTasks
      .map(item => String(item == null ? '' : item).trim())
      .filter(Boolean)
      .slice(0, SUBAGENT_BATCH_LIMIT);
    if (tasks.length === 0) return { content: '子任务描述为空。', isError: true };

    // 并行批次才开黑板（单任务没有同伴，黑板无意义）：批次内分身共享，署名 task-N。
    const batch = tasks.length > 1;
    const board = batch ? createBlackboard() : null;
    const extraTools = batch ? BOARD_TOOL_DEFINITIONS : [];

    const runOne = (task, agentName) => runSubagent({
      task,
      tools: batch ? subagentTools.concat(extraTools) : subagentTools,
      store: options.store,
      characterId: ctx && ctx.characterId,
      signal: (ctx && ctx.signal) || null,
      mode: writeMode ? 'write' : 'read',
      // 把宿主模式一路传下去：runSubagent 内部会再断言一次（纵深防御第二层）。
      workspaceMode,
      confirm: (ctx && typeof ctx.confirm === 'function') ? ctx.confirm : null,
      ...(board ? { board, extraTools, agentName } : {}),
      ...(maxRounds ? { maxRounds } : {}),
    });

    if (tasks.length === 1) {
      const result = await runOne(tasks[0], 'task-1');
      return result.isError ? { content: result.content, isError: true } : result.content;
    }

    // 并行批次（≤3、并发 2）：结论按序合并；单路失败不拖垮整批（该路段如实标注失败）。
    const results = await mapWithConcurrency(tasks, SUBAGENT_CONCURRENCY, async (task, index) => {
      try {
        return await runOne(task, `task-${index + 1}`);
      } catch (error) {
        if (error && (error.canceled === true || error.name === 'AbortError')) throw error;
        return { content: `（子任务失败：${(error && error.message) || '未知错误'}）`, isError: true };
      }
    });
    const merged = results
      .map((result, index) => `【子任务 ${index + 1}】${String((result && result.content) || '').trim()}`)
      .join('\n\n');
    return merged;
  },
};
