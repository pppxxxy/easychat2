// 工作区模式设置（纯函数，零原生依赖，可 Node 直测）。
//
// 三模式与 agent 工具门控共用同一枚举：ask（纯对话）/ read（只读文件）/
// write（可在沙盒内改文件）。

import { AGENT_MODES } from '../agent/tools/registry.js';

export const WORKSPACE_MODES = Object.freeze([AGENT_MODES.ASK, AGENT_MODES.READ, AGENT_MODES.WRITE]);
export const DEFAULT_WORKSPACE_MODE = AGENT_MODES.ASK;

export function normalizeWorkspaceMode(value) {
  return WORKSPACE_MODES.includes(value) ? value : DEFAULT_WORKSPACE_MODE;
}

export function normalizeWorkspaceSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { mode: normalizeWorkspaceMode(source.mode) };
}