// 自动备份的前台调度（桌面）：复用共享层的调度语义，只替换「前后台」信号源。
//
// 手机侧 backup/autoBackupScheduler.js 用 AppState 的 active/background 两个事件：
//   · active    → 延迟 30s 查一次到期，并起 interval 轮询；
//   · background→ 停表，并在「退出时备份」开着时跑一次（尽力而为）。
// 桌面的等价信号是 document 的 visibilitychange（窗口最小化/被遮挡 → hidden）：
// 语义一致，且**不需要**引入 AppState 垫片（那会把一个并不存在的概念假装出来）。
//
// 判定与执行全部走共享层：
//   · isAutoBackupDue / pickStale 在 backup/autoBackupPolicy.js（纯函数）；
//   · runAutoBackupIfDue / runAutoBackupOnExit 在 backup/autoBackupRun.js。
// 本文件只做「什么时候叫它们」——与手机同一个分工。
//
// 诚实边界（与手机一致，界面已写明）：窗口关闭后进程就没了，无法到点备份。
// 这里只承诺「应用开着的时候按间隔备份」+「窗口隐藏时跑一次退出备份」。

import { useEffect, useRef } from 'react';

import { runAutoBackupIfDue, runAutoBackupOnExit } from '../../../src/backup/autoBackupRun.js';
// 从零依赖叶子取常量：autoBackupScheduler.js 本身 import 了 react-native 的
// AppState，桌面侧只读两个数字不该被拖进整个 RN 运行时（Node 测试直接语法报错）。
import {
  DEFAULT_AUTO_BACKUP_POLL_MS,
  DEFAULT_AUTO_BACKUP_START_DELAY_MS,
} from '../../../src/backup/autoBackupPolicy.js';

/**
 * 启动前台调度。返回停止函数。
 *
 * deps 必须由调用方装配（createAutoBackupDeps）——与 AutoBackupCard 的「立即备份」
 * 用同一份，避免两处各自拼依赖、将来漂移。
 */
export function startDesktopAutoBackupScheduler({
  deps,
  intervalMs = DEFAULT_AUTO_BACKUP_POLL_MS,
  startDelayMs = DEFAULT_AUTO_BACKUP_START_DELAY_MS,
  onResult = null,
  doc = typeof document !== 'undefined' ? document : null,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
} = {}) {
  if (!deps) throw new Error('startDesktopAutoBackupScheduler: deps is required');

  let busy = false;
  let timer = null;
  let startTimer = null;

  const guarded = task => async () => {
    // 定时器与 visibility 事件可能几乎同时触发：同一次备份不重入。
    if (busy) return;
    busy = true;
    try {
      const result = await task();
      if (result && result.ok && typeof onResult === 'function') {
        try {
          onResult(result);
        } catch (error) {}
      }
    } catch (error) {
      // 备份失败不得影响应用；下一轮再试。
    } finally {
      busy = false;
    }
  };

  const runDue = guarded(() => runAutoBackupIfDue({ deps }));
  const runExit = guarded(() => runAutoBackupOnExit({ deps }));

  const startTimer_ = () => {
    if (!timer) timer = timers.setInterval(runDue, intervalMs);
  };
  const stopTimer = () => {
    if (timer) {
      timers.clearInterval(timer);
      timer = null;
    }
  };
  // 启动后**不立刻**备份（手机端真机教训：一打开就压一次重活，体感是发烫变卡），
  // 延迟 startDelayMs 再查到期。连续触发时先清掉上一个待触发定时器，不堆叠。
  const scheduleDue = () => {
    if (startTimer) timers.clearTimeout(startTimer);
    startTimer = timers.setTimeout(runDue, startDelayMs);
  };
  const clearScheduledDue = () => {
    if (startTimer) {
      timers.clearTimeout(startTimer);
      startTimer = null;
    }
  };

  scheduleDue();
  startTimer_();

  const onVisibility = () => {
    const hidden = doc && doc.visibilityState === 'hidden';
    if (!hidden) {
      // 回到前台：重新查到期 + 恢复轮询。
      scheduleDue();
      startTimer_();
      return;
    }
    stopTimer();
    clearScheduledDue();
    // 只在真正隐藏时跑退出备份。与手机一致：不做「瞬时失焦也算退出」，
    // 否则切个窗口就压一次全量备份。
    runExit();
  };

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibility);
  }

  return function stop() {
    stopTimer();
    clearScheduledDue();
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

/** 在应用根挂载调度器。enabled=false 时不启表（用户关掉总开关即不轮询）。 */
export default function useDesktopAutoBackupScheduler({ enabled, deps, onResult = null }) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof depsRef.current !== 'function') return undefined;
    const stop = startDesktopAutoBackupScheduler({
      deps: depsRef.current(),
      onResult: result => {
        if (typeof onResultRef.current === 'function') onResultRef.current(result);
      },
    });
    return stop;
  }, [enabled]);
}