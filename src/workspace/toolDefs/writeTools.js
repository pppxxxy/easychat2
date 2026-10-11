// 写工具定义（建目录 / 写文件 / 精确替换）：仅「可改」模式可用。
//
// after_write / after_edit 钩子（.easychat/hooks.json 的事后提醒）在写成功后把
// 提醒追加进工具结果——读钩子失败当没有钩子，绝不影响写入本身。

import { postWriteNotices } from '../hooks.js';
import { recordFileHistory } from '../fileHistory.js';
import { assertWritableWorkspacePath } from '../paths.js';

// J1：写前快照（尽力而为）——读旧内容入 file-history；失败不阻塞写入。
// 读上限与推送同口径（宽于导入文本线 5MB），截断的内容不配当"旧版本"。
const SNAPSHOT_READ_MAX_CHARS = 8 * 1024 * 1024;

async function snapshotBeforeWrite(store, characterId, path, enabled = true) {
  // W7 退旧：本地 git 开着时宿主会传 enabled=false——写前快照与回合检查点/丢弃是同一件事，
  // 两份历史并存只会让「哪份才算数」变模糊（SAF 根下 git 不可用，仍会传 true）。
  if (!enabled) return;
  let oldContent = '';
  try {
    const previous = await store.readWorkspaceFile({
      characterId,
      path,
      maxChars: SNAPSHOT_READ_MAX_CHARS,
    });
    if (previous && previous.truncated === true) {
      // 读不全的旧文件不做快照（截断内容不配当"旧版本"），如实跳过。
      return;
    }
    oldContent = String((previous && previous.content) ?? '');
  } catch (error) {
    oldContent = ''; // 新建（文件不存在是常态）
  }
  try {
    await recordFileHistory(store, characterId, { path, oldContent, source: 'tool' });
  } catch (error) {}
}

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
      // 审计/快照文件不可改写（在快照之前拦：被拒的写入不该留下快照记录）。
      assertWritableWorkspacePath(args.path);
      // J1：落笔前快照旧内容（删除也可逆——新建记空内容）。
      await snapshotBeforeWrite(options.store, ctx && ctx.characterId, args.path, options.recordFileHistory !== false);
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
      // 审计/快照文件不可改写（同 write：拦在快照之前）。
      assertWritableWorkspacePath(args.path);
      // J1：编辑同样是覆盖——先快照（find/replace 是全量读改写，旧内容只有这一次机会）。
      await snapshotBeforeWrite(options.store, ctx && ctx.characterId, args.path, options.recordFileHistory !== false);
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
