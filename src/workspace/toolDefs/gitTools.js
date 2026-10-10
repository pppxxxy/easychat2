// 工作区本地 git 工具（W7，只读三件套）。
//
// 为什么只给这三个：Android 上没有 git 二进制，agent 在此之前**没有任何办法**知道
// 「我改了什么」——只能把文件整篇读回来自己比。这三个工具补的正是这一步：
//   git_status —— 未提交改动清单（相对上次提交）
//   git_diff   —— 某个文件的行级 diff
//   git_log    —— 本地提交历史
//
// 三个都 readOnly: true：**不写任何文件**。仓库由用户在设置里打开「本地版本控制」时
// 初始化（`resolveGitRunner().ensureRepo`），不由只读工具顺手 init——只读工具产生副作用
// 会让「readOnly」这个标记失去意义（注册表的模式门控也靠它）。
//
// 写类（git_commit / git_checkout）留到下一阶段，并走 requiresConfirmation。
//
// 时延：isomorphic-git 是纯 JS，真机 Hermes 上比 Node 慢（Node 实测 300 文件 statusMatrix
// 42ms，真机未测）。所以 status/diff 显式声明 30s 超时——默认 15s 对大仓库有风险。

import { formatDiffText } from '../lineDiff.js';

export const GIT_LOG_DEFAULT_LIMIT = 20;
export const GIT_LOG_MAX_LIMIT = 100;
export const GIT_TOOL_TIMEOUT_MS = 30_000;

// 与 git status --short 同款记号，模型一眼能认。
const STATUS_MARKS = Object.freeze({
  untracked: '??',
  added: 'A ',
  modified: ' M',
  deleted: ' D',
});

export function formatGitStatus(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(row => row && row.path);
  if (list.length === 0) return '工作区干净：没有未提交的改动。';
  const lines = [`未提交的改动（${list.length} 个文件）：`];
  for (const row of list) {
    lines.push(`${STATUS_MARKS[row.status] || '??'} ${row.path}`);
  }
  return lines.join('\n');
}

export function formatGitLog(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(item => item && item.oid);
  if (list.length === 0) return '还没有任何提交（本地历史是空的）。';
  const lines = ['最近的提交（新 → 旧）：'];
  for (const item of list) {
    lines.push(`${String(item.oid).slice(0, 7)} ${item.message || '(无提交说明)'}`);
  }
  return lines.join('\n');
}

// 仓库未就位时的如实回话（不假装、不顺手 init）。
const NO_REPO_TEXT = '本地版本控制还没就绪：这个工作区还没有 git 仓库。请在「工作区 → 设置」里打开「本地版本控制」开关（会初始化仓库），然后再试。';

function openRepo(options, ctx) {
  const runner = options && options.git;
  if (!runner || typeof runner.open !== 'function') {
    return { error: '本地版本控制未启用（设置里打开后可用）。' };
  }
  try {
    return { git: runner.open({ characterId: ctx && ctx.characterId }) };
  } catch (error) {
    return { error: `打开本地仓库失败：${String((error && error.message) || '')}` };
  }
}

export const GIT_STATUS_TOOL_DEFINITION = {
  name: 'git_status',
  description: '查看工作区里相对上一次提交改了什么（未提交的改动清单，含新增/修改/删除）。'
    + '回答「我改了什么」、确认自己的改动是否已入库时用它，不要把文件整篇读回来自己比。'
    + '本地仓库不存在时会如实说明（需要用户在设置里打开「本地版本控制」）。',
  readOnly: true,
  timeoutMs: GIT_TOOL_TIMEOUT_MS,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (options, args, ctx) => {
    const opened = openRepo(options, ctx);
    if (opened.error) return { content: opened.error, isError: true };
    try {
      if (!(await opened.git.isRepo())) return { content: NO_REPO_TEXT, isError: true };
      return { content: formatGitStatus(await opened.git.changedFiles()) };
    } catch (error) {
      return { content: `读取 git 状态失败：${String((error && error.message) || '')}`, isError: true };
    }
  },
};

export const GIT_DIFF_TOOL_DEFINITION = {
  name: 'git_diff',
  description: '查看某个文件相对上一次提交的具体改动（行级 diff，+ 新增 / - 删除）。'
    + 'path 传工作区相对路径；新文件会把整份内容算作新增。想看整体改了哪些文件先用 git_status。',
  readOnly: true,
  timeoutMs: GIT_TOOL_TIMEOUT_MS,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径，例如 src/app.js。' },
    },
    required: ['path'],
  },
  execute: async (options, args, ctx) => {
    const path = String((args && args.path) || '').trim();
    if (!path) return { content: '请提供 path（要查看改动的文件路径）。', isError: true };
    const opened = openRepo(options, ctx);
    if (opened.error) return { content: opened.error, isError: true };
    try {
      if (!(await opened.git.isRepo())) return { content: NO_REPO_TEXT, isError: true };
      const model = await opened.git.diffModel(path);
      return { content: `--- ${path}\n${formatDiffText(model)}` };
    } catch (error) {
      return { content: `读取 git diff 失败：${String((error && error.message) || '')}`, isError: true };
    }
  },
};

export const GIT_LOG_TOOL_DEFINITION = {
  name: 'git_log',
  description: '查看本地提交历史（新 → 旧，最多 100 条）。用来确认之前几步都做了什么、'
    + '或找回某次改动对应的提交。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: `返回条数（默认 ${GIT_LOG_DEFAULT_LIMIT}，上限 ${GIT_LOG_MAX_LIMIT}）。` },
    },
    required: [],
  },
  execute: async (options, args, ctx) => {
    const raw = Number(args && args.limit);
    const limit = Number.isFinite(raw) && raw > 0
      ? Math.min(GIT_LOG_MAX_LIMIT, Math.floor(raw))
      : GIT_LOG_DEFAULT_LIMIT;
    const opened = openRepo(options, ctx);
    if (opened.error) return { content: opened.error, isError: true };
    try {
      if (!(await opened.git.isRepo())) return { content: NO_REPO_TEXT, isError: true };
      return { content: formatGitLog(await opened.git.log({ depth: limit })) };
    } catch (error) {
      return { content: `读取 git 历史失败：${String((error && error.message) || '')}`, isError: true };
    }
  },
};

export const GIT_TOOL_DEFINITIONS = Object.freeze([
  GIT_STATUS_TOOL_DEFINITION,
  GIT_DIFF_TOOL_DEFINITION,
  GIT_LOG_TOOL_DEFINITION,
]);
