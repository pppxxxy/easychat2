// 定时 Agent 任务的单元测试（纯逻辑 + 运行器 + 分发，全部注入依赖，不碰 RN）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAgentTaskTime,
  localDateKey,
  normalizeAgentTask,
  normalizeAgentTaskList,
  parseAgentTaskTimeInput,
  rolePersonaFromCharacter,
} from '../src/agent/task/taskModel.js';
import { collectDueTasks, isTaskDue, nextRunAt, todayTarget } from '../src/agent/task/taskSchedule.js';
import { buildAgentTaskExtraPrompt, describeAgentTaskTools } from '../src/agent/task/taskPrompt.js';
import { runDueAgentTasks } from '../src/agent/task/taskDispatch.js';
import { buildAgentTaskMessages, runAgentTask } from '../src/agent/task/taskRunner.js';

// ---- taskModel ----

test('normalizeAgentTask 夹取时间并补默认值', () => {
  const task = normalizeAgentTask({ roleId: 'r1', hour: 99, minute: -3, mode: 'BOGUS' });
  assert.equal(task.hour, 8);
  assert.equal(task.minute, 0);
  assert.equal(task.mode, 'WORK');
  assert.equal(task.enabled, true);
  assert.ok(task.taskId);
});

test('normalizeAgentTask 保留合法时间与字段', () => {
  const task = normalizeAgentTask({
    taskId: 't1', roleId: 'r1', hour: 21, minute: 5, mode: 'EXACT',
    enabled: false, instruction: '查天气', sessionTargetId: 's1',
  });
  assert.deepEqual(
    { id: task.taskId, h: task.hour, m: task.minute, mode: task.mode, enabled: task.enabled, ins: task.instruction, st: task.sessionTargetId },
    { id: 't1', h: 21, m: 5, mode: 'EXACT', enabled: false, ins: '查天气', st: 's1' }
  );
});

test('normalizeAgentTaskList 过滤无角色的条目', () => {
  const list = normalizeAgentTaskList([{ roleId: '' }, { roleId: 'r1' }, null]);
  assert.equal(list.length, 1);
  assert.equal(list[0].roleId, 'r1');
});

test('formatAgentTaskTime 补零', () => {
  assert.equal(formatAgentTaskTime({ hour: 8, minute: 0 }), '08:00');
  assert.equal(formatAgentTaskTime({ hour: 21, minute: 5 }), '21:05');
});

test('rolePersonaFromCharacter 拼接四字段', () => {
  const persona = rolePersonaFromCharacter({ systemPrompt: 'A', description: 'B', personality: 'C', scenario: 'D' });
  assert.equal(persona, 'A；B；C；D');
});

test('localDateKey 生成 YYYY-MM-DD', () => {
  assert.equal(localDateKey(new Date(2026, 0, 3, 23, 59)), '2026-01-03');
});

test('parseAgentTaskTimeInput 解析/夹取/回退', () => {
  assert.deepEqual(parseAgentTaskTimeInput('21:05'), { hour: 21, minute: 5 });
  assert.deepEqual(parseAgentTaskTimeInput('9：7'), { hour: 9, minute: 7 });
  assert.deepEqual(parseAgentTaskTimeInput('99:99'), { hour: 23, minute: 59 });
  // 不完整输入回退到提供的默认值（面板传当前值），避免打回 08:00。
  assert.deepEqual(parseAgentTaskTimeInput('2', '13:30'), { hour: 13, minute: 30 });
  assert.deepEqual(parseAgentTaskTimeInput('', '07:15'), { hour: 7, minute: 15 });
});

// ---- taskSchedule ----

test('isTaskDue：未到点 / 已跑过 / 未启用 均不为到期', () => {
  const at8 = { hour: 8, minute: 0, enabled: true, taskId: 't1' };
  const now = new Date(2026, 0, 3, 9, 0);
  assert.equal(isTaskDue(at8, { now, lastRunDate: '' }), true);
  assert.equal(isTaskDue(at8, { now, lastRunDate: '2026-01-03' }), false);
  assert.equal(isTaskDue({ ...at8, enabled: false }, { now, lastRunDate: '' }), false);
  assert.equal(isTaskDue(at8, { now: new Date(2026, 0, 3, 7, 59), lastRunDate: '' }), false);
});

test('collectDueTasks 只挑今天未跑且已到点的', () => {
  const now = new Date(2026, 0, 3, 10, 0);
  const tasks = [
    { taskId: 'a', hour: 8, minute: 0, enabled: true },
    { taskId: 'b', hour: 8, minute: 0, enabled: true },
    { taskId: 'c', hour: 23, minute: 0, enabled: true },
  ];
  const due = collectDueTasks(tasks, { now, runDates: { b: '2026-01-03' } });
  assert.deepEqual(due.map(t => t.taskId), ['a']);
});

test('nextRunAt：今天已过则顺延到明天', () => {
  const task = { hour: 8, minute: 0 };
  const before = nextRunAt(task, new Date(2026, 0, 3, 7, 0));
  assert.equal(localDateKey(new Date(before)), '2026-01-03');
  const after = nextRunAt(task, new Date(2026, 0, 3, 9, 0));
  assert.equal(localDateKey(new Date(after)), '2026-01-04');
  assert.equal(todayTarget(task, new Date(2026, 5, 1)), new Date(2026, 5, 1, 8, 0).getTime());
});

// ---- taskPrompt ----

test('buildAgentTaskExtraPrompt 含任务与产出约束', () => {
  const text = buildAgentTaskExtraPrompt({ instruction: '查天气', toolHint: 'web_search' });
  assert.match(text, /查天气/);
  assert.match(text, /web_search/);
  assert.match(text, /只输出要发给用户/);
});

test('buildAgentTaskExtraPrompt 无指令时给兜底任务', () => {
  assert.match(buildAgentTaskExtraPrompt({}), /主动给用户发一条/);
});

test('describeAgentTaskTools 解析 name/description', () => {
  const text = describeAgentTaskTools([
    { type: 'function', function: { name: 'web_search', description: '搜索' } },
    { name: 'read_file' },
  ]);
  assert.match(text, /web_search（搜索）/);
  assert.match(text, /read_file/);
});

// ---- buildAgentTaskMessages ----

test('buildAgentTaskMessages 产出 system + 历史 + 任务，且裁剪占位消息', () => {
  const messages = buildAgentTaskMessages({
    character: { name: '小明', systemPrompt: '你是小明' },
    historyMessages: [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '在呢', pending: true },
    ],
    instruction: '早安问候',
    now: new Date(2026, 0, 3, 8, 0),
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /早安问候/);
  // pending 的助手消息被剔除，只留一条用户历史 + 一条任务 user 文本
  const roles = messages.map(m => m.role);
  assert.equal(roles.filter(r => r === 'assistant').length, 0);
  assert.ok(messages.length >= 2);
});

// ---- taskDispatch ----

function makeDispatchDeps({ tasks, runs }) {
  const ran = [];
  return {
    ran,
    deps: {
      getAgentTasks: async () => tasks,
      getAgentTaskRunDates: async () => runs,
      runAgentTask: async task => { ran.push(task.taskId); return { ok: true }; },
    },
  };
}

test('runDueAgentTasks 串行只跑到期任务', async () => {
  const now = new Date(2026, 0, 3, 10, 0);
  const { deps, ran } = makeDispatchDeps({
    tasks: [
      { taskId: 'a', hour: 8, minute: 0, enabled: true },
      { taskId: 'b', hour: 23, minute: 0, enabled: true },
    ],
    runs: {},
  });
  const produced = await runDueAgentTasks({ deps, now });
  assert.equal(produced, 1);
  assert.deepEqual(ran, ['a']);
});

test('runDueAgentTasks 读取失败返回 0 不抛', async () => {
  const deps = { getAgentTasks: async () => { throw new Error('boom'); } };
  assert.equal(await runDueAgentTasks({ deps }), 0);
});

// ---- taskRunner ----

function makeRunnerDeps(overrides = {}) {
  const calls = { mark: [], appended: [], bound: [], notified: [], ran: [] };
  const deps = {
    loadCharacter: async roleId => (roleId === 'r1' ? { id: 'r1', name: '小明', systemPrompt: '你是小明' } : null),
    markAgentTaskRun: async (id) => { calls.mark.push(id); return true; },
    getSessions: async () => [{ id: 's1', characterId: 'r1', type: 'single' }],
    getMessagesBySession: async () => [{ role: 'user', text: '历史' }],
    getSessionSummaries: async () => [],
    getEnabledGlobalPresetPrompts: async () => [],
    getUserProfile: async () => null,
    getCharacterSchedule: async () => null,
    isScheduleActive: () => false,
    buildSchedulePrompt: () => '',
    isBuiltinAssistant: () => false,
    isSessionScopedMemory: () => false,
    buildMemorySummaryText: () => '',
    buildTools: async () => [{ type: 'function', function: { name: 'web_search', description: '' } }],
    runAgentTurn: async () => { calls.ran.push(true); return '今天晴，注意防晒。'; },
    roundBudget: () => 10,
    appendProactiveMessage: async (roleId, incoming) => { calls.appended.push({ roleId, incoming }); return { sessionId: 's1', created: false }; },
    bindAgentTaskSession: async (taskId, sessionId) => { calls.bound.push({ taskId, sessionId }); return true; },
    notifyAgentTaskResult: async (taskId, text) => { calls.notified.push({ taskId, text }); return true; },
    ...overrides,
  };
  return { deps, calls };
}

test('runAgentTask 成功：认领当日 → 跑循环 → 落库（幂等 id）', async () => {
  const { deps, calls } = makeRunnerDeps();
  const now = new Date(2026, 0, 3, 8, 0);
  const result = await runAgentTask({ taskId: 't1', roleId: 'r1', sessionTargetId: 's1' }, { deps, now, notify: true });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 's1');
  assert.deepEqual(calls.mark, ['t1']);
  assert.equal(calls.appended.length, 1);
  assert.equal(calls.appended[0].incoming.id, 't1-2026-01-03');
  assert.equal(calls.appended[0].incoming.text, '今天晴，注意防晒。');
  assert.equal(calls.notified.length, 1);
});

test('runAgentTask 角色缺失：认领当日但不跑不落库', async () => {
  const { deps, calls } = makeRunnerDeps({ loadCharacter: async () => null });
  const result = await runAgentTask({ taskId: 't9', roleId: 'gone' }, { deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'character-missing');
  assert.deepEqual(calls.mark, ['t9']);
  assert.equal(calls.appended.length, 0);
  assert.equal(calls.ran.length, 0);
});

test('runAgentTask 空回复：不落库', async () => {
  const { deps, calls } = makeRunnerDeps({ runAgentTurn: async () => '   ' });
  const result = await runAgentTask({ taskId: 't1', roleId: 'r1' }, { deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
  assert.equal(calls.appended.length, 0);
});

test('runAgentTask 生成抛错：返回失败不抛', async () => {
  const { deps } = makeRunnerDeps({ runAgentTurn: async () => { throw new Error('net'); } });
  const result = await runAgentTask({ taskId: 't1', roleId: 'r1' }, { deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generation-failed');
});

test('runAgentTask 无效入参直接返回', async () => {
  const { deps } = makeRunnerDeps();
  assert.equal((await runAgentTask({ roleId: '' }, { deps })).reason, 'invalid');
});

test('runAgentTask 指定会话不属于该角色时按新建处理', async () => {
  const { deps, calls } = makeRunnerDeps({
    getSessions: async () => [{ id: 'other', characterId: 'r2', type: 'single' }],
  });
  await runAgentTask({ taskId: 't1', roleId: 'r1', sessionTargetId: 'foreign' }, { deps });
  assert.equal(calls.appended[0].incoming.sessionTargetId, '');
});
