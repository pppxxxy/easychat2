// 计划工具（update_plan，能力升级任务书 A3）：把多步任务的步骤清单显式记录并回显。
//
// 它是**纯回显**：没有副作用、不落盘（readOnly: true）——作用是让每一步计划都
// 出现在工具结果里，模型后续轮次与用户都能看到进度，减少「做着做着漂了」。
// 二期（不在本任务）：计划状态接 ChatPanel 展示进度条。

export const PLAN_MAX_STEPS = 20;
export const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'done']);

// 纯函数：清单 → 回显文本。非法输入安全降级（永不抛错——规划本身不该成为失败点）。
export function formatPlanEcho(plan) {
  const list = Array.isArray(plan) ? plan : [];
  const steps = list
    .map(item => {
      const source = item && typeof item === 'object' ? item : {};
      const step = String(source.step == null ? '' : source.step).trim();
      if (!step) return null;
      const status = PLAN_STATUSES.includes(source.status) ? source.status : 'pending';
      return { step, status };
    })
    .filter(Boolean)
    .slice(0, PLAN_MAX_STEPS);
  if (steps.length === 0) {
    return '（计划为空或格式不对：plan 应为 [{ step, status }] 数组，status 取 pending / in_progress / done。）';
  }
  const marks = { pending: '[ ]', in_progress: '[>]', done: '[x]' };
  const done = steps.filter(item => item.status === 'done').length;
  const lines = [`计划（${done}/${steps.length} 完成）：`];
  steps.forEach((item, index) => {
    lines.push(`${marks[item.status]} ${index + 1}. ${item.step}`);
  });
  return lines.join('\n');
}

export const PLAN_TOOL_DEFINITION = {
  name: 'update_plan',
  description: '记录或更新当前任务的步骤清单（纯展示，无副作用、不落盘）：'
    + '多步任务建议先列清单再动手，每完成一步就更新状态——你自己与用户都能看到进度。'
    + 'plan 传整个清单的最新版本（不是增量）。单步的小任务不需要它。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'array',
        description: '完整的步骤清单（按执行顺序）。',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: '这一步要做什么（一句话）。' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done'],
              description: '这一步的状态（缺省按 pending）。',
            },
          },
          required: ['step'],
        },
      },
    },
    required: ['plan'],
  },
  execute: (options, args) => formatPlanEcho(args && args.plan),
};
