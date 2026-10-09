// 工作区工具定义与注册。纯逻辑：store 由调用方注入（原生见 native.js）。
//
// store 是「工作区后端」接口（list/read/write/writeBinary/edit），有两种实现：
// 应用私有根走 legacy（store.js 的 createLegacyWorkspaceStore），
// 用户自选的外部文件夹走 SAF（safStore.js 的 createSafWorkspaceStore）。
// 工具定义只认接口，不知道根在哪——换根不需要换工具。

import { runSubagent, SUBAGENT_TOOL_NAMES } from '../agent/subagent.js';
import { registerTool, unregisterTool } from '../agent/tools/registry.js';
import { buildDocxBytes, bytesToBase64, splitDocxParagraphs } from './docx.js';
import { postWriteNotices } from './hooks.js';
import { fileExtension } from './paths.js';
import { createLegacyWorkspaceStore, WORKSPACE_LIMITS } from './store.js';
import { SHELL_TOOL_TIMEOUT_MS } from './shell.js';
import { PYTHON_TOOL_TIMEOUT_MS } from './python.js';

function resolveStore({ store, root, fileSystem } = {}) {
  if (store) return store;
  return createLegacyWorkspaceStore({ root, fileSystem });
}

// 读取结果 → 工具输出文本。默认（从头读完整）原样返回（兼容既有行为）；
// 截断/分段时附续读提示，让模型知道总长与下一段 offset——大文件因此可分段读完。
export function formatWorkspaceReadResult(result) {
  const content = String((result && result.content) || '');
  const total = Number(result && result.total);
  const nextOffset = Number(result && result.nextOffset);
  if (Number.isFinite(total) && result && result.truncated === true && Number.isFinite(nextOffset)) {
    return `${content}\n…（已截断：共 ${total} 字符，本次为 ${result.offset}–${nextOffset}；继续读取请用 offset=${nextOffset}）`;
  }
  if (Number.isFinite(total) && Number(result && result.offset) > 0) {
    return `${content}\n（已到文件末尾：共 ${total} 字符）`;
  }
  return content;
}

const WORKSPACE_TOOL_DEFINITIONS = [
  {
    name: 'list_workspace_files',
    description: '列出工作区内的文件（相对路径；目录以 / 结尾）。可用来了解项目结构。',
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
    description: '读取工作区内某个文本文件（源码、配置、Markdown 等）。大文件可分段读：默认从头读最多 100 万字符，返回里会标注总长与下一段 offset，必要时用 offset/limit 继续读。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径（如 src/index.js、README.md）。' },
        offset: { type: 'number', description: '可选：从文件第几个字符开始读（默认 0）。' },
        limit: { type: 'number', description: '可选：本次最多读取的字符数（默认与上限 1000000）。' },
      },
      required: ['path'],
    },
    execute: (options, args, ctx) => {
      const rawOffset = Number(args.offset);
      const rawLimit = Number(args.limit);
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
      const maxChars = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), WORKSPACE_LIMITS.MAX_READ_CHARS)
        : undefined;
      return options.store.readWorkspaceFile({
        characterId: ctx && ctx.characterId,
        path: args.path,
        offset,
        ...(maxChars !== undefined ? { maxChars } : {}),
      }).then(formatWorkspaceReadResult);
    },
  },
  {
    name: 'run_subagent',
    description: '把一个「研究型子任务」委托给助手的一个独立分身：它只能读工作区文件'
      + '（不能改任何东西），完成后把整理好的结论交回来。适合「翻很多文件找答案」'
      + '这类会刷屏的任务——中间过程不会占用当前对话的上下文。task 里要写清'
      + '「要找什么、要回答什么」，结论回来后再由你转述或继续加工。',
    readOnly: true,
    // 子代理要跑多轮模型请求，默认工具超时（十几秒）不够；180s 是防跑飞的上限。
    timeoutMs: 180000,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务描述（要找什么、要回答什么）。' },
      },
      required: ['task'],
    },
    execute: async (options, args, ctx) => {
      // 只读工具按**名字白名单**过滤（不含 run_subagent——它自己也是 readOnly，
      // 只看标志会递归）：防递归是结构性的，不靠"记得别给"。
      const readOnlyTools = WORKSPACE_TOOL_DEFINITIONS.filter(item => SUBAGENT_TOOL_NAMES.includes(item.name));
      const result = await runSubagent({
        task: args.task,
        tools: readOnlyTools,
        store: options.store,
        characterId: ctx && ctx.characterId,
        signal: (ctx && ctx.signal) || null,
      });
      return result.isError ? { content: result.content, isError: true } : result.content;
    },
  },
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
    // 读钩子失败当没有钩子——提醒链路的任何问题都不该影响写入本身。
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

// 命令执行工具单独列：它只在「开关开 + 应用私有根 + 原生模块可用」时被加进来，
// 所以它的存在本身就是第一层门控。requiresConfirmation 是第三层（逐条弹框）。
const SHELL_TOOL_DEFINITION = {
  name: 'run_shell',
  description: '在应用私有工作区内执行一条 shell（sh）命令。仅「可改」模式且用户开启命令执行时可用，每条命令都会先请用户确认。注意：它只能访问应用自己的沙盒与系统公开路径，看不到你选的手机文件夹；输出过大时会截断。',
  readOnly: false,
  requiresConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（经 /system/bin/sh -c 执行）。' },
    },
    required: ['command'],
  },
  execute: (options, args, ctx) => options.shell.run({
    command: args.command,
    signal: ctx && ctx.signal,
    characterId: ctx && ctx.characterId,
  }),
};

// Python 执行工具。与 run_shell 同一套三层门控（不注册 → 不进清单 → 逐条确认），
// 差别在两处：
// 1) 它需要**另一个开关**（允许模型运行 Python）——Python 能联网、能读整个应用沙盒，
//    与 shell 是两条独立的执行面，不该共用一个开关；
// 2) 脚本跑在独立进程里（:python），超时会被强杀——所以模型用它不会把应用占死。
const PYTHON_TOOL_DEFINITION = {
  name: 'run_python',
  description: '在应用私有工作区中执行一段 Python 代码（Chaquopy 内置 CPython）。仅「可改」模式且用户开启「允许模型运行 Python」时可用，每次执行都会先请用户确认。没有运行时 pip，只能用已打进包的库（requests 等）；工作目录是该角色的工作区子目录；脚本在独立进程里运行，超时会被强制终止，输出过大时会截断。',
  readOnly: false,
  requiresConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的 Python 代码（单段脚本，不是交互式会话；每次执行的状态不保留）。' },
    },
    required: ['code'],
  },
  execute: (options, args, ctx) => options.python.run({
    code: args.code,
    signal: ctx && ctx.signal,
    characterId: ctx && ctx.characterId,
  }),
};

export const WORKSPACE_TOOL_NAMES = Object.freeze(WORKSPACE_TOOL_DEFINITIONS.map(item => item.name));
export const SHELL_TOOL_NAME = SHELL_TOOL_DEFINITION.name;
export const PYTHON_TOOL_NAME = PYTHON_TOOL_DEFINITION.name;

// 需要长超时的执行类工具（用户确认 + 执行本身都慢）。其余工具用注册表的默认超时。
const SLOW_TOOL_TIMEOUTS = Object.freeze({
  [SHELL_TOOL_NAME]: SHELL_TOOL_TIMEOUT_MS,
  [PYTHON_TOOL_NAME]: PYTHON_TOOL_TIMEOUT_MS,
});

// 执行工具的 runner 有两套形态在流通：
//  · native 侧 createShellRunner / createPythonRunner 返回**裸 async 函数**
//    （终端面板与设置里的手动运行直接调它）；
//  · 工具执行路径要求 { run } 对象（SHELL_TOOL_DEFINITION.execute 调 options.shell.run）。
// 2026-10-09 事故：本函数此前只认后者，裸函数被形状检查无声丢弃——run_shell /
// run_python 在任何配置下都进不了注册表（现象：手动跑 Python 成功、agent 侧工具表
// 里没有它）。在入口归一、一处收口，不让 native.js 去包装——那会让「终端/手动」
// 与「工具」两条路分叉出两种契约，下一次改动还会踩。
function toRunner(runner) {
  if (typeof runner === 'function') return { run: runner };
  return runner && typeof runner === 'object' ? runner : null;
}

export function createWorkspaceToolDefinitions({ store, root, fileSystem, shell, python } = {}) {
  const resolvedShell = toRunner(shell);
  const resolvedPython = toRunner(python);
  const shellUsable = !!(resolvedShell && typeof resolvedShell.run === 'function');
  const pythonUsable = !!(resolvedPython && typeof resolvedPython.run === 'function');
  // options 必须带上 runner 本身：execute 走的是 options.shell.run(...)——
  // 只放 store 的话，门控放行后执行时也会 TypeError（同一函数里的第二处断裂）。
  const options = {
    store: resolveStore({ store, root, fileSystem }),
    ...(shellUsable ? { shell: resolvedShell } : {}),
    ...(pythonUsable ? { python: resolvedPython } : {}),
  };
  const definitions = [
    ...WORKSPACE_TOOL_DEFINITIONS,
    ...(shellUsable ? [SHELL_TOOL_DEFINITION] : []),
    ...(pythonUsable ? [PYTHON_TOOL_DEFINITION] : []),
  ];
  return definitions.map(definition => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    readOnly: definition.readOnly,
    // 只有 run_shell / run_python 会带 true；其余工具保持 undefined，注册表归一化成 false。
    ...(definition.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(SLOW_TOOL_TIMEOUTS[definition.name] ? { timeoutMs: SLOW_TOOL_TIMEOUTS[definition.name] } : {}),
    execute: async (args, ctx) => definition.execute(options, args || {}, ctx || {}),
  }));
}

export function registerWorkspaceTools({ store, root, fileSystem, shell, python } = {}) {
  const definitions = createWorkspaceToolDefinitions({ store, root, fileSystem, shell, python });
  for (const definition of definitions) registerTool(definition);
  return definitions.map(item => item.name);
}

export function unregisterWorkspaceTools() {
  // run_shell / run_python 不在基础清单里（它们按开关单独加），但注册过就必须能摘掉，
  // 否则关掉开关后它们仍留在注册表里——门控就漏了第一层。
  for (const name of [...WORKSPACE_TOOL_NAMES, SHELL_TOOL_NAME, PYTHON_TOOL_NAME]) unregisterTool(name);
}