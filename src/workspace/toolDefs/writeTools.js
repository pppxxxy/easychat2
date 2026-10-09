// 写工具定义（建目录 / 写文件 / 精确替换）：仅「可改」模式可用。
//
// after_write / after_edit 钩子（.easychat/hooks.json 的事后提醒）在写成功后把
// 提醒追加进工具结果——读钩子失败当没有钩子，绝不影响写入本身。

import { postWriteNotices } from '../hooks.js';

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: 'create_workspace_dir',
    description: '在工作区内新建（或确认已存在）一个文件夹，用于组织项目文件。仅「可改」模式可用。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对目录路径，如 src/components。' },
      },
      required: ['path'],
    },
    execute: (options, args, ctx) => options.store.createWorkspaceDirectory({
      characterId: ctx && ctx.characterId,
      path: args.path,
    }).then(result => `已创建目录 ${result.path}`),
  },
  {
    name: 'write_workspace_file',
    description: '在工作区内新建或覆盖一个文本文件（源码、配置、HTML/CSS/JS、Markdown 等任意文本类型；自动创建上级目录）。仅「可改」模式可用。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径（如 src/app.js、index.html）。' },
        content: { type: 'string', description: '要写入的完整文本内容。' },
      },
      required: ['path', 'content'],
    },
    // after_write 钩子：写成功后的提醒追加进工具结果（模型看得到、可能照做）。
    execute: async (options, args, ctx) => {
      const result = await options.store.writeWorkspaceFile({
        characterId: ctx && ctx.characterId,
        path: args.path,
        content: args.content,
      });
      const base = `已写入 ${result.path}（${result.length} 字符）`;
      const notices = await postWriteNotices(options.store, ctx && ctx.characterId, 'after_write', result.path);
      return notices.length > 0 ? `${base}\n\n[工作区钩子] ${notices.join('；')}` : base;
    },
  },
  {
    name: 'edit_workspace_file',
    description: '在工作区内按精确文本替换修改文件：把 find 换成 replace。默认要求 find 恰好出现一次；要一次替换多处须显式传 all:true。仅「可改」模式可用。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径。' },
        find: { type: 'string', description: '要被替换的原文（须与文件内容逐字一致，含缩进与换行）。' },
        replace: { type: 'string', description: '替换成的新文本。' },
        all: { type: 'boolean', description: '可选：true 时替换全部匹配（默认只替换唯一一处，多处匹配会报错）。' },
      },
      required: ['path', 'find', 'replace'],
    },
    // after_edit 钩子：同 after_write（提醒追加进结果，失败不影响编辑本身）。
    execute: async (options, args, ctx) => {
      const result = await options.store.editWorkspaceFile({
        characterId: ctx && ctx.characterId,
        path: args.path,
        find: args.find,
        replace: args.replace,
        all: args.all === true,
      });
      const base = `已修改 ${result.path}（替换 ${result.count} 处）`;
      const notices = await postWriteNotices(options.store, ctx && ctx.characterId, 'after_edit', result.path);
      return notices.length > 0 ? `${base}\n\n[工作区钩子] ${notices.join('；')}` : base;
    },
  },
];
