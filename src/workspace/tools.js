// 工作区工具定义与注册（**索引层**）。工具定义按域拆在 toolDefs/ 下：
//   readTools    —— 只读（列表 / 读取）
//   subagentTool —— 子代理（run_subagent）
//   writeTools   —— 写（建目录 / 写文件 / 精确替换）
//   docxTool     —— Word 导出（docx.js 惰性，不把 fflate 拖进静态链）
//   execTools    —— 命令执行定义（零 import；原生桥在各自域惰性取）
// 聚合在这一处的价值：注册与清单只有一个入口、顺序只有一个事实源。
//
// store 是「工作区后端」接口（list/read/write/writeBinary/edit），有两种实现：
// 应用私有根走 legacy（store.js 的 createLegacyWorkspaceStore），
// 用户自选的外部文件夹走 SAF（safStore.js 的 createSafWorkspaceStore）。
// 工具定义只认接口，不知道根在哪——换根不需要换工具。

import { registerTool, unregisterTool } from '../agent/tools/registry.js';
import { createLegacyWorkspaceStore } from './store.js';
import { SHELL_TOOL_TIMEOUT_MS } from './shell.js';
import { PYTHON_TOOL_TIMEOUT_MS } from './python.js';
import { READ_ONLY_TOOL_DEFINITIONS, formatWorkspaceReadResult } from './toolDefs/readTools.js';
import { PLAN_TOOL_DEFINITION } from './toolDefs/planTool.js';
import { WRITE_TOOL_DEFINITIONS } from './toolDefs/writeTools.js';
import { SUBAGENT_TOOL_DEFINITION } from './toolDefs/subagentTool.js';
import { DOCX_TOOL_DEFINITION } from './toolDefs/docxTool.js';
import { PYTHON_TOOL_DEFINITION, SHELL_TOOL_DEFINITION } from './toolDefs/execTools.js';

// 兼容导出：read 工具的格式化实现随定义搬去了 readTools.js，既有引用点（含测试）从这里取。
export { formatWorkspaceReadResult };

function resolveStore({ store, root, fileSystem } = {}) {
  if (store) return store;
  return createLegacyWorkspaceStore({ root, fileSystem });
}

// 基础工具（read / write 模式都进注册表）。**顺序是契约**：清单断言与模型看到的
// 工具次序都依赖它——只读 → 计划 → 子代理 → 写 → 导出。
const WORKSPACE_TOOL_DEFINITIONS = [
  ...READ_ONLY_TOOL_DEFINITIONS,
  PLAN_TOOL_DEFINITION,
  SUBAGENT_TOOL_DEFINITION,
  ...WRITE_TOOL_DEFINITIONS,
  DOCX_TOOL_DEFINITION,
];

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

export function createWorkspaceToolDefinitions({ store, root, fileSystem, shell, python, readLog, materializer } = {}) {
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
    // A5 会话级已读登记：宿主注入（工作区面板传会话内存；不传 = read 不登记，
    // 行为与旧版一致——聊天页等宿主无需感知这份状态）。
    ...(readLog ? { readLog } : {}),
    // C2 按需物化器：read 读不到时试一次（函数）；不传 = 不物化（旧行为）。
    ...(typeof materializer === 'function' ? { materializer } : {}),
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

export function registerWorkspaceTools({ store, root, fileSystem, shell, python, readLog, materializer } = {}) {
  const definitions = createWorkspaceToolDefinitions({ store, root, fileSystem, shell, python, readLog, materializer });
  for (const definition of definitions) registerTool(definition);
  return definitions.map(item => item.name);
}

export function unregisterWorkspaceTools() {
  // run_shell / run_python 不在基础清单里（它们按开关单独加），但注册过就必须能摘掉，
  // 否则关掉开关后它们仍留在注册表里——门控就漏了第一层。
  for (const name of [...WORKSPACE_TOOL_NAMES, SHELL_TOOL_NAME, PYTHON_TOOL_NAME]) unregisterTool(name);
}
