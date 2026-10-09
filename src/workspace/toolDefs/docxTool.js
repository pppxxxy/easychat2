// Word 导出工具定义（export_workspace_docx）。
//
// **docx.js 惰性 require**：它的静态链会拉 fflate（第三方 zip 库）——让「加载工作区
// 工具定义」平白多出一条 node_modules 依赖，所有 import tools.js 的测试都被迫装包。
// 绝大多数调用（读/写/搜索/子代理）用不到 Word 导出；把这份代价挪到真正导出的那一刻。
// 拿不到模块时如实报「不可用」（Metro/RN 里正常可用；纯 Node 未装 fflate 时才走这条）。

import { tActive } from '../../i18n/index.js';
import { fileExtension } from '../paths.js';

let docxCache;
// 注入点：默认走惰性 require；纯 ESM 测试环境（没有 require）可注入模块实例。
// 生产不需要调用它——存在只是让「docx 是可选组件」这件事可被测试表达。
let docxOverride = null;
export function setDocxModule(module) {
  docxOverride = module || null;
}

function getDocxModule() {
  if (docxOverride) return docxOverride;
  if (docxCache !== undefined) return docxCache;
  try {
    docxCache = require('../docx.js');
  } catch (error) {
    docxCache = null;
  }
  return docxCache;
}

export const DOCX_TOOL_DEFINITION = {
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
      throw new Error(tActive('error.workspace.docxPathSuffix'));
    }
    const docx = getDocxModule();
    if (!docx || typeof docx.buildDocxBytes !== 'function') {
      throw new Error(tActive('error.workspace.docxUnsupported'));
    }
    const bytes = docx.buildDocxBytes({
      title: typeof args.title === 'string' ? args.title : '',
      paragraphs: docx.splitDocxParagraphs(args.content),
    });
    return options.store.writeWorkspaceBinaryFile({
      characterId: ctx && ctx.characterId,
      path: args.path,
      base64: docx.bytesToBase64(bytes),
    }).then(result => `已导出 ${result.path}（${bytes.length} 字节）`);
  },
};
