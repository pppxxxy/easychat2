// 看屏幕的**失败上报**收口（FIX-SW5 P1-4 / P1-5）。
//
// 为什么单独成模块：ScreenWatchScreen.js 已经贴着 800 行棘轮
//（tests/architecturePolicy.test.mjs），FIX-SW5 又要往里加「崩溃现场上报」与
// 「两段分开报错」两件事。按本仓纪律是**拆文件**而不是抬上限。
// 这两件事本来也不属于「渲染这一屏」：它们是把失败变成「诊断日志 + 用户弹窗」，
// 与界面无关，放在这里还顺带让它们能被独立测试。
//
// 诊断消息用 ASCII（给开发者看），面向用户的标题/正文一律由调用方从 i18n 传入
// ——本仓库的零硬编码中文门禁（tests/i18nWorldBatch.test.mjs）就是这么要求的。

import { Alert } from 'react-native';
// FS 读取仍封装在 capture.js（screen-watch 域唯一的 FS 封装点）——这里只调它的入口。
import { takeCrashReports } from './capture.js';
import { maskSecrets } from '../storage/secrets.js';
import { recordDiagnostic } from '../storage/diagnostics.js';

/**
 * FIX-SW5 P1-4：把上一次进程死亡的第一现场送进诊断日志。
 *
 * 原生 installCrashGuard 在进程死前把堆栈写进 `screen-watch/crash-*.txt`；
 * 这里读出来上报，[takeCrashReports] 读完即删 → **只报一次**。
 *
 * @param {(message: string, detail: string) => void} [record] 便于测试注入；
 *   缺省写进诊断日志。
 * @returns {Promise<number>} 本次上报的条数（0 = 没有崩溃现场）。
 */
export async function reportOverlayCrashReports(record = defaultRecordCrash) {
  let reports = [];
  try {
    reports = await takeCrashReports();
  } catch (error) {
    return 0;   // 取证读取失败不该影响使用：静默
  }
  if (!Array.isArray(reports) || reports.length === 0) return 0;
  reports.forEach(report => {
    const detail = maskSecrets(String((report && report.text) || '')).slice(0, 2000);
    try {
      record(String((report && report.name) || 'crash'), detail);
    } catch (error) {
      // 上报失败也不该炸：诊断是辅助能力。
    }
  });
  return reports.length;
}

function defaultRecordCrash(name, detail) {
  recordDiagnostic('storage', new Error(`[screen-overlay] last crash stack ${name}`), detail);
}

/**
 * FIX-SW5 P1-5：识图测试的失败上报（截屏段 / 生成段共用）。
 *
 * 两段各自调用本函数，于是「弹窗文案」与「诊断日志记录」永远成对出现，
 * 不会出现「记了日志但弹窗说谎」或「弹窗对了但日志没记」。
 *
 * detail 同时接受 Error 与**字符串**抛出——原实现写的是 `error.message`，
 * error 为字符串时它是 undefined，于是弹窗里连原因都没有（用户截图正是这个现象）。
 *
 * @param {object} args
 * @param {string} args.stage    'capture' | 'generate'（ASCII，进诊断日志）
 * @param {string} args.kind     诊断分类（storage / api）
 * @param {unknown} args.error   原始错误（Error 或字符串）
 * @param {string} args.context  诊断附注（如 'view-shot'）
 * @param {string} args.title    弹窗标题（i18n 已译）
 * @param {string} args.body     弹窗正文（i18n 已译）
 */
export function reportCaptureFailure({
  stage, kind, error, context, title, body,
  alert = Alert.alert,
  detailOf = extractDetail,
}) {
  const detail = detailOf(error);
  try {
    recordDiagnostic(
      kind,
      new Error(`[screen-watch] vision-test ${stage} failed${detail ? `: ${detail}` : ''}`),
      context
    );
  } catch (inner) {
    // 记日志失败不该挡住弹窗：用户至少要知道失败了。
  }
  alert(title, detail ? `${body}\n\n${detail}` : body);
}

/** 从任意抛出物取出可展示的原因（脱敏 + 截断）。 */
export function extractDetail(error) {
  return maskSecrets(String((error && error.message) || error || '')).trim();
}
