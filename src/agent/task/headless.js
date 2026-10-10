// 无界面（Headless JS）入口：App 被杀时由原生前台服务唤起的执行器。
//
// 原生 AgentTaskForegroundService 以 taskKey='AgentTaskHeadless' 启动本任务，
// data = { slotId, revision }。这里按 slotId 找到任务配置、做陈旧/重复守卫，
// 再交给 taskRunner 执行（notify=true 让完成后弹通知）。
//
// 注册发生在模块加载时（import 即注册）：只要 bundle 被求值（headless 服务会加载
// 整个 bundle），任务就已就绪。App.js 顶层 import 本模块即完成注册。

import { AppRegistry } from 'react-native';

import { localDateKey } from './taskModel.js';

export const AGENT_TASK_HEADLESS_KEY = 'AgentTaskHeadless';

async function runHeadlessTask(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const slotId = String(payload.slotId || '');
  if (!slotId) return;
  const revision = String(payload.revision || '');
  const now = new Date();
  try {
    const [
      { getAgentTasks, getAgentTaskRunDates },
      { runAgentTask },
    ] = await Promise.all([
      import('../../storage/agentTasks.js'),
      import('./taskRunner.js'),
    ]);
    const tasks = await getAgentTasks().catch(() => []);
    const task = (Array.isArray(tasks) ? tasks : []).find(item => item && String(item.taskId || '') === slotId);
    if (!task || task.enabled !== true) return;
    // revision 不匹配 = 旧配置触发的陈旧闹钟，放弃。
    if (revision && String(task.revision || '') && String(task.revision || '') !== revision) return;
    // 今天已经跑过（前台调度器或上一轮 headless）：跳过，避免重复生成。
    const runs = await getAgentTaskRunDates().catch(() => ({}));
    if (String(runs[slotId] || '') === localDateKey(now)) return;
    await runAgentTask(task, { now, notify: true });
  } catch (error) {
    // 无界面路径不得抛出：抛出会被 AppRegistry 记为未处理失败。
  }
}

let registered = false;

export function registerAgentTaskHeadless() {
  if (registered) return;
  registered = true;
  AppRegistry.registerHeadlessTask(AGENT_TASK_HEADLESS_KEY, () => runHeadlessTask);
}

// import 即注册（bundle 求值时执行）。App.js 顶层 import 本模块即可。
registerAgentTaskHeadless();
