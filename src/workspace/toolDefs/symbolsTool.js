// 代码结构工具（list_symbols）——LSP-lite：列出一个源码文件的顶层符号与行号。
// 只读、零副作用；大文件先用它定位，再用 read_workspace_file 按 offset 精读。

import { WORKSPACE_LIMITS } from '../store.js';
import { extractSymbols, formatSymbols, languageFromPath } from '../symbols.js';

export const LIST_SYMBOLS_TOOL_DEFINITION = {
  name: 'list_symbols',
  description: '列出一个源码文件的顶层符号（函数/类/导出）与行号，便于在大文件里快速定位后再用'
    + ' read_workspace_file 精读。支持 JS/TS 与 Python（其它语言返回空）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '工作区相对路径。' } },
    required: ['path'],
  },
  execute: (options, args, ctx) => options.store.readWorkspaceFile({
    characterId: ctx && ctx.characterId,
    path: args.path,
    offset: 0,
    maxChars: WORKSPACE_LIMITS.MAX_READ_CHARS,
  }).then(result => formatSymbols(
    extractSymbols(result && result.content, languageFromPath(args.path)),
    args.path
  )),
};
