// FEAT-AC5 P0-B：悬浮窗状态的**回前台对账**（纯逻辑层，零 RN 依赖 → Node 直测）。
//
// 问题（已对码核实）：扩展页与工作区面板此前都只在**挂载时**查一次 isOverlayActive()，
// 之后全靠原生事件推送（onDestroy → emitState(false)）。事件本身是通的，但 app 在后台被
// ROM 冻结时事件会丢（本仓 overlay.js 的后台冻结注释自己标过这个风险），于是 JS 永远收不到
// 「已经关了」——状态行就永久停在「关闭悬浮窗」，而实际上悬浮窗早就没了。
//
// 取舍（任务书 §三）：**事件推送保留，对账兜底加上**。事件是即时的，对账是保命的。
// 本文件只做「本地态 vs 真实态要不要改、要不要留痕」这一个判定；AppState 接线属
// 环境胶水，放在 useOverlayActive.js（那里不设 Node 测试，按仓库纪律只测纯逻辑）。

/**
 * 对账判定。
 *
 * `actual` 是**三态**：true / false / null（null = 读不到真实状态）。
 * 读不到时必须**不动**本地态——把「读失败」当成「未开启」会让状态行撒谎，
 * 与本仓「读不出来 ≠ 没有」的既有口径（threads.js 三态、memory.screenWatch.readFailed）
 * 完全同型。宁可显示上一次的真实值，也不要显示一个编出来的值。
 *
 * @param {object} raw
 * @param {boolean} raw.localActive 当前界面持有的状态
 * @param {boolean|null|undefined} raw.actual 原生查到的真实状态（null/undefined = 读不到）
 * @returns {{changed: boolean, active: boolean, message: string}}
 *   changed=true 时调用方应刷新界面，并把 message 写进诊断（kind=storage，纯文本无 stack）。
 */
export function reconcileOverlayState(raw = {}) {
  // ⚠️ 必须显式挡 null：解构默认值**只对 undefined 生效**，显式传 null 会抛
  //（与 overlayConfirm.normalizeOverlayConfirmRequest 同款踩坑——调用方从原生载荷
  //  或 JSON 里取值时拿到 null 是常态）。
  const source = raw && typeof raw === 'object' ? raw : {};
  const local = source.localActive === true;
  const actual = source.actual;
  // 读不到真实状态：维持本地态，不留痕（一次读失败不是「状态变了」）。
  if (actual !== true && actual !== false) {
    return { changed: false, active: local, message: '' };
  }
  if (local === actual) {
    return { changed: false, active: actual, message: '' };
  }
  // 只有**真的不一致**才留痕：诊断日志的价值在于「异常」二字，每次回前台都记一条
  // 只会把日志重新灌成噪音（这正是本轮 P0-C 在治的病）。
  return {
    changed: true,
    active: actual,
    message: `overlay state reconciled: local=${local ? 'on' : 'off'} actual=${actual ? 'on' : 'off'}`,
  };
}

/**
 * 归一「查到的真实状态」为三态。
 *
 * 原生封装（overlay.js 的 isOverlayActive）把异常吞成 false——那个返回值**不能**用来
 * 区分「确实没开」与「查不到」，所以对账走 overlay.js 的 readOverlayActive（失败返回 null），
 * 本函数是它返回值的最后一道归一（老构建没有该方法 / 返回非布尔）。
 */
export function normalizeActualOverlayState(raw) {
  if (raw === true) return true;
  if (raw === false) return false;
  return null;
}
