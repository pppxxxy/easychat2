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
import { readWorkspaceAgents } from '../agents.js';
import { hostAllowsWrite, subagentToolSet } from './subagentToolSet.js';

// 并行任务数上限：手机端同时两条模型流是上限（网络与速率限制考虑）。
export const SUBAGENT_BATCH_LIMIT = 3;
export const SUBAGENT_CONCURRENCY = 2;

export const SUBAGENT_TOOL_DEFINITION = {
  name: 'run_subagent',
  description: '把一个「研究型子任务」委托给助手的一个独立分身：默认只能读工作区文件'
    + '（不能改任何东西），完成后把整理好的结论交回来。适合「翻很多文件找答案」'
    + '这类会刷屏的任务——中间过程不会占用当前对话的上下文。task 里要写清'
    + '「要找什么、要回答什么」，结论回来后再由你转述或继续加工。'
    + 'task 也可以传数组（最多 3 个）并行执行，结论按顺序合并。'
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
    // 工具集来自**共用**白名单（subagentToolSet，工作流用同一份——F3）。
    // F1：write 必须同时满足「模型请求 write」与「宿主确实在可改模式」。只看 args.mode 的话，
    // 本工具在 read 模式也是可见的（readOnly: true），模型一句话就能让子代理改文件——
    // 子代理直接调 tool.execute，注册表的模式门控管不到它。
    const requestedWrite = String((args && args.mode) || 'read').toLowerCase() === 'write';
    const writeMode = requestedWrite && hostAllowsWrite(ctx);
    let subagentTools = subagentToolSet(writeMode ? 'write' : 'read');
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

    const runOne = task => runSubagent({
      task,
      tools: subagentTools,
      store: options.store,
      characterId: ctx && ctx.characterId,
      signal: (ctx && ctx.signal) || null,
      mode: writeMode ? 'write' : 'read',
      confirm: (ctx && typeof ctx.confirm === 'function') ? ctx.confirm : null,
      ...(maxRounds ? { maxRounds } : {}),
    });

    if (tasks.length === 1) {
      const result = await runOne(tasks[0]);
      return result.isError ? { content: result.content, isError: true } : result.content;
    }

    // 并行批次（≤3、并发 2）：结论按序合并；单路失败不拖垮整批（该路段如实标注失败）。
    const results = await mapWithConcurrency(tasks, SUBAGENT_CONCURRENCY, async task => {
      try {
        return await runOne(task);
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
