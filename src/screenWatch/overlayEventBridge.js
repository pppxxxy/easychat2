// FEAT-AC7 P0-A：悬浮窗**事件监听器的 app 级常驻**（修 BUG-1 / BUG-3 的结构病）。
//
// 本轮根因（已对码核实）：chat-send / trace / request-capture 三个订阅此前全挂在
// **ScreenWatchScreen（角色版看屏幕页）的 useEffect 里**。那是「组件级订阅」，于是：
//   · 用户在工作区页 / 其它页面 / app 退后台时，该组件不在栈顶 ⇒ 监听器**根本不存在**；
//   · 原生 P0-D 修好的 EVENT_CHAT_SEND 发出来了，JS 侧没人接 → 静默丢弃
//     （用户截图 #285：在工作区面板连发「？」都没人理）；
//   · 更隐蔽的是 **trace（打点落盘入口）也在那里** ⇒ 用户整轮测试都不在看屏幕页，
//     诊断日志**一条都没落**。AC5 验收第 4 条「日志干净」因此是**假通过**——
//     不是干净，是观测器没上班。
//
// 修法：把这三个订阅搬到 app 级常驻（本模块，由 App 装配渲染一次），
// 与任何页面的挂载/卸载彻底解耦。
//
// **事件归属表（每个事件恰好一个订阅者，绝不双重订阅）**：
//   · trace           → 本模块（落盘）。页面从不需要它。
//   · chat-send       → 本模块。工作区 scope 自足；聊天 scope 走页面注入的实现。
//   · request-capture → 本模块。页面注入实现；页面不在时给兜底文案（不许沉默）。
//   · capture / captureFailed → **仍归页面**：那是页面自己在 await 的一帧结果
//     （waitForCapture 的 resolve），搬走会让页面的等待永远等不到。
//     app 级不订阅这两条，因此不存在「一个事件两个处理者」。
//
// 为什么是组件而不是模块级 start()：订阅必须随 React 树装卸，
// 用 useEffect 才能保证热重载/卸载时正确退订（模块级单例会在热重载后重复订阅，
// 同一事件被处理两次）。

import { useEffect } from 'react';

import {
  addChatSendListener,
  addRequestCaptureListener,
  addTraceListener,
  pushOverlayChatMessage,
  updateOverlayText,
} from './overlay.js';
import { runAndPushOverlayWorkspaceTurn } from './overlayWorkspaceTurn.js';
import { setTurnEventRecorder } from './turnDiagnostics.js';
import { recordDiagnostic } from '../storage/diagnostics.js';
import { tActive } from '../i18n/index.js';

// ---- 页面注入的实现（页面挂载时填充，卸载时清空）----
//
// 为什么用 ref 而不是 context/props：这两个 handler 只在**事件到达那一刻**才需要，
// 而事件来自原生（与 React 渲染无关）。注入式让「页面在不在」变成一个显式的、
// 可兜底的状态，而不是「订阅消失 → 静默丢弃」。
let chatHandler = null;      // 聊天 scope：页面的 generate（角色评论管线）
let captureHandler = null;   // 采集请求：页面的 handleOverlayRequestCapture

/** 页面挂载时注入聊天 scope 处理器；卸载时传 null。 */
export function setOverlayChatHandler(handler) {
  chatHandler = typeof handler === 'function' ? handler : null;
}

/** 页面挂载时注入采集请求处理器；卸载时传 null。 */
export function setOverlayCaptureHandler(handler) {
  captureHandler = typeof handler === 'function' ? handler : null;
}

/** 测试/宿主可见：清空注入（仅测试用）。 */
export function __resetOverlayEventBridge() {
  chatHandler = null;
  captureHandler = null;
  chatBusy = false;
}

/** 测试/宿主可见：当前是否已注入聊天处理器。 */
export function hasOverlayChatHandler() {
  return typeof chatHandler === 'function';
}

// 串行化聊天 scope 的回合（工作区 scope 的串行在 overlayWorkspaceTurn 里）。
let chatBusy = false;

/**
 * 处理一条悬浮窗发来的话（导出以便单测直接驱动，不必模拟原生事件）。
 *
 * 这是本轮 BUG-1 的修复点：工作区 scope **完全自足**——不依赖任何页面在场。
 */
export async function handleOverlayChatSend({ text, scope } = {}) {
  if (scope === 'workspace') {
    await runAndPushOverlayWorkspaceTurn({
      text,
      // P0-F：先给一条忙反馈（「正在处理…」），结束由 runAndPush 推结果替换。
      // 悬浮窗里不允许「发了话之后什么都没有」。
      onBusy: () => updateOverlayText(tActive('screenWatch.overlay.turnBusy')),
    });
    return;
  }
  // 聊天 scope：需要页面的生成管线（角色评论）。页面不在时**如实说明**，不静默丢弃。
  if (typeof chatHandler !== 'function') {
    await pushOverlayChatMessage({
      role: 'assistant',
      text: tActive('screenWatch.overlay.chatNeedsPage'),
    }).catch(() => {});
    return;
  }
  if (chatBusy) return;
  chatBusy = true;
  try {
    await chatHandler({ text, scope });
  } catch (error) {
    await pushOverlayChatMessage({
      role: 'assistant',
      text: tActive('screenWatch.comments.failed'),
    }).catch(() => {});
  } finally {
    chatBusy = false;
  }
}

/**
 * app 级悬浮窗事件桥。渲染一次（App 装配处），随 app 生命周期装卸。
 * 渲染 null——它只做订阅，不画任何东西。
 */
export default function OverlayEventBridge() {
  useEffect(() => {
    // ① 打点落盘（BUG-3 的核心）：app 级常驻，不再依赖看屏幕页是否打开。
    const offTrace = addTraceListener();
    // ② 悬浮窗里发来的话（BUG-1 的核心）。
    const offChat = addChatSendListener(payload => { handleOverlayChatSend(payload); });
    // ③ 采集请求：页面不在时如实说明（原生「截屏」按钮不该得到永远的沉默）。
    const offRequest = addRequestCaptureListener(() => {
      if (typeof captureHandler === 'function') {
        captureHandler();
        return;
      }
      updateOverlayText(tActive('screenWatch.overlay.captureNeedsPage')).catch(() => {});
    });

    // P0-D：回合打点落盘（info 级、无堆栈——见 turnDiagnostics 的分级纪律）。
    setTurnEventRecorder(message => {
      recordDiagnostic('log', { message: `[agent-turn] ${message}` }, 'agent-turn');
    });

    return () => {
      offTrace();
      offChat();
      offRequest();
      setTurnEventRecorder(null);
    };
  }, []);

  return null;
}
