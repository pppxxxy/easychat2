// 工作流工具定义（run_workflow）——依赖式编排（对齐 dsh workflows）。
//
// 每步是一个只读（或 opt-in 可写）子代理；无依赖的步骤并行，有依赖的等前置完成并带上其结论。
// 只读对象从 readTools/writeTools 直接引（不经注册表），防递归名单天然不含 run_subagent。

import { runSubagent, SUBAGENT_TOOL_NAMES, SUBAGENT_WRITE_TOOL_NAMES } from '../../agent/subagent.js';
import { runWorkflow, WORKFLOW_MAX_STEPS } from '../../agent/workflow.js';
import { createBlackboard } from '../../agent/blackboard.js';
import { READ_ONLY_TOOL_DEFINITIONS } from './readTools.js';
import { WRITE_TOOL_DEFINITIONS } from './writeTools.js';
import { BOARD_TOOL_DEFINITIONS } from './boardTools.js';

const READ_TOOLS = READ_ONLY_TOOL_DEFINITIONS.filter(item => SUBAGENT_TOOL_NAMES.includes(item.name));
const WRITE_TOOLS = WRITE_TOOL_DEFINITIONS.filter(item => SUBAGENT_WRITE_TOOL_NAMES.includes(item.name));

export const WORKFLOW_TOOL_DEFINITION = {
  name: 'run_workflow',
  description: '把一个多步骤任务编排成工作流：steps 里每步是一个子代理子任务，可用 dependsOn'
    + ' 声明依赖。无依赖的步骤并行执行；有依赖的步骤等前置完成后，带着前置结论再跑'
    + '（适合「先分别调研 A 和 B，再综合成结论」这类有先后的多子任务）。'
    + '步骤 mode 默认 read（只读），write 时允许改文件但每次写都要用户确认。'
    + '所有步骤共享一块黑板：某步可用 board_post 发布中间结论、用 board_read 读取'
    + '同伴写的内容（无需声明依赖即可互通）。'
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
    // 一次工作流 = 一个团队：所有步骤共享同一块黑板（自由通信），并各自署名自己的步骤 id。
    const board = createBlackboard();
    const result = await runWorkflow({
      steps: args && args.steps,
      signal: (ctx && ctx.signal) || null,
      runStep: async step => {
        const writeMode = step.mode === 'write';
        const outcome = await runSubagent({
          task: step.task,
          tools: (writeMode ? READ_TOOLS.concat(WRITE_TOOLS) : READ_TOOLS).concat(BOARD_TOOL_DEFINITIONS),
          store: options.store,
          characterId: ctx && ctx.characterId,
          signal: (ctx && ctx.signal) || null,
          mode: writeMode ? 'write' : 'read',
          confirm,
          board,
          extraTools: BOARD_TOOL_DEFINITIONS,
          agentName: step.id,
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
