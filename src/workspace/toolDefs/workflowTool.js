// 工作流工具定义（run_workflow）——依赖式编排（对齐 dsh workflows）。
//
// 每步是一个只读（或 opt-in 可写）子代理；无依赖的步骤并行，有依赖的等前置完成并带上其结论。
// 子代理工具表来自 toolDefs/subagentTools.js 的**唯一装配点**（与 run_subagent 共用）——
// 只读对象直接引 readTools/searchTool（不经注册表），防递归名单天然不含 run_subagent。

import { runSubagent } from '../../agent/subagent.js';
import { runWorkflow, WORKFLOW_MAX_STEPS } from '../../agent/workflow.js';
import { buildSubagentTools } from './subagentTools.js';

export const WORKFLOW_TOOL_DEFINITION = {
  name: 'run_workflow',
  description: '把一个多步骤任务编排成工作流：steps 里每步是一个子代理子任务，可用 dependsOn'
    + ' 声明依赖。无依赖的步骤并行执行；有依赖的步骤等前置完成后，带着前置结论再跑'
    + '（适合「先分别调研 A 和 B，再综合成结论」这类有先后的多子任务）。'
    + '步骤 mode 默认 read（只读），write 时允许改文件但每次写都要用户确认。'
    + `最多 ${WORKFLOW_MAX_STEPS} 步。结论按拓扑顺序合并返回。`,
  readOnly: true,
  // 多步 × 多轮模型请求，给足时间（并行层按最慢一路算）。
  timeoutMs: 600000,
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: '步骤列表；每步 { id, task, dependsOn?, mode? }。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '步骤标识（供 dependsOn 引用；缺省 step-N）。' },
            task: { type: 'string', description: '该步的子任务描述。' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: '前置步骤 id 列表。' },
            mode: { type: 'string', enum: ['read', 'write'], description: '默认 read（只读）。' },
          },
          required: ['task'],
        },
      },
    },
    required: ['steps'],
  },
  execute: async (options, args, ctx) => {
    const confirm = (ctx && typeof ctx.confirm === 'function') ? ctx.confirm : null;
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
    const result = await runWorkflow({
      steps: args && args.steps,
      signal: (ctx && ctx.signal) || null,
      runStep: async step => {
        const writeMode = step.mode === 'write';
        const outcome = await runSubagent({
          task: step.task,
          // 与 run_subagent 共用**唯一**装配点（P1-3：此前这里漏了 searchTool，
          // 工作流子代理拿不到 search_workspace，而提示词还在让它用）。
          tools: buildSubagentTools(writeMode ? 'write' : 'read'),
          store: options.store,
          characterId: ctx && ctx.characterId,
          signal: (ctx && ctx.signal) || null,
          mode: writeMode ? 'write' : 'read',
          // 同上：runSubagent 内部会再断言一次（纵深防御第二层）。
          workspaceMode,
          confirm,
        });
        return outcome && outcome.content ? outcome.content : '';
      },
    });
    if (!result.ok) {
      return { content: `工作流无法执行：${result.errors.join('；')}`, isError: true };
    }
    const merged = result.order
      .map(id => `【步骤 ${id}】${String(result.results[id] || '').trim()}`)
      .join('\n\n');
    return merged || '工作流没有产出结论。';
  },
};
