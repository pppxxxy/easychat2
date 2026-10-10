// 定时 Agent 任务：到期判定与下次触发时间（纯函数，零 RN 依赖，Node 可直测）。
//
// 与原生 MessageClock 的差别：Agent 任务允许「同日补跑」——手机在触发时刻关机/无网时，
// 打开 App 后应把当天漏掉的任务补上（内容生成类任务晚几小时仍有意义）。
// 因此到期判定只看「今天是否已跑过（lastRunDate）」+「是否已到今天的触发时刻」，
// 不做 30 分钟迟到窗口限制。

import { localDateKey } from './taskModel.js';

function targetOn(task, baseDate) {
  const base = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const d = new Date(base.getTime());
  d.setHours(Number(task.hour) || 0, Number(task.minute) || 0, 0, 0);
  return d.getTime();
}

// 今天该任务的触发时刻（毫秒）。
export function todayTarget(task, now = new Date()) {
  return targetOn(task, now);
}

// 下次触发时刻：今天的时刻已过则顺延到明天。
export function nextRunAt(task, now = new Date()) {
  const base = now instanceof Date ? now : new Date(now);
  const today = targetOn(task, base);
  if (today > base.getTime()) return today;
  const tomorrow = new Date(base.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  return targetOn(task, tomorrow);
}

// 单条任务此刻是否应当执行：
//   - 启用；
//   - 已到今天的触发时刻；
//   - 今天尚未执行过（lastRunDate 不是今天）。
export function isTaskDue(task, { now = new Date(), lastRunDate = '' } = {}) {
  if (!task || task.enabled !== true) return false;
  const base = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(base.getTime())) return false;
  if (targetOn(task, base) > base.getTime()) return false;
  return String(lastRunDate || '') !== localDateKey(base);
}

// 从任务列表里筛出到期的（保持原顺序）。runDates 是 taskId → 本地日期键的映射。
export function collectDueTasks(tasks, { now = new Date(), runDates = {} } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const dates = runDates && typeof runDates === 'object' ? runDates : {};
  return list.filter(task => task && isTaskDue(task, {
    now,
    lastRunDate: dates[String(task.taskId || '')] || '',
  }));
}
