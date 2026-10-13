// confirm_flow 工具定义（AS2）：一次向用户提 1–4 题确认，每题除「是/否」外，
// 「其他」可以是 列表点选 / 预填可编辑 / 自由输入 三种形态之一。
//
// 与 ask_user 的分工见 confirmFlow.js 头部。本文件只做「定义 + execute」，
// 归一/校验/格式化全在纯模块 confirmFlow.js（Node 直测）。
//
// 宿主经 ctx.confirmFlow({ questions }) 提供确认能力（缺失时工具按「问不到 = 不执行」
// 拒绝——与 ask_user 同款纪律）。返回 null / 非法 → 视为用户取消。

import {
  CONFIRM_FLOW_MAX_QUESTIONS,
  formatConfirmResult,
  hydrateConfirmQuestions,
  normalizeConfirmQuestions,
  validateConfirmAnswers,
} from './confirmFlow.js';

export const CONFIRM_FLOW_TOOL_DEFINITION = {
  name: 'confirm_flow',
  description: '需要用户逐项拍板才能继续时，一次向用户提 1–' + CONFIRM_FLOW_MAX_QUESTIONS
    + ' 题确认。每题固定「是 / 否」两个选项，外加一个可选的「其他」输入：'
    + 'other.type=list 给候选让用户点选（角色列表这类长清单只写 source 名，真实选项由系统注入，不要自己编造 id），'
    + 'other.type=edit 预填一段文字让用户改，other.type=free 给个空输入框。'
    + '用户全部作答后一次性回传结构化结果；用户关掉弹窗视为取消。适合「代改设置 / 建定时任务」'
    + '这类要先复述确认再落地的操作，别拿它当进度汇报。',
  readOnly: true,
  // 阻塞等用户逐题作答：与 ask_user 同款，给足 5 分钟（默认 15s 会被误判超时）。
  timeoutMs: 300000,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '题目标识（回传时对齐用）；缺省按序号补。' },
            text: { type: 'string', description: '题目正文（一句话说清要确认什么）。' },
            other: {
              type: 'object',
              description: '「其他」输入的形态（可省略 = 只有是/否）。',
              properties: {
                type: { type: 'string', enum: ['list', 'edit', 'free'], description: 'list=候选点选，edit=预填可编辑，free=自由输入。' },
                source: { type: 'string', description: 'type=list 时的宿主选项源名（如 characters）；给了就不用自己列 options。' },
                options: { type: 'array', items: { type: 'string' }, description: 'type=list 且无 source 时的候选（≤30 个）。' },
                prefill: { type: 'string', description: 'type=edit 的预填文本。' },
                placeholder: { type: 'string', description: 'type=free 的输入框占位提示。' },
              },
            },
          },
          required: ['text'],
        },
        description: `1–${CONFIRM_FLOW_MAX_QUESTIONS} 道题。`,
      },
    },
    required: ['questions'],
  },
  execute: async (options, args, ctx) => {
    const questions = normalizeConfirmQuestions(args && args.questions);
    if (questions.length === 0) {
      return { content: 'confirm_flow 需要至少 1 道带 text 的题目。', isError: true };
    }
    if (!ctx || typeof ctx.confirmFlow !== 'function') {
      return { content: '当前环境无法向用户发起确认（未执行）。', isError: true };
    }
    // 宿主长清单源（角色等）注入到 list 题——agent 只写了 source 名时由宿主填真实选项。
    const choicesFor = typeof ctx.choices === 'function' ? ctx.choices : null;
    const hydrated = hydrateConfirmQuestions(questions, choicesFor);
    const answers = await ctx.confirmFlow({ questions: hydrated });
    if (answers === null || answers === undefined) {
      return { content: '用户取消了确认（未执行）。', isError: true };
    }
    const checked = validateConfirmAnswers(hydrated, answers);
    if (!checked.ok) {
      return { content: '确认答案不完整（有题目未作答或被取消，未执行）。', isError: true };
    }
    // 注意：registry 只搬运 content/isError/notice*——结构化结果一律进 content 正文
    //（formatConfirmResult 已把逐题答案拼成人读文本），不要在这里加额外字段。
    return { content: `用户确认结果：\n${formatConfirmResult(hydrated, checked.answers)}` };
  },
};
