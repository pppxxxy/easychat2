// ask_user 工具（AskUserQuestion 对齐）：任务中途让 agent 主动向用户提一个选择题，
// 等用户选择后再继续。跨平台用 Alert（Android 最多 3 个按钮），故 options 限 2–3 个。
//
// 宿主经 ctx.ask({ question, options }) 提供询问能力（缺失时工具按「问不到 = 不执行」拒绝）。

export const ASK_USER_MAX_OPTIONS = 3;

// 归一选项：trim、去空、限个数。
export function normalizeAskOptions(options) {
  return (Array.isArray(options) ? options : [])
    .map(item => String(item == null ? '' : item).trim())
    .filter(Boolean)
    .slice(0, ASK_USER_MAX_OPTIONS);
}

export const ASK_USER_TOOL_DEFINITION = {
  name: 'ask_user',
  description: '任务中途向用户提一个选择题，等用户选择后再继续。适合「需要用户拍板才能继续」'
    + '（选哪个方案、确认范围、选哪个文件）——只在确实卡住时用，不要拿它当进度汇报。'
    + `options 给 2–${ASK_USER_MAX_OPTIONS} 个候选。`,
  readOnly: true,
  // 阻塞等用户选择：默认 15s 会被误判超时（用户还在读题）。给足 5 分钟。
  timeoutMs: 300000,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题。' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: `候选选项（2–${ASK_USER_MAX_OPTIONS} 个），用户从中选一个。`,
      },
    },
    required: ['question', 'options'],
  },
  // 签名遵循工具包装层约定 (options, args, ctx)——options 是宿主绑定的 store 包，
  // args 是模型给的参数，ctx 携带 ask 钩子。
  execute: async (options, args, ctx) => {
    const question = String((args && args.question) || '').trim();
    const choices = normalizeAskOptions(args && args.options);
    if (!question || choices.length < 2) {
      return { content: 'ask_user 需要 question 与至少 2 个 options。', isError: true };
    }
    if (!ctx || typeof ctx.ask !== 'function') {
      return { content: '当前环境无法向用户提问（未执行）。', isError: true };
    }
    const answer = await ctx.ask({ question, options: choices });
    if (answer == null || answer === '') {
      return { content: '用户没有回答（已取消）。', isError: true };
    }
    return { content: `用户选择了：${answer}` };
  },
};
