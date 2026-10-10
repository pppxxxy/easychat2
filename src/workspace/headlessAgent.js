// 无头 agent 运行器（P3-8）：给本地 API 服务的 POST /v1/agent 端点用——程序化驱动
// 一轮 agent 工具循环（模型 + 工作区工具），返回结论文本与工具步骤。
//
// 复用与工作区聊天同一套组装：默认工作区角色沙盒 + 系统提示（记忆/技能/分身/团队）+ 注册表工具。
// 工具是**全局注册表**，运行前后注册/注销；端点请求经共享串行队列，不会与聊天推理并发。

import { runAgentTurn } from '../agent/loop.js';
import { listToolsForMode } from '../agent/tools/registry.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { createWorkspaceStore } from './native.js';
import { resolveWorkspaceAssistant } from './assistant.js';
import { buildWorkspaceAgentSystemPrompt } from './chat.js';
import { readWorkspaceMemory } from './memory.js';
import { readWorkspaceSkills } from './skills.js';
import { readWorkspaceAgents } from './agents.js';
import { readWorkspaceTeams } from './teams.js';
import { registerWorkspaceTools, unregisterWorkspaceTools } from './tools.js';

// 跑一轮 agent。返回 { text, steps, characterId, mode }。缺 prompt 且无历史 → 空结果。
export async function runHeadlessAgent({
  prompt = '',
  messages = [],
  mode = 'read',
  maxRounds = 0,
  characterId = '',
  signal = null,
} = {}) {
  const text = String(prompt || '').trim();
  const history = (Array.isArray(messages) ? messages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({ role: item.role, content: item.content }));
  if (!text && history.length === 0) return { text: '', steps: [], mode, characterId };

  const settings = await getWorkspaceSettings();
  const store = createWorkspaceStore(settings);
  const resolved = await resolveWorkspaceAssistant(characterId).catch(() => null);
  const character = resolved && resolved.character;
  const ownerId = String((character && character.id) || characterId || '');
  const characterName = String((character && character.name) || '');

  registerWorkspaceTools({ store });
  const steps = [];
  try {
    const tools = listToolsForMode(mode).map(item => item.function.name);
    const memory = await readWorkspaceMemory(store, ownerId).catch(() => '');
    const skills = mode === 'ask' ? [] : await readWorkspaceSkills(store, ownerId).catch(() => []);
    const agents = mode === 'ask' ? [] : await readWorkspaceAgents(store, ownerId).catch(() => []);
    const teams = mode === 'ask' ? [] : await readWorkspaceTeams(store, ownerId).catch(() => []);
    const systemPrompt = buildWorkspaceAgentSystemPrompt({ mode, characterName, tools, memory, skills, agents, teams });
    const result = await runAgentTurn([
      { role: 'system', content: systemPrompt },
      ...history,
      ...(text ? [{ role: 'user', content: text }] : []),
    ], {
      mode,
      ...(maxRounds > 0 ? { maxRounds } : {}),
      signal,
      context: { characterId: ownerId },
      onToolEvent: event => {
        if (event && event.phase === 'start' && event.name) steps.push({ name: event.name });
      },
    });
    const output = typeof result === 'string' ? result : String((result && result.text) || '');
    return { text: output, steps, mode, characterId: ownerId };
  } finally {
    unregisterWorkspaceTools();
  }
}
