// FEAT-AC5 P0-B：悬浮窗状态的**回前台对账**（环境胶水层）。
//
// 全部判定在 overlayStateSync.js（纯函数，Node 直测）；本文件只做接线：
// 挂载查询 + 事件订阅 + AppState 回前台重查。按仓库纪律，环境胶水不设 Node 测试。
//
// 为什么两处共用同一个 hook（扩展页 ScreenWatchScreen 与工作区 ScreenWatchPanel）：
// 两处都在显示悬浮窗状态行，此前**各自**只在挂载时查一次——同一个病写两遍。
// 抽成一处后，「回前台对账」这件事只有一个实现，新增第三个状态行也不会再漏。

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { addStateListener, isOverlaySupported, readOverlayActive } from './overlay.js';
import { normalizeActualOverlayState, reconcileOverlayState } from './overlayStateSync.js';
import { recordDiagnostic } from '../storage/diagnostics.js';

/**
 * 订阅悬浮窗真实状态，并在**回前台**时对账一次。
 *
 * @returns {{active: boolean, setActive: Function, reconcile: Function}}
 *   setActive 供「开启/关闭」成功后就地更新（乐观更新，与既有行为一致）；
 *   reconcile 供调用方在需要时主动重查。
 */
export default function useOverlayActive() {
  const [active, setActiveState] = useState(false);
  // 对账要读「当前本地态」，但它不该进 useCallback 依赖（否则每次状态变化都重建订阅）。
  // 用 ref 镜像：与仓库既有做法一致（ChatPanel 的 draftRef 等同型）。
  const activeRef = useRef(false);
  activeRef.current = active;

  // 对外暴露的 setter **同时**写 ref：调用方（开启/关闭按钮）刚做完动作就 setActive，
  // 紧接着 refresh 会对账一次——若 ref 还停在旧值，一次用户主动的关闭会被记成
  // 「对账发现不一致」，往诊断里灌一条假事件（正是 P0-C 在治的噪音）。
  const setActive = useCallback(next => {
    const value = next === true;
    activeRef.current = value;
    setActiveState(value);
  }, []);

  const reconcile = useCallback(async () => {
    const actual = normalizeActualOverlayState(await readOverlayActive());
    const result = reconcileOverlayState({ localActive: activeRef.current, actual });
    if (!result.changed) return result.active;
    activeRef.current = result.active;
    setActiveState(result.active);
    // 留痕：状态被对账**改过**才记（每次回前台都记会把日志重新灌成噪音，
    // 那正是本轮 P0-C 在治的病）。kind=storage 属既有白名单，纯文本无堆栈。
    if (result.message) {
      try {
        recordDiagnostic('storage', { message: result.message }, 'overlay-state-sync');
      } catch (error) {}
    }
    return result.active;
  }, []);

  useEffect(() => {
    // 不支持的构建：状态行显示的是「当前构建不支持」，不必查也不必对账。
    if (!isOverlaySupported()) return undefined;
    let cancelled = false;

    // ① 挂载查询（既有行为逐字保留：查不到就维持 false，不猜）。
    (async () => {
      const value = normalizeActualOverlayState(await readOverlayActive());
      if (cancelled || value === null) return;
      activeRef.current = value;
      setActiveState(value);
    })();

    // ② 事件推送（即时）：保留原有链路——事件没丢时它是零延迟的。
    const offState = addStateListener(({ active: next }) => {
      activeRef.current = next;
      setActiveState(next);
    });

    // ③ 对账兜底（保命）：回前台必然重查一次。
    // 这条覆盖「用户从悬浮窗自己的『关闭』关掉，app 侧不知情」——后台被 ROM 冻结时
    // 事件会丢（overlay.js 注释自己标过），回前台对账是唯一能自愈的时机。
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      const cameToForeground = previous !== 'active' && next === 'active';
      previous = next;
      if (cameToForeground) reconcile().catch(() => {});
    });

    return () => {
      cancelled = true;
      offState();
      subscription.remove();
    };
  }, [reconcile]);

  return { active, setActive, reconcile };
}
