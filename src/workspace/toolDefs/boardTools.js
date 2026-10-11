// 黑板 / 消息总线 / 任务看板工具——团队通信，仅注入给团队协作中的子代理。
//
// 这些工具**不进主注册表**：黑板只在一次 run_workflow / run_subagent 批次内存在，
// 主对话没有黑板，注册了也只会报「不在团队协作中」。调用方（workflowTool/subagentTool）
// 把它们作为 extraTools 注入子代理，并通过 ctx.board 把同一块黑板传下去。

import { formatBoardMessages, formatInboxMessages, formatTaskBoard } from '../../agent/blackboard.js';

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

// 直连消息：点对点发给某个同伴。
export const BOARD_SEND_TOOL_DEFINITION = {
  name: 'board_send',
  description: '给团队里的某个同伴点对点发一条消息（对方用 board_inbox 收）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: '收件人（同伴名 / 子任务名）。' },
      text: { type: 'string', description: '消息内容。' },
    },
    required: ['to', 'text'],
  },
  execute: (options, args, ctx) => {
    const board = ctx && ctx.board;
    if (!board || typeof board.send !== 'function') {
      return { content: '当前没有团队消息总线（不在团队协作中）。', isError: true };
    }
    const result = board.send({
      to: args && args.to,
      from: (ctx && ctx.agentName) || '匿名',
      text: args && args.text,
    });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `已发送给「${result.to}」（第 ${result.seq} 条）。` };
  },
};

// 收件箱：读取发给自己的点对点消息。
export const BOARD_INBOX_TOOL_DEFINITION = {
  name: 'board_inbox',
  description: '读取发给你的点对点消息（同伴用 board_send 发的）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      since: { type: 'number', description: '可选：只读序号大于此值的消息（增量读取）。' },
    },
  },
  execute: (options, args, ctx) => {
    const board = ctx && ctx.board;
    if (!board || typeof board.inbox !== 'function') {
      return { content: '当前没有团队消息总线（不在团队协作中）。', isError: true };
    }
    const me = (ctx && ctx.agentName) || '匿名';
    const result = board.inbox({ for: me, since: args && args.since });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: formatInboxMessages(me, result.messages) };
  },
};

// 任务看板：共享清单的 add / claim / complete / list。
export const BOARD_TASK_TOOL_DEFINITION = {
  name: 'board_task',
  description: '团队共享任务看板：action=add 新增 / claim 认领 / complete 完成 / list 列出。用于把分工写下来、避免重复劳动。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'add / claim / complete / list。' },
      title: { type: 'string', description: 'add 时的任务标题。' },
      owner: { type: 'string', description: 'add 时的负责人（可选）。' },
      id: { type: 'number', description: 'claim / complete 时的任务编号。' },
      note: { type: 'string', description: 'complete 时的备注（可选）。' },
    },
    required: ['action'],
  },
  execute: (options, args, ctx) => {
    const board = ctx && ctx.board;
    if (!board || typeof board.listTasks !== 'function') {
      return { content: '当前没有任务看板（不在团队协作中）。', isError: true };
    }
    const me = (ctx && ctx.agentName) || '匿名';
    const action = String((args && args.action) || '').trim().toLowerCase();
    if (action === 'add') {
      const result = board.addTask({ title: args && args.title, owner: args && args.owner });
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `已新增任务 #${result.task.id}：${result.task.title}` };
    }
    if (action === 'claim') {
      const result = board.claimTask({ id: args && args.id, by: me });
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `已认领任务 #${result.task.id}：${result.task.title}` };
    }
    if (action === 'complete') {
      const result = board.completeTask({ id: args && args.id, by: me, note: args && args.note });
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `已完成任务 #${result.task.id}：${result.task.title}` };
    }
    if (action === 'list') {
      return { content: formatTaskBoard(board.listTasks()) };
    }
    return { content: 'action 必须是 add / claim / complete / list。', isError: true };
  },
};

export const BOARD_TOOL_DEFINITIONS = Object.freeze([
  BOARD_POST_TOOL_DEFINITION,
  BOARD_READ_TOOL_DEFINITION,
  BOARD_SEND_TOOL_DEFINITION,
  BOARD_INBOX_TOOL_DEFINITION,
  BOARD_TASK_TOOL_DEFINITION,
]);
export const BOARD_TOOL_NAMES = Object.freeze(BOARD_TOOL_DEFINITIONS.map(item => item.name));
