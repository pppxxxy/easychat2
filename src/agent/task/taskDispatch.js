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

// 只做「读存储 + 选出到期任务」——**调度埋点只量这一段**。
//
// 任务执行是长活（模型 + 工具，十几秒很常见）；把它算进 app.tick，会让每次任务
// 运行都报「调度器卡了 N 秒」（2026-10-21 真机日志：app.tick 18493ms > 800ms），
// 既误导排查、又淹没真正的卡顿。执行耗时改由调度器用单独 label 计量。
export async function collectDueAgentTasks({ deps = null, now = new Date() } = {}) {
  const d = deps || await defaultDeps();
  let tasks = [];
  let runs = {};
  try { tasks = await d.getAgentTasks(); } catch (error) { return { deps: d, due: [] }; }
  try { runs = await d.getAgentTaskRunDates(); } catch (error) { runs = {}; }
  return { deps: d, due: collectDueTasks(tasks, { now, runDates: runs }) };
}

// 串行执行到期任务，返回成功生成的消息条数。
// measureTask(task, run) 可选：调度器用它给每轮任务单独计时（不混进 app.tick）。
export async function executeDueAgentTasks(due, deps, { now = new Date(), notify = false, measureTask = null } = {}) {
  const list = Array.isArray(due) ? due : [];
  let produced = 0;
  for (const task of list) {
    const run = () => deps.runAgentTask(task, { now, notify });
    const result = typeof measureTask === 'function'
      ? await measureTask(task, run)
      : await run();
    if (result && result.ok) produced += 1;
  }
  return produced;
}

// 组合入口（后台无界面执行器等不需要拆分的调用方继续用它）。
export async function runDueAgentTasks({ deps = null, now = new Date(), notify = false } = {}) {
  const collected = await collectDueAgentTasks({ deps, now });
  return executeDueAgentTasks(collected.due, collected.deps, { now, notify });
}
