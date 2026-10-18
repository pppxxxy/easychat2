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
import { runDueAgentTasks } from './taskDispatch.js';

export { runDueAgentTasks };

// 取证埋点（perfProbe）：60s 调度器每轮的耗时。默认为关闭时是一次布尔判断，
// 不改变任何行为；开启后超过 800ms（PERF_THRESHOLDS.startup）才留一条诊断。
// 单独打点是因为本轮排查里「停在设置页也烫」需要一个后台活动的读数来排除/定位：
// 若这一轮本身很慢，它每 60s 会把主线程拖住一次，形态与用户描述吻合。
const TICK_LABEL = 'app.tick';

// 启动 App 内调度器：立即跑一轮，之后在 App 处于前台时按 intervalMs 轮询；
// 退到后台就停表（后台交给原生 headless）。返回停止函数。
export function startAgentTaskScheduler({ onResults = null, intervalMs = 60000 } = {}) {
  let running = false;
  let timer = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const produced = await measureAsync(
        TICK_LABEL,
        () => runDueAgentTasks({ notify: true }),
        PERF_THRESHOLDS.startup
      );
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
