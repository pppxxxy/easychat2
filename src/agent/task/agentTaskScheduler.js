// 定时 Agent 任务的 App 内调度器。
//
// 负责「App 打开时」的执行入口，并补跑当天漏掉的任务（手机在触发时刻关机/无网时，
// 打开 App 就把当天该跑的任务补上——内容生成类任务晚几小时仍有意义）。
//
// 与原生无界面（headless）执行器共用 taskRunner：两者都先 markAgentTaskRun 认领「今日」，
// 因此即便两条路径同时命中同一任务，也只会生成一条（消息 id 亦按 taskId+日期幂等）。
//
// 分发逻辑在纯模块 taskDispatch（Node 可直测）；本文件只负责 AppState 与定时器。

import { AppState } from 'react-native';

import { measureAsync, PERF_THRESHOLDS } from '../../logging/perfProbe.js';
import { collectDueAgentTasks, executeDueAgentTasks, runDueAgentTasks } from './taskDispatch.js';

export { runDueAgentTasks };

// 取证埋点（perfProbe）：60s 调度器每轮的耗时。默认为关闭时是一次布尔判断，
// 不改变任何行为；开启后超过 800ms（PERF_THRESHOLDS.startup）才留一条诊断。
// 单独打点是因为本轮排查里「停在设置页也烫」需要一个后台活动的读数来排除/定位：
// 若这一轮本身很慢，它每 60s 会把主线程拖住一次，形态与用户描述吻合。
//
// 2026-10-21 真机日志修正：app.tick 曾报 18493ms——那不是调度卡住，而是**任务真的
// 在执行**（模型 + 工具循环十几秒很正常）。现在只量「选任务」（读存储 + 纯筛选），
// 执行用独立 label + 宽松阈值（只有异常卡死才留诊断），不再污染 app.tick。
const TICK_LABEL = 'app.tick';
const TASK_RUN_LABEL = 'agent.task.run';
const TASK_RUN_SLOW_MS = 120000;

// 启动 App 内调度器：立即跑一轮，之后在 App 处于前台时按 intervalMs 轮询；
// 退到后台就停表（后台交给原生 headless）。返回停止函数。
export function startAgentTaskScheduler({ onResults = null, intervalMs = 60000 } = {}) {
  let running = false;
  let timer = null;
  const tick = async () => {
    if (running) return;
    running = true;
    const now = new Date();
    try {
      // 只量调度本身：读任务表 + 纯筛选（真实开销毫秒级）。
      const collected = await measureAsync(
        TICK_LABEL,
        () => collectDueAgentTasks({ now }),
        PERF_THRESHOLDS.startup
      );
      const produced = await executeDueAgentTasks(collected.due, collected.deps, {
        now,
        notify: true,
        // 执行是长活：单独计时 + 宽松阈值（>=2 分钟才算异常，避免正常任务刷屏）。
        measureTask: (task, run) => measureAsync(TASK_RUN_LABEL, run, TASK_RUN_SLOW_MS),
      });
      if (produced > 0 && typeof onResults === 'function') onResults(produced);
    } catch (error) {
      // 调度失败不得影响 App；下一轮再试。
    } finally {
      running = false;
    }
  };
  const startTimer = () => {
    if (!timer) timer = setInterval(tick, intervalMs);
  };
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  tick();
  startTimer();
  const subscription = AppState.addEventListener('change', next => {
    if (next === 'active') {
      tick();
      startTimer();
    } else {
      stopTimer();
    }
  });

  return () => {
    stopTimer();
    subscription.remove();
  };
}
