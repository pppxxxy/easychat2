// 工作区模式设置（纯函数，零原生依赖，可 Node 直测）。
//
// 三模式与 agent 工具门控共用同一枚举：ask（纯对话）/ read（只读文件）/
// write（可在沙盒内改文件）。
//
// 除模式外还持久化三件事：
// - location：工作区根。默认应用私有目录；用户可改选手机上的一个文件夹
//   （Android SAF，授权持久化）。角色子目录始终在根之内。
// - allowCommandExecution：命令执行开关（默认关，且与模式相互独立——
//   改模式不能顺手打开它）。
// - allowPythonExecution：模型运行 Python 的开关（默认关，同样与模式独立）。
//   与命令执行**分开**是因为它们是两条独立的执行面：Python 能联网、能读整个应用沙盒，
//   风险面不同，不该共用一个开关（改一个把另一个也打开，是安全开关最糟的形态）。

import { AGENT_MODES } from '../agent/tools/registry.js';
import { WORKSPACE_ROOT_KINDS, normalizeWorkspaceLocation } from './location.js';

export const WORKSPACE_MODES = Object.freeze([AGENT_MODES.ASK, AGENT_MODES.READ, AGENT_MODES.WRITE]);
export const DEFAULT_WORKSPACE_MODE = AGENT_MODES.ASK;

export function normalizeWorkspaceMode(value) {
  return WORKSPACE_MODES.includes(value) ? value : DEFAULT_WORKSPACE_MODE;
}

// 执行类开关只在「可改」模式下有意义：只读/询问模式即便开关是开的不生效，
// 归一化时如实回写 false，避免设置里显示「已开启」但工具根本不存在。
export function normalizeAllowCommandExecution(value, mode) {
  if (normalizeWorkspaceMode(mode) !== AGENT_MODES.WRITE) return false;
  return value === true;
}

export function normalizeAllowPythonExecution(value, mode) {
  if (normalizeWorkspaceMode(mode) !== AGENT_MODES.WRITE) return false;
  return value === true;
}

export function normalizeWorkspaceSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    mode: normalizeWorkspaceMode(source.mode),
    location: normalizeWorkspaceLocation(source.location),
    allowCommandExecution: normalizeAllowCommandExecution(source.allowCommandExecution, source.mode),
    allowPythonExecution: normalizeAllowPythonExecution(source.allowPythonExecution, source.mode),
    // 工作区角色（面板顶部选择；空 = 未设置，面板打开时落到默认工作助手，该卡不存在则回落内置助手）。
    assistantCharacterId: String(source.assistantCharacterId || '').trim(),
  };
}

export function isExternalWorkspaceRoot(settings) {
  return normalizeWorkspaceSettings(settings).location.kind === WORKSPACE_ROOT_KINDS.SAF;
}
