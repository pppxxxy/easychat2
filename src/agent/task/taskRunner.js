// 定时 Agent 任务的执行器（装配上下文 + 跑工具循环 + 落库 + 通知）。
//
// 设计要点：
// - 顶层只 import 纯模块（message 组装、日期、提示词），全部重依赖（网络 / 工作区 /
//   Agent 循环 / 存储 / 原生桥）都在 defaultDeps() 里**惰性 import**，使本模块可在纯
//   Node 下加载——单测注入自己的 deps，不碰原生模块。
// - 前台调度器与无界面（headless）执行器共用这一个 runAgentTask：
//     先 markRun 认领「今日」→ 跑循环 → 直接 appendProactiveMessage 落库 → 通知。
//   先认领再执行，保证同一任务同日不重复生成（跨 headless/前台两个 JS 运行时的最简去重）。
//
// 工具范围（用户定的）：联网搜索 + 只读工作区。写入类 / 需逐条确认的工具无人值守时
// 不暴露（mode='read' 且不接 onToolApproval，registry 对需确认工具默认拒绝）。

import { buildRequestMessages } from '../../prompt/chatPipeline.js';
import { buildTimeAwareText } from '../../chat/currentTime.js';
import { buildAgentTaskExtraPrompt, describeAgentTaskTools } from './taskPrompt.js';
import { localDateKey } from './taskModel.js';

// 历史对话快照上限：与主动消息一致，避免上下文过大。
export const AGENT_TASK_HISTORY_LIMIT = 20;

// 交给模型的目标消息占位（用户此刻没开口，这是一次自主任务）。
const AGENT_TASK_USER_TEXT = '（定时任务，请现在执行）';

// 组装发给模型的消息数组（纯函数，可 Node 直测）。
export function buildAgentTaskMessages({
  character,
  historyMessages = [],
  userProfile = null,
  globalPresets = [],
  summaryText = '',
  instruction = '',
  tools = [],
  timeAware = true,
  scheduleText = '',
  now = new Date(),
} = {}) {
  const trimmedHistory = (Array.isArray(historyMessages) ? historyMessages : [])
    .filter(item => item && !item.pending && (item.role === 'user' || item.role === 'assistant'))
    .slice(-AGENT_TASK_HISTORY_LIMIT);
  const extraSystemPrompt = buildAgentTaskExtraPrompt({
    instruction,
    toolHint: describeAgentTaskTools(tools),
  });
  const currentTimeText = timeAware ? buildTimeAwareText(true, now) : '';
  return buildRequestMessages({
    character,
    historyMessages: trimmedHistory,
    userText: AGENT_TASK_USER_TEXT,
    userProfile,
    globalPresets,
    summaryText,
    extraSystemPrompt,
    currentTimeText,
    scheduleText,
  });
}

// 从会话读出历史与摘要（无目标会话时均为空）。
async function loadSessionContext(task, deps) {
  const targetId = String((task && task.sessionTargetId) || '');
  const character = task && task.character;
  if (!targetId) return { historyMessages: [], summaryText: '' };
  try {
    const [messages, summaries, sessions] = await Promise.all([
      deps.getMessagesBySession(targetId),
      deps.getSessionSummaries(targetId),
      deps.getSessions(),
    ]);
    const scoped = deps.isBuiltinAssistant(character)
      || deps.isSessionScopedMemory(sessions, character && character.id, undefined, targetId);
    const summaryText = deps.buildMemorySummaryText(
      character,
      Array.isArray(summaries) ? summaries : [],
      scoped
    );
    return { historyMessages: Array.isArray(messages) ? messages : [], summaryText };
  } catch (error) {
    return { historyMessages: [], summaryText: '' };
  }
}

// 生效的 sessionTargetId：指定的会话若已不属于该角色，视为空（新建对话）。
async function resolveValidTarget(task, deps) {
  const targetId = String((task && task.sessionTargetId) || '');
  if (!targetId) return '';
  try {
    const sessions = await deps.getSessions();
    const owned = (Array.isArray(sessions) ? sessions : []).some(session => (
      session
      && session.type !== 'group'
      && String(session.id || '') === targetId
      && String(session.characterId || '') === String(task.roleId || '')
    ));
    return owned ? targetId : '';
  } catch (error) {
    return '';
  }
}

// 默认依赖：全部惰性 import，保持本模块 Node 可加载。
async function defaultDeps() {
  const [
    { getCharacterLibrary },
    { getMessagesBySession, getSessionSummaries, appendProactiveMessage },
    { getSessions },
    { getEnabledGlobalPresetPrompts },
    { getUserProfile },
    { getCharacterSchedule },
    { getWorkspaceSettings },
    { registerDefaultWorkspaceTools },
    { getPlugins },
    { resolveSearchPluginConfig, registerChatTools },
    { listToolsForMode },
    { runAgentTurn, workspaceRoundBudget },
    { isScheduleActive, buildSchedulePrompt },
    { markAgentTaskRun, bindAgentTaskSession },
    { isBuiltinAssistant, isSessionScopedMemory, buildMemorySummaryText },
    { notifyAgentTaskResult },
  ] = await Promise.all([
    import('../../storage/characters.js'),
    import('../../storage/sessionMessages.js'),
    import('../../storage/sessions.js'),
    import('../../storage/globalPresets.js'),
    import('../../storage/personas.js'),
    import('../../storage/schedule.js'),
    import('../../storage/workspace.js'),
    import('../../workspace/native.js'),
    import('../../storage/settings/plugins.js'),
    import('../../chat/chatTools.js'),
    import('../tools/registry.js'),
    import('../loop.js'),
    import('../../chat/schedule.js'),
    import('../../storage/agentTasks.js'),
    import('../../memory/memorySummary.js'),
    import('./agentTaskNative.js'),
  ]);

  const loadCharacter = async roleId => {
    const list = await getCharacterLibrary().catch(() => []);
    return (Array.isArray(list) ? list : []).find(item => item && item.id === roleId) || null;
  };

  // 工具集：只读工作区 + 联网搜索（搜索服务已配置才注册/放行）。
  const buildTools = async () => {
    let workspaceSettings = null;
    try {
      workspaceSettings = await getWorkspaceSettings();
      registerDefaultWorkspaceTools(workspaceSettings);
    } catch (error) {
      workspaceSettings = null;
    }
    let searchEnabled = false;
    try {
      const plugins = await getPlugins().catch(() => []);
      searchEnabled = Boolean(resolveSearchPluginConfig(plugins));
      if (searchEnabled) registerChatTools();
    } catch (error) {
      searchEnabled = false;
    }
    return listToolsForMode('read', { allowChatTools: searchEnabled });
  };

  return {
    loadCharacter,
    buildTools,
    getMessagesBySession,
    getSessionSummaries,
    getSessions,
    getEnabledGlobalPresetPrompts,
    getUserProfile,
    getCharacterSchedule,
    isScheduleActive,
    buildSchedulePrompt,
    isBuiltinAssistant,
    isSessionScopedMemory,
    buildMemorySummaryText,
    runAgentTurn,
    roundBudget: workspaceRoundBudget,
    appendProactiveMessage,
    markAgentTaskRun,
    bindAgentTaskSession,
    notifyAgentTaskResult,
  };
}

// 执行一条任务。返回 { ok, reason, text, sessionId }。
// 语义：只要「认领」成功（markRun 写入了今天的日期）就算本次不再重试；
// 未认领（例如角色缺失）直接返回，不写任何东西。
export async function runAgentTask(task, { deps = null, now = new Date(), signal = null, notify = false } = {}) {
  const d = deps || await defaultDeps();
  const source = task && typeof task === 'object' ? task : {};
  const roleId = String(source.roleId || '');
  const taskId = String(source.taskId || '');
  if (!roleId || !taskId) return { ok: false, reason: 'invalid', text: '', sessionId: '' };

  const character = await d.loadCharacter(roleId);
  // 角色已删：认领当日，避免前台调度器每轮反复尝试这条幽灵任务。
  if (!character) {
    await d.markAgentTaskRun(taskId, now).catch(() => {});
    return { ok: false, reason: 'character-missing', text: '', sessionId: '' };
  }

  // 先认领「今天」，再做耗时的网络/工具循环（跨运行时去重的关键）。
  await d.markAgentTaskRun(taskId, now).catch(() => {});

  const validTargetId = await resolveValidTarget(source, d);
  const scopedTask = { ...source, character, sessionTargetId: validTargetId };
  const { historyMessages, summaryText } = await loadSessionContext(scopedTask, d);

  let globalPresets = [];
  let userProfile = null;
  try { globalPresets = await d.getEnabledGlobalPresetPrompts(); } catch (error) { globalPresets = []; }
  try { userProfile = await d.getUserProfile(); } catch (error) { userProfile = null; }

  let scheduleText = '';
  try {
    const schedule = await d.getCharacterSchedule(roleId);
    if (d.isScheduleActive(schedule)) scheduleText = d.buildSchedulePrompt(schedule);
  } catch (error) {
    scheduleText = '';
  }

  let tools = [];
  try { tools = await d.buildTools(); } catch (error) { tools = []; }

  const messages = buildAgentTaskMessages({
    character,
    historyMessages,
    userProfile,
    globalPresets,
    summaryText,
    instruction: source.instruction,
    tools,
    timeAware: true,
    scheduleText,
    now,
  });

  let text = '';
  try {
    text = await d.runAgentTurn(messages, {
      mode: 'read',
      tools,
      maxRounds: typeof d.roundBudget === 'function' ? d.roundBudget('read') : 10,
      signal,
      // 不接 onToolApproval：无人值守下需确认的工具一律被 registry 拒绝。
      context: { characterId: roleId, sessionId: validTargetId },
      allowChatTools: true,
    });
  } catch (error) {
    return { ok: false, reason: 'generation-failed', text: '', sessionId: '' };
  }

  const finalText = String(text || '').trim();
  if (!finalText) return { ok: false, reason: 'empty', text: '', sessionId: '' };

  let sessionId = '';
  try {
    const result = await d.appendProactiveMessage(roleId, {
      id: `${taskId}-${localDateKey(now)}`,
      text: finalText,
      createdAt: now.getTime(),
      sessionTargetId: validTargetId,
    });
    if (result && result.sessionId) {
      sessionId = result.sessionId;
      if (result.created) {
        await d.bindAgentTaskSession(taskId, result.sessionId).catch(() => {});
      }
    }
  } catch (error) {
    // 落库失败：任务当日已认领，不再重试；返回失败原因但不抛。
    return { ok: false, reason: 'persist-failed', text: finalText, sessionId: '' };
  }

  if (notify && typeof d.notifyAgentTaskResult === 'function') {
    await d.notifyAgentTaskResult(taskId, finalText).catch(() => {});
  }

  return { ok: true, reason: '', text: finalText, sessionId };
}
