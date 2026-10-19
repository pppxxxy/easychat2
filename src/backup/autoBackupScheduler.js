// 自动备份的 App 内调度壳（只管 AppState 与定时器；真实逻辑在 autoBackupRun.js）。
//
// 触发时机：
// - App 启动 / 回到前台：检查是否到期（now - lastBackupAt >= intervalMs），到期跑一次；
// - 切到后台（Android「离开 App」≈ 这里）：若开启了「退出时备份」，跑一次。
//   **尽力而为**：系统可能立刻冻结/杀掉进程，备份未必能完成——这是移动端没有常驻后台的
//   固有限制，界面上如实说明，不承诺一定成功。
//
// interval 轮询只是兜底：间隔通常是小时/天级，App 长期驻留前台时也能按间隔触发。
// 与 agentTaskScheduler 同一套路（前台轮询 + AppState 停表）。

import { AppState } from 'react-native';

import { runAutoBackupIfDue, runAutoBackupOnExit } from './autoBackupRun.js';

export const DEFAULT_AUTO_BACKUP_POLL_MS = 15 * 60 * 1000;

// 启动/回到前台后延迟多久才检查到期。
//
// 为什么必须有这个延迟（真机反馈 2026-10-19）：此前是**挂载即 runDue()**，而一次自动
// 备份要生成完整备份包（角色卡多的用户可达 115MB），从 App 一打开就抢 CPU/IO，
// 用户体感是「一打开就发烫、变卡」。备份并不紧急——晚 30 秒做，启动体验好得多。
// 回到前台（active）同样走这个延迟：每次切回来都不该立刻压一次重活。
export const DEFAULT_AUTO_BACKUP_START_DELAY_MS = 30 * 1000;

export function startAutoBackupScheduler({
  onResult = null,
  intervalMs = DEFAULT_AUTO_BACKUP_POLL_MS,
  startDelayMs = DEFAULT_AUTO_BACKUP_START_DELAY_MS,
  deps = null,
} = {}) {
  let busy = false;
  let timer = null;
  let startTimer_ = null;

  const report = result => {
    if (result && result.ok && typeof onResult === 'function') {
      try { onResult(result); } catch (error) {}
    }
  };

  // 同一次备份不重入：定时器与 AppState 事件可能几乎同时触发。
  const guard = task => async () => {
    if (busy) return;
    busy = true;
    try {
      report(await task());
    } catch (error) {
      // 备份失败不得影响 App；下一轮再试。
    } finally {
      busy = false;
    }
  };

  const runDue = guard(() => runAutoBackupIfDue({ deps }));
  const runExit = guard(() => runAutoBackupOnExit({ deps }));

  const startTimer = () => {
    if (!timer) timer = setInterval(runDue, intervalMs);
  };
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  // 延迟触发一次到期检查（见 DEFAULT_AUTO_BACKUP_START_DELAY_MS 的注释）。
  // 重入安全：连续 active 事件会先清掉上一个待触发的定时器，不会堆叠。
  const scheduleDue = () => {
    if (startTimer_) clearTimeout(startTimer_);
    startTimer_ = setTimeout(runDue, startDelayMs);
  };
  const clearScheduledDue = () => {
    if (startTimer_) {
      clearTimeout(startTimer_);
      startTimer_ = null;
    }
  };

  // 启动：**不立刻**跑备份（那是「一打开就发烫」的直接来源），先起轮询，延迟后再查到期。
  scheduleDue();
  startTimer();
  const subscription = AppState.addEventListener('change', next => {
    if (next === 'active') {
      scheduleDue();
      startTimer();
      return;
    }
    stopTimer();
    clearScheduledDue();
    // 只在真正进入后台时触发退出备份：iOS 的 inactive 是瞬时态（下拉控制中心也会到），
    // 拿它当「退出」会频繁触发备份。
    if (next === 'background') runExit();
  });

  return () => {
    stopTimer();
    clearScheduledDue();
    subscription.remove();
  };
}
