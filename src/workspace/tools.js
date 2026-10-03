// 工作区工具定义与注册。纯逻辑：store 由调用方注入（原生见 native.js）。
//
// store 是「工作区后端」接口（list/read/write/writeBinary/edit），有两种实现：
// 应用私有根走 legacy（store.js 的 createLegacyWorkspaceStore），
// 用户自选的外部文件夹走 SAF（safStore.js 的 createSafWorkspaceStore）。
// 工具定义只认接口，不知道根在哪——换根不需要换工具。

import { registerTool, unregisterTool } from '../agent/tools/registry.js';
import { buildDocxBytes, bytesToBase64, splitDocxParagraphs } from './docx.js';
import { fileExtension } from './paths.js';
import { createLegacyWorkspaceStore } from './store.js';

function resolveStore({ store, root, fileSystem } = {}) {
  if (store) return store;
  return createLegacyWorkspaceStore({ root, fileSystem });
}

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
    execute: (options, args, ctx) => options.store.listWorkspaceFiles({
      characterId: ctx && ctx.characterId,
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
    execute: (options, args, ctx) => options.store.readWorkspaceFile({
      characterId: ctx && ctx.characterId,
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
    execute: (options, args, ctx) => options.store.writeWorkspaceFile({
      characterId: ctx && ctx.characterId,
      path: args.path,
      content: args.content,
    }).then(result => `已写入 ${result.path}（${result.length} 字符）`),
  },
  {
    name: 'export_workspace_docx',
    description: '把一段文本导出为工作区内的 Word 文档（.docx）。仅「可改」模式可用。',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径，须以 .docx 结尾。' },
        content: { type: 'string', description: '正文文本（按换行分段）。' },
        title: { type: 'string', description: '可选标题（Heading 1）。' },
      },
      required: ['path', 'content'],
    },
    execute: (options, args, ctx) => {
      if (fileExtension(args.path) !== 'docx') {
        throw new Error('Word 导出路径必须以 .docx 结尾。');
      }
      const bytes = buildDocxBytes({
        title: typeof args.title === 'string' ? args.title : '',
        paragraphs: splitDocxParagraphs(args.content),
      });
      return options.store.writeWorkspaceBinaryFile({
        characterId: ctx && ctx.characterId,
        path: args.path,
        base64: bytesToBase64(bytes),
      }).then(result => `已导出 ${result.path}（${bytes.length} 字节）`);
    },
  },
];

export const WORKSPACE_TOOL_NAMES = Object.freeze(WORKSPACE_TOOL_DEFINITIONS.map(item => item.name));

export function createWorkspaceToolDefinitions({ store, root, fileSystem } = {}) {
  const options = { store: resolveStore({ store, root, fileSystem }) };
  return WORKSPACE_TOOL_DEFINITIONS.map(definition => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    readOnly: definition.readOnly,
    execute: async (args, ctx) => definition.execute(options, args || {}, ctx || {}),
  }));
}

export function registerWorkspaceTools({ store, root, fileSystem } = {}) {
  for (const definition of createWorkspaceToolDefinitions({ store, root, fileSystem })) {
    registerTool(definition);
  }
  return WORKSPACE_TOOL_NAMES;
}

export function unregisterWorkspaceTools() {
  for (const name of WORKSPACE_TOOL_NAMES) unregisterTool(name);
}