// 子代理 / 工作流共用的工具集（审查修复 F3：此前两处各写一份白名单，工作流那份漏了
// search_workspace——同一件事两个事实源，必然漂移）。
//
// 为什么放 workspace/toolDefs/ 而不是 agent/subagent.js：白名单要引 workspace 的工具定义
//（readTools / searchTool / writeTools），而 agent/ 不该反向依赖 workspace/（分层纪律）。
// 放这里两边都能引，且只有一份。

import { AGENT_MODES } from '../../agent/tools/registry.js';
import { SUBAGENT_TOOL_NAMES, SUBAGENT_WRITE_TOOL_NAMES } from '../../agent/subagent.js';
import { READ_ONLY_TOOL_DEFINITIONS } from './readTools.js';
import { SEARCH_TOOL_DEFINITION } from './searchTool.js';
import { WRITE_TOOL_DEFINITIONS } from './writeTools.js';

// mode='read' → 只读两项 + search_workspace；mode='write' → 再叠加写三项。
// 防递归是结构性的：名单里没有 run_subagent / run_workflow，也没有执行类。
export function subagentToolSet(mode = 'read') {
  const read = READ_ONLY_TOOL_DEFINITIONS
    .concat([SEARCH_TOOL_DEFINITION])
    .filter(item => SUBAGENT_TOOL_NAMES.includes(item.name));
  if (String(mode || '').toLowerCase() !== 'write') return read;
  return read.concat(WRITE_TOOL_DEFINITIONS.filter(item => SUBAGENT_WRITE_TOOL_NAMES.includes(item.name)));
}

// 审查修复 F1：**宿主模式才是授权**，模型传的 args.mode 只是「请求」。
// 子代理是直接调 tool.execute（不经过注册表），所以注册表的模式门控管不到它——
// 必须在入口自己判。语义与 registry.canRunTool 对齐：缺省（undefined）= ask = 不放行。
export function hostAllowsWrite(ctx) {
  return !!(ctx && ctx.mode === AGENT_MODES.WRITE);
}
