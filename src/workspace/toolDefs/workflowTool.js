// 工作流工具定义（run_workflow）——依赖式编排（对齐 dsh workflows）。
//
// 每步是一个只读（或 opt-in 可写）子代理；无依赖的步骤并行，有依赖的等前置完成并带上其结论。
// 执行细节（agent 档案收窄 + 共享黑板）收在 workflowRunner.js，与 run_team 共用。

import { WORKFLOW_MAX_STEPS } from '../../agent/workflow.js';
import { loadPersistentBlackboard, savePersistentBlackboard } from '../boardStore.js';
import { runWorkflowSteps, formatWorkflowResult } from './workflowRunner.js';

export const WORKFLOW_TOOL_DEFINITION = {
  name: 'run_workflow',
  description: '把一个多步骤任务编排成工作流：steps 里每步是一个子代理子任务，可用 dependsOn'
    + ' 声明依赖。无依赖的步骤并行执行；有依赖的步骤等前置完成后，带着前置结论再跑'
    + '（适合「先分别调研 A 和 B，再综合成结论」这类有先后的多子任务）。'
    + '步骤 agent 可选：用 .easychat/agents/ 里定义的分身档案收窄工具集与轮次。'
    + '步骤 mode 默认 read（只读），write 时允许改文件但每次写都要用户确认。'
    + '所有步骤共享一块黑板：某步可用 board_post 发布中间结论、用 board_read 读取'
    + '同伴写的内容（无需声明依赖即可互通）。默认黑板只在本轮内有效；传 remember=true'
    + '则跨会话沉淀（下次同工作区运行先读上次的结论）。'
    + `最多 ${WORKFLOW_MAX_STEPS} 步。结论按拓扑顺序合并返回。`,
  readOnly: true,
  // 多步 × 多轮模型请求，给足时间（并行层按最慢一路算）。
  timeoutMs: 600000,
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: '步骤列表；每步 { id, task, dependsOn?, agent?, mode? }。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '步骤标识（供 dependsOn 引用；缺省 step-N）。' },
            task: { type: 'string', description: '该步的子任务描述。' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: '前置步骤 id 列表。' },
            agent: { type: 'string', description: '可选：分身档案名（.easychat/agents/<name>.md）。' },
            mode: { type: 'string', enum: ['read', 'write'], description: '默认 read（只读）。' },
          },
          required: ['task'],
        },
      },
      remember: { type: 'boolean', description: '可选：默认 false——黑板只在本轮内有效；true 则跨会话沉淀。' },
    },
    required: ['steps'],
  },
  execute: async (options, args, ctx) => {
    const remember = !!(args && args.remember);
    const board = remember ? await loadPersistentBlackboard(options.store, ctx && ctx.characterId) : undefined;
    const result = await runWorkflowSteps({
      store: options.store,
      characterId: ctx && ctx.characterId,
      signal: (ctx && ctx.signal) || null,
      confirm: (ctx && typeof ctx.confirm === 'function') ? ctx.confirm : null,
      steps: args && args.steps,
      ...(board ? { board } : {}),
    });
    if (board) await savePersistentBlackboard(options.store, ctx && ctx.characterId, board).catch(() => {});
    return formatWorkflowResult(result);
  },
};
