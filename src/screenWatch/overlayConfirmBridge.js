// FEAT-AC4 P0-A：悬浮窗**窗内确认**的 JS 编排（把 registry 的 confirm 钩子接到确认卡）。
//
// 背景：悬浮窗工作区回合此前被 `confirm: async () => false` 锁死（一律自动拒绝），
// 于是 AC1/AC2 的写类工具在悬浮窗里根本无法执行。现在改为：把确认推成一张
// 窗内卡片、挂起等待用户点击，超时按拒绝。
//
// 本文件只做**编排**（把纯层的注册表 + 原生桥接起来）；全部判定在
// overlayConfirm.js（纯函数/纯类，Node 直测）。

import {
  OverlayConfirmRegistry,
  OVERLAY_CONFIRM_TIMEOUT_MS,
  renderOverlayConfirmSummary,
} from './overlayConfirm.js';
import { addConfirmResultListener, pushOverlayConfirm } from './overlay.js';
import { recordDiagnostic } from '../storage/diagnostics.js';
import { tActive } from '../i18n/index.js';

// 进程级单例：确认挂起表与「当前有没有悬浮窗在工作区回合」无关——
// 一个 app 进程里同时只可能有一个悬浮窗。
let registry = null;
let unsubscribe = null;

function ensureRegistry() {
  if (!registry) registry = new OverlayConfirmRegistry();
  return registry;
}

/** 测试/宿主可见：重置（仅测试用）。 */
export function __resetOverlayConfirmBridge() {
  if (registry) registry.settleAll('reset');
  registry = null;
}

/**
 * 启动原生结果监听（幂等）。返回退订函数。
 *
 * 为什么监听要常驻而不是每次确认临时挂：结算必须能被**迟到**的事件处理
 *（用户点得慢、或卡片超时后才点）——注册表本身幂等，重复/迟到的结果静默忽略。
 */
export function startOverlayConfirmBridge() {
  ensureRegistry();
  if (unsubscribe) return unsubscribe;
  unsubscribe = addConfirmResultListener(({ id, approved, reason }) => {
    const settled = ensureRegistry().settleById(id, { approved, reason });
    // 留痕：允许/拒绝/超时各打一条（验收第 5 条要求全程可追）。
    // FEAT-AC5 P0-C：改传 { message } 对象——这是**例行打点**，不是错误，
    // 不该带 JS 堆栈（原先 new Error 让每条都写成「Error: [overlay-confirm] denied」，
    // 用户真机日志里满屏 Error 前缀，真错误反而被埋掉）。
    try {
      recordDiagnostic(
        'log',
        { message: `[overlay-confirm] ${reason}` },
        `id=${id} settled=${settled}`
      );
    } catch (error) {}
  });
  return unsubscribe;
}

/**
 * 构造给 runWorkspaceWatchTurn 的 confirm 钩子。
 *
 * 语义完全照 registry 的既定纪律：**问不到用户 = 不执行**。
 *   · 原生不支持确认卡（老构建）→ 拒绝；
 *   · 推送失败 / 卡片无处可放（悬浮窗收起、服务不在）→ 拒绝；
 *   · 60 秒没点 → 拒绝。
 * 宁可少做一次操作，也绝不在无人应答时默默放行写操作。
 *
 * FEAT-AC5 P0-D：**删掉了「app 不在前台就拒绝」这条判据**（原 :83-93）。
 * 它不是安全机制，而是个错误判据：
 *   · 悬浮窗**本来就是给「用户在看别的 app」用的**——我们的 Activity 在后台恰恰是它的
 *     主场景。而确认卡由 OverlayService 经 WindowManager 渲染，**与 Activity 前后台无关**：
 *     app 在后台时用户照样看得见、点得到。
 *   · 旧判据把主场景一律拒掉 ⇒ P0-A 的窗内确认卡在最需要它的时刻永不出现，
 *     用户看到的就是「写操作被拒」（截图 #257 被拒的第二层原因）。
 *   · 安全语义**一字未松**：本判据从来只会产生拒绝、从不产生放行；去掉它只是把
 *     「无条件拒绝」换回「去问用户（允许/拒绝/超时按拒绝）」。真正的安全保证是
 *     「必须有一次显式点击，否则超时即拒绝」，那条在 registry 里，未动。
 * 「能不能问到用户」现在由**原生**给答案（它才知道卡片放不放得下），
 * 单一事实源，不在 JS 侧猜。
 *
 * @returns {(call: {name: string, args?: object}) => Promise<boolean>}
 */
export function createOverlayConfirmHandler({ summarize = null } = {}) {
  startOverlayConfirmBridge();
  return call => new Promise(resolve => {
    const name = String((call && call.name) || '').trim();
    if (!name) {
      resolve(false);
      return;
    }
    const id = `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const summary = renderOverlayConfirmSummary({ name, args: call && call.args, render: summarize });
    const registered = ensureRegistry().register(
      {
        id,
        summary,
        timeoutMs: OVERLAY_CONFIRM_TIMEOUT_MS,
        // 兜底文案走 i18n（纯逻辑层不许硬编码中文——见 normalizeOverlayConfirmRequest）。
        fallbackSummary: tActive('screenWatch.overlay.confirm.fallback'),
      },
      result => resolve(result.approved === true)
    );
    if (!registered) {
      resolve(false);
      return;
    }
    // 推卡片：失败（老构建 / 服务不在 / 悬浮窗收起放不下）→ 立刻按拒绝结算，不把 agent 悬着。
    // 这条路径也是「问不到用户」的如实回答：助手会据此说明没能确认，而不是白等 60 秒。
    pushOverlayConfirm({ id, summary, timeoutMs: OVERLAY_CONFIRM_TIMEOUT_MS })
      .then(ok => {
        if (!ok) ensureRegistry().settleById(id, { approved: false, reason: 'unavailable' });
      })
      .catch(() => {
        ensureRegistry().settleById(id, { approved: false, reason: 'unavailable' });
      });
  });
}
