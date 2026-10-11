// 工作流工具定义（run_workflow）——依赖式编排（对齐 dsh workflows）。
//
// 每步是一个只读（或 opt-in 可写）子代理；无依赖的步骤并行，有依赖的等前置完成并带上其结论。
// 子代理工具表来自 toolDefs/subagentTools.js 的**唯一装配点**（与 run_subagent 共用）——
// 只读对象直接引 readTools/searchTool（不经注册表），防递归名单天然不含 run_subagent。
// 执行细节（agent 档案收窄 + 共享黑板）收在 workflowRunner.js，与 run_team 共用。

import { WORKFLOW_MAX_STEPS } from '../../agent/workflow.js';
import { loadPersistentBlackboard, savePersistentBlackboard } from '../boardStore.js';
import { buildSubagentTools } from './subagentTools.js';
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
    // P0-2（纵深防御第一层）：run_workflow 是 readOnly 工具，**READ 模式也能被模型调用**；
    // 它的步骤直接调 runSubagent，同样绕过 registry.canRunTool 的模式闸门。
    // 整条工作流**明确拒绝**（而不是把写步骤降级为只读）：这是授权错误，不是步骤级失败——
    // 半跑一遍再回一句「工作流成功」会把「没写的写成了」伪装成完成。
    const workspaceMode = String((ctx && ctx.workspaceMode) || '');
    const writeStepIds = (Array.isArray(args && args.steps) ? args.steps : [])
      .map((step, index) => ({
        id: String((step && step.id) || `step-${index + 1}`),
        mode: String((step && step.mode) || 'read').toLowerCase(),
      }))
      .filter(item => item.mode === 'write')
      .map(item => item.id);
    if (writeStepIds.length > 0 && workspaceMode !== 'write') {
      return {
        content: `工作流无法执行：步骤 ${writeStepIds.join('、')} 要求 write 模式，`
          + '但当前是只读模式，写操作需要用户切到「可改」模式（未执行）。',
        isError: true,
      };
    }
    const result = await runWorkflowSteps({
      store: options.store,
      characterId: ctx && ctx.characterId,
      signal: (ctx && ctx.signal) || null,
      confirm: (ctx && typeof ctx.confirm === 'function') ? ctx.confirm : null,
      // 宿主模式才是写授权（步骤里的 mode 只是请求）；执行器据此门控。
      hostMode: workspaceMode,
      // 与 run_subagent 共用**唯一**装配点（P1-3：此前这里漏了 searchTool，
      // 工作流子代理拿不到 search_workspace，而提示词还在让它用）。
      buildTools: mode => buildSubagentTools(mode),
      steps: args && args.steps,
      ...(board ? { board } : {}),
    });
    if (board) await savePersistentBlackboard(options.store, ctx && ctx.characterId, board).catch(() => {});
    // 成功返回纯文本（宿主/测试按字符串消费）；失败仍是 { content, isError }。
    const formatted = formatWorkflowResult(result);
    return formatted.isError ? formatted : formatted.content;
  },
};
