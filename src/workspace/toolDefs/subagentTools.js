// 子代理可用工具表的**唯一装配点**（read / write 两种模式共用）。
//
// 为什么要有这个模块：run_subagent 与 run_workflow 各自拼过一遍「只读来源 + 写来源」，
// 两份逻辑长得几乎一样、又不是同一份代码——于是修 search_workspace 时只修了 subagentTool，
// workflowTool 没跟上：工作流子代理拿不到搜索工具，而它的提示词还在让模型用 search_workspace
//（2026-10-11 逐行审查 P1-3）。两份近似代码就是「只修一处」的温床，所以收成一个函数。
//
// 两条结构性纪律（不是靠"记得别给"）：
// 1. **只读对象直接引 readTools/searchTool**，不经全局注册表过滤——子代理在结构上就拿不到
//    别的工具（含它自己）。run_subagent 自身也是 readOnly 工具，只看 readOnly 标志会把它
//    放进来递归，所以按**名字白名单**收（SUBAGENT_TOOL_NAMES 永远不含 run_subagent）。
// 2. **写来源只来自 writeTools 的白名单**，永远不含 run_subagent / 执行类（run_shell、
//    run_python）/ 远端类——防递归 + 防越权。

import { SUBAGENT_TOOL_NAMES, SUBAGENT_WRITE_TOOL_NAMES } from '../../agent/subagent.js';
import { READ_ONLY_TOOL_DEFINITIONS } from './readTools.js';
import { SEARCH_TOOL_DEFINITION } from './searchTool.js';
import { WRITE_TOOL_DEFINITIONS } from './writeTools.js';

// 只读来源 = readTools 两项（list / read）+ searchTool（search_workspace）。
// **新增只读工具时改这一处**：两个调用方自动跟上，不会再出现「只修了 run_subagent」。
export const SUBAGENT_READ_SOURCE = Object.freeze(
  READ_ONLY_TOOL_DEFINITIONS.concat([SEARCH_TOOL_DEFINITION])
);
// 写来源 = writeTools 的三个（create_dir / write / edit）。
export const SUBAGENT_WRITE_SOURCE = Object.freeze(
  WRITE_TOOL_DEFINITIONS.filter(item => SUBAGENT_WRITE_TOOL_NAMES.includes(item.name))
);

// 按模式给出子代理工具表。mode 非 'write' 一律当只读（fail-closed：写要多一道显式声明）。
export function buildSubagentTools(mode = 'read') {
  const readTools = SUBAGENT_READ_SOURCE.filter(item => SUBAGENT_TOOL_NAMES.includes(item.name));
  if (String(mode == null ? '' : mode).toLowerCase() !== 'write') return readTools;
  return readTools.concat(SUBAGENT_WRITE_SOURCE);
}
