// 日记自动运行的触发逻辑（RN-free 纯模块，Node 可直测）。
//
// 背景（2026-10-07）：DiaryStartup 原本只在 App 冷启动时执行一次（startedRef），
// App 常驻后台/热启动/切回前台都不会触发——用户开了一天日记却始终没见生成。
// 现在冷启动与「回到前台」共用同一套判定，且判定与执行都可注入，便于单测：
// 冷启动一次性 + 回前台按跨天闸门补跑，两层幂等保护（running 互斥 + isNewDay
// 闸门）仍在 runDiaryForNewDay 内部，不在本模块里重复实现。

import { isNewDay } from './diary.js';

// 纯判定：当前是否已跨天、需要跑一次日记。
export function shouldRunDiaryForDay({ lastRunDate = '', now = Date.now() } = {}) {
  return isNewDay(lastRunDate, now);
}

// 读设置 → 跨天判定 → 执行。readSettings/run 必须注入（App 传真实实现，
// 测试传 fake）：本模块不 import 存储层，保证纯函数可测。
export async function runDiaryIfNewDay({ readSettings, run, now = Date.now() } = {}) {
  if (typeof readSettings !== 'function' || typeof run !== 'function') {
    return { ran: false, written: 0, reason: 'not-configured' };
  }
  const settings = await readSettings().catch(() => null);
  if (!shouldRunDiaryForDay({ lastRunDate: settings && settings.lastRunDate, now })) {
    return { ran: false, written: 0, reason: 'same-day' };
  }
  const written = await run({ now });
  return { ran: true, written: Number(written) || 0, reason: '' };
}
