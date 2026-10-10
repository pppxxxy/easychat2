// 定时 Agent 任务存储域。
//
// 两个键：
// - @easychat2_agent_tasks     任务配置：{ tasks: [...] }（与主动消息的 slots 同构，便于面板复用）；
// - @easychat2_agent_task_runs 运行记录：{ [taskId]: 'YYYY-MM-DD' }，用于「每槽每日一次」去重。
//
// 运行记录是「已跑过今天」的事实源：前台调度器与无界面（headless）执行器共用它，
// 保证同一任务同日不重复生成。角色删除时清理该角色的任务与对应运行记录。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { localDateKey, normalizeAgentTaskList } from '../agent/task/taskModel.js';
import { onCharacterDeleted } from './characterLifecycle.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

export const AGENT_TASKS_KEY = '@easychat2_agent_tasks';
export const AGENT_TASK_RUNS_KEY = '@easychat2_agent_task_runs';

const agentTasksMutation = createMutationQueue();

function normalizeSettings(raw) {
  if (raw === null || raw === undefined) return { tasks: [] };
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { tasks: normalizeAgentTaskList(source.tasks) };
}

export async function getAgentTasks() {
  const stored = await readJsonStatus(AGENT_TASKS_KEY);
  if (stored.status === 'corrupt') {
    // 与其它集合一致：损坏先备份，不静默覆盖用户的任务配置。
    await backupCorruptValue(AGENT_TASKS_KEY);
    return [];
  }
  return normalizeSettings(stored.status === 'ok' ? stored.value : null).tasks;
}

export async function saveAgentTasks(tasks) {
  return agentTasksMutation.enqueue(async () => {
    const normalized = normalizeAgentTaskList(tasks);
    await AsyncStorage.setItem(AGENT_TASKS_KEY, JSON.stringify({ tasks: normalized }));
    return normalized;
  });
}

// 落库时把「新建对话」的任务绑定到实际写入的会话 id：重读当前配置后仅改该任务，
// 避免用旧的整表覆盖用户在面板上的其它编辑。返回是否命中。
export function bindAgentTaskSession(taskId, sessionId) {
  const target = String(taskId || '');
  const bound = String(sessionId || '');
  if (!target || !bound) return Promise.resolve(false);
  return agentTasksMutation.enqueue(async () => {
    const tasks = await getAgentTasks();
    let hit = false;
    const next = tasks.map(task => {
      if (task.taskId !== target || task.sessionTargetId === bound) return task;
      hit = true;
      return { ...task, sessionTargetId: bound };
    });
    if (!hit) return false;
    await AsyncStorage.setItem(AGENT_TASKS_KEY, JSON.stringify({ tasks: next }));
    return true;
  });
}

// ---- 运行记录 ----

async function readRunDates() {
  const stored = await readJsonStatus(AGENT_TASK_RUNS_KEY);
  if (stored.status !== 'ok') return {};
  const source = stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value)
    ? stored.value
    : {};
  const result = {};
  Object.keys(source).forEach(key => {
    const value = String(source[key] || '');
    if (key && value) result[key] = value;
  });
  return result;
}

export async function getAgentTaskRunDates() {
  return readRunDates();
}

// 标记某任务「今天已跑」。date 可注入以便测试。
export function markAgentTaskRun(taskId, date = new Date()) {
  const id = String(taskId || '');
  const day = localDateKey(date);
  if (!id || !day) return Promise.resolve(false);
  return agentTasksMutation.enqueue(async () => {
    const runs = await readRunDates();
    await AsyncStorage.setItem(
      AGENT_TASK_RUNS_KEY,
      JSON.stringify({ ...runs, [id]: day })
    );
    return true;
  });
}

export function clearAgentTaskRun(taskId) {
  const id = String(taskId || '');
  if (!id) return Promise.resolve(false);
  return agentTasksMutation.enqueue(async () => {
    const runs = await readRunDates();
    if (!(id in runs)) return false;
    const next = { ...runs };
    delete next[id];
    await AsyncStorage.setItem(AGENT_TASK_RUNS_KEY, JSON.stringify(next));
    return true;
  });
}

async function deleteAgentTasksForCharacters(characterIds) {
  const ids = (Array.isArray(characterIds) ? characterIds : []).map(id => String(id || '')).filter(Boolean);
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const tasks = await getAgentTasks();
  const kept = tasks.filter(task => !idSet.has(String(task.roleId || '')));
  const removedIds = tasks
    .filter(task => idSet.has(String(task.roleId || '')))
    .map(task => String(task.taskId || ''));
  if (tasks.length !== kept.length) {
    await AsyncStorage.setItem(AGENT_TASKS_KEY, JSON.stringify({ tasks: kept }));
  }
  if (removedIds.length > 0) {
    const runs = await readRunDates();
    let changed = false;
    removedIds.forEach(id => {
      if (id in runs) {
        delete runs[id];
        changed = true;
      }
    });
    if (changed) {
      await AsyncStorage.setItem(AGENT_TASK_RUNS_KEY, JSON.stringify(runs));
    }
  }
}

// 角色删除时清理其定时 Agent 任务（谁的数据谁负责）。
onCharacterDeleted('agentTasks', deleteAgentTasksForCharacters);
