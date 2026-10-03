// 工作区工具定义与注册。纯逻辑：root/fileSystem 由调用方注入（原生见 native.js）。

import { registerTool, unregisterTool } from '../agent/tools/registry.js';
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from './store.js';

const WORKSPACE_TOOL_DEFINITIONS = [
  {
    name: 'list_workspace_files',
    description: '列出工作区内的纯文本与 Markdown 文件（相对路径；目录以 / 结尾）。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        subdir: { type: 'string', description: '可选：只列出该子目录下的内容。' },
      },
    },
    execute: (options, args, ctx) => listWorkspaceFiles({
      root: options.root,
      characterId: ctx && ctx.characterId,
      fileSystem: options.fileSystem,
      subdir: typeof args.subdir === 'string' ? args.subdir : '',
    }).then(files => (files.length ? files.join('\n') : '（工作区为空）')),
  },
  {
    name: 'read_workspace_file',
    description: '读取工作区内某个纯文本或 Markdown 文件的完整内容。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径（.txt/.md/.markdown）。' },
      },
      required: ['path'],
    },
    execute: (options, args, ctx) => readWorkspaceFile({
      root: options.root,
      characterId: ctx && ctx.characterId,
      fileSystem: options.fileSystem,
      path: args.path,
    }).then(result => (result.truncated ? `${result.content}\n…（已截断）` : result.content)),
  },
  {
    name: 'write_workspace_file',
    description: '在工作区内新建或覆盖一个纯文本/Markdown 文件。仅「可改」模式可用。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径（.txt/.md/.markdown）。' },
        content: { type: 'string', description: '要写入的完整文本内容。' },
      },
      required: ['path', 'content'],
    },
    execute: (options, args, ctx) => writeWorkspaceFile({
      root: options.root,
      characterId: ctx && ctx.characterId,
      fileSystem: options.fileSystem,
      path: args.path,
      content: args.content,
    }).then(result => `已写入 ${result.path}（${result.length} 字符）`),
  },
];

export const WORKSPACE_TOOL_NAMES = Object.freeze(WORKSPACE_TOOL_DEFINITIONS.map(item => item.name));

export function createWorkspaceToolDefinitions({ root, fileSystem } = {}) {
  const options = { root, fileSystem };
  return WORKSPACE_TOOL_DEFINITIONS.map(definition => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    readOnly: definition.readOnly,
    execute: async (args, ctx) => definition.execute(options, args || {}, ctx || {}),
  }));
}

export function registerWorkspaceTools({ root, fileSystem } = {}) {
  for (const definition of createWorkspaceToolDefinitions({ root, fileSystem })) {
    registerTool(definition);
  }
  return WORKSPACE_TOOL_NAMES;
}

export function unregisterWorkspaceTools() {
  for (const name of WORKSPACE_TOOL_NAMES) unregisterTool(name);
}