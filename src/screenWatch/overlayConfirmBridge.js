// FEAT-AC4 P0-A：悬浮窗**窗内确认**的 JS 编排（把 registry 的 confirm 钩子接到确认卡）。
//
// 背景：悬浮窗工作区回合此前被 `confirm: async () => false` 锁死（一律自动拒绝），
// 于是 AC1/AC2 的写类工具在悬浮窗里根本无法执行。现在改为：把确认推成一张
// 窗内卡片、挂起等待用户点击，超时按拒绝。
//
// 本文件只做**编排**（把纯层的注册表 + 原生桥接起来）；全部判定在
// overlayConfirm.js（纯函数/纯类，Node 直测）。

import { AppState } from 'react-native';

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
    try {
      recordDiagnostic(
        'log',
        new Error(`[overlay-confirm] ${reason}`),
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
 *   · app 不在前台（悬浮窗不可见 / 进程被冻结）→ 拒绝（推了也没人看）；
 *   · 推送失败 → 拒绝；
 *   · 60 秒没点 → 拒绝。
 * 宁可少做一次操作，也绝不在无人应答时默默放行写操作。
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
    // 悬浮窗只在 app 前台时对用户可见；后台时推卡片毫无意义 → 直接拒绝。
    const foreground = AppState.currentState === 'active';
    if (!foreground) {
      try {
        recordDiagnostic('log', new Error('[overlay-confirm] rejected'), `id=- reason=background tool=${name}`);
      } catch (error) {}
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
    // 推卡片：失败（老构建 / 服务不在）→ 立刻按拒绝结算，不把 agent 悬着。
    pushOverlayConfirm({ id, summary, timeoutMs: OVERLAY_CONFIRM_TIMEOUT_MS })
      .then(ok => {
        if (!ok) ensureRegistry().settleById(id, { approved: false, reason: 'unavailable' });
      })
      .catch(() => {
        ensureRegistry().settleById(id, { approved: false, reason: 'unavailable' });
      });
  });
}
