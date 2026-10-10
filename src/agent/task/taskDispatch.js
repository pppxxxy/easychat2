// 定时 Agent 任务的分发逻辑（纯 JS，零 RN 依赖，Node 可直测）。
//
// 与 agentTaskScheduler 的分工：本模块只做「选出到期任务并串行执行」，
// 不碰 AppState/定时器；调度壳（前台轮询、后台 headless）各自包一层调用它。
// 依赖可注入：单测传假的 getAgentTasks/getAgentTaskRunDates/runAgentTask。

import { collectDueTasks } from './taskSchedule.js';

async function defaultDeps() {
  const [{ getAgentTasks, getAgentTaskRunDates }, { runAgentTask }] = await Promise.all([
    import('../../storage/agentTasks.js'),
    import('./taskRunner.js'),
  ]);
  return { getAgentTasks, getAgentTaskRunDates, runAgentTask };
}

// 跑一轮到期任务（串行）。返回成功生成的消息条数。
export async function runDueAgentTasks({ deps = null, now = new Date(), notify = false } = {}) {
  const d = deps || await defaultDeps();
  let tasks = [];
  let runs = {};
  try { tasks = await d.getAgentTasks(); } catch (error) { return 0; }
  try { runs = await d.getAgentTaskRunDates(); } catch (error) { runs = {}; }
  const due = collectDueTasks(tasks, { now, runDates: runs });
  let produced = 0;
  for (const task of due) {
    const result = await d.runAgentTask(task, { now, notify });
    if (result && result.ok) produced += 1;
  }
  return produced;
}
