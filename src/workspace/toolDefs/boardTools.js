// 黑板工具（board_post / board_read）——团队通信，仅注入给团队协作中的子代理。
//
// 这两个工具**不进主注册表**：黑板只在一次 run_workflow / run_subagent 批次内存在，
// 主对话没有黑板，注册了也只会报「不在团队协作中」。调用方（workflowTool/subagentTool）
// 把它们作为 extraTools 注入子代理，并通过 ctx.board 把同一块黑板传下去。

import { formatBoardMessages } from '../../agent/blackboard.js';

export const BOARD_POST_TOOL_DEFINITION = {
  name: 'board_post',
  description: '在团队共享黑板的某个主题下发布一条消息（进展/发现/中间结论），供其它分身读取。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '主题名（如「调研结论」「风险点」）。' },
      text: { type: 'string', description: '要发布的内容。' },
    },
    required: ['topic', 'text'],
  },
  execute: (options, args, ctx) => {
    const board = ctx && ctx.board;
    if (!board || typeof board.post !== 'function') {
      return { content: '当前没有共享黑板（不在团队协作中）。', isError: true };
    }
    const result = board.post({
      topic: args && args.topic,
      from: (ctx && ctx.agentName) || '匿名',
      text: args && args.text,
    });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `已发布到主题「${result.topic}」（第 ${result.seq} 条，该主题共 ${result.count} 条）。` };
  },
};

export const BOARD_READ_TOOL_DEFINITION = {
  name: 'board_read',
  description: '读取团队共享黑板上某个主题的消息（同伴发布的内容）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '主题名。' },
      since: { type: 'number', description: '可选：只读序号大于此值的消息（增量读取）。' },
    },
    required: ['topic'],
  },
  execute: (options, args, ctx) => {
    const board = ctx && ctx.board;
    if (!board || typeof board.read !== 'function') {
      return { content: '当前没有共享黑板（不在团队协作中）。', isError: true };
    }
    const result = board.read({ topic: args && args.topic, since: args && args.since });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: formatBoardMessages(result.topic, result.messages) };
  },
};

export const BOARD_TOOL_DEFINITIONS = Object.freeze([
  BOARD_POST_TOOL_DEFINITION,
  BOARD_READ_TOOL_DEFINITION,
]);
export const BOARD_TOOL_NAMES = Object.freeze(BOARD_TOOL_DEFINITIONS.map(item => item.name));
