// 看屏幕悬浮窗的原生桥薄封装：惰性取 NativeModules.ScreenOverlay，所有方法在
// 不支持该构建时安全降级（返回 false / 空），调用方据此显示「当前构建不支持」。
// 原生模块名、方法名与事件名见 plugins/screenOverlay/android/ScreenOverlayModule.kt
// 与 OverlayService.kt；事件参数解析走 overlayEvents.js（纯函数）。

import { DeviceEventEmitter, NativeModules } from 'react-native';

import { recordDiagnostic } from '../storage/diagnostics.js';
import {
  OVERLAY_EVENT_CAPTURE,
  OVERLAY_EVENT_CAPTURE_FAILED,
  OVERLAY_EVENT_CHAT_SEND,
  OVERLAY_EVENT_REQUEST_CAPTURE,
  OVERLAY_EVENT_STATE,
  OVERLAY_EVENT_TRACE,
  parseCaptureEvent,
  parseCaptureFailedEvent,
  parseChatSendEvent,
  parseStateEvent,
  parseTraceEvent,
} from './overlayEvents.js';

function nativeModule() {
  return NativeModules.ScreenOverlay || null;
}

export function isOverlaySupported() {
  return !!nativeModule();
}

export async function canDrawOverlays() {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.canDrawOverlays());
  } catch (error) {
    return false;
  }
}

export async function requestOverlayPermission() {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.requestOverlayPermission());
  } catch (error) {
    return false;
  }
}

export async function requestCapturePermission() {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.requestCapturePermission());
  } catch (error) {
    return false;
  }
}

export async function startOverlay() {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.startOverlay());
  } catch (error) {
    return false;
  }
}

// ---- 双入口统一的启动链（FIX-3）----
//
// 背景（真机 bug）：两个入口的行为**不一致**，导致「设置页直接点 → 显示启动失败」：
//   · 扩展页 ScreenWatchScreen：canDrawOverlays → requestCapturePermission → startOverlay（正确）
//   · 设置页 ScreenWatchPanel：只查悬浮窗权限，**从不申请投屏授权** → startOverlay 必然 false
// 现在统一到这一条链：悬浮窗权限 → 投屏授权 → 启动。任何一步失败都返回具体原因，
// 调用方据此给出**可处置**的提示（而不是笼统的「启动失败」）。
//
// 幂等由原生侧保证（requestCapturePermissionInternal 排队复用同一次授权弹窗），
// 这里再叠一层 JS 侧的 in-flight 复用：连点按钮不会叠出两个系统弹窗。
let startChainInFlight = null;

export const OVERLAY_START_RESULT = Object.freeze({
  OK: 'ok',
  UNSUPPORTED: 'unsupported',
  OVERLAY_PERMISSION: 'overlay-permission',
  CAPTURE_PERMISSION: 'capture-permission',
  START_FAILED: 'start-failed',
});

async function runStartChain() {
  if (!nativeModule()) return { ok: false, reason: OVERLAY_START_RESULT.UNSUPPORTED };
  let overlayReady = false;
  try {
    overlayReady = await canDrawOverlays();
    if (!overlayReady) {
      // 悬浮窗权限只能跳系统设置让用户自己开（系统没有可编程授予的接口），
      // 所以这里申请完就如实返回「还没授权」，由调用方引导用户回来再点。
      await requestOverlayPermission();
      return { ok: false, reason: OVERLAY_START_RESULT.OVERLAY_PERMISSION };
    }
    // startOverlay 在原生侧已内建「无 token 先弹授权」的逻辑，所以这里**不再**单独调
    // requestCapturePermission——否则会多弹一次系统授权窗（原生那一步已经会要）。
    //
    // ⚠️ 这里**不用** startOverlay()（那个包装把一切异常吞成 false）：否则原生侧的
    // 真实失败（服务起不来、SecurityException 降级后仍失败）会被误报成
    // 「投屏授权」档，界面就把用户指去重新授权——而授权根本不是问题所在。
    // 允许异常穿透到下面的 catch，才能如实区分「权限没给」与「启动真失败」。
    const started = !!(await nativeModule().startOverlay());
    return started
      ? { ok: true, reason: OVERLAY_START_RESULT.OK }
      : { ok: false, reason: OVERLAY_START_RESULT.CAPTURE_PERMISSION };
  } catch (error) {
    return { ok: false, reason: OVERLAY_START_RESULT.START_FAILED };
  }
}

// 依次确保权限并启动。返回 { ok, reason }。并发调用复用同一次进行中的链路。
//
// ⚠️ 清理 in-flight 标记必须用 `chain.then(...)` 而**不是**在 async 函数体里写
// `finally { startChainInFlight = null }`：后者的同步提前返回分支（无原生模块时）
// 会在赋值 `startChainInFlight = chain` **之前**就把标记清成 null，随后赋值又把它
// 钉成一个已结算的 promise ⇒ 之后所有调用永远拿到那份旧结果，再也不会真正启动。
export function ensurePermissionThenStart() {
  if (startChainInFlight) return startChainInFlight;
  const chain = runStartChain();
  startChainInFlight = chain;
  const clear = () => {
    if (startChainInFlight === chain) startChainInFlight = null;
  };
  chain.then(clear, clear);
  return chain;
}

export async function stopOverlay() {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.stopOverlay());
  } catch (error) {
    return false;
  }
}

export async function isOverlayActive() {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.isOverlayActive());
  } catch (error) {
    return false;
  }
}

// 请求原生抓一帧；结果经 onCapture 事件异步回传，本调用只表示「已受理」。
export async function captureOverlayFrame() {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.capture());
  } catch (error) {
    return false;
  }
}

export async function updateOverlayText(text) {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.updateOverlayText(String(text || '')));
  } catch (error) {
    return false;
  }
}

// 小窗标题显示的角色名（不支持的构建/失败时静默：标题按原生默认「看屏幕」）。
export async function setOverlayCharacterName(name) {
  const module = nativeModule();
  if (!module) return false;
  try {
    return !!(await module.setCharacterName(String(name || '')));
  } catch (error) {
    return false;
  }
}

// SW3：把一条消息推给悬浮窗渲染（原生只做嘴和眼，LLM/工具/确认都在 JS 侧）。
// payload 由 buildChatPushPayload 归一（role + text + 可选 confirm 题卡）。
// 老构建没有这个方法时静默返回 false——悬浮窗仍可用（只是不显示这条回复）。
export async function pushOverlayChatMessage(payload) {
  const module = nativeModule();
  if (!module || typeof module.pushChatMessage !== 'function') return false;
  const safe = payload && typeof payload === 'object' ? payload : {};
  try {
    return !!(await module.pushChatMessage(
      String(safe.role || 'assistant'),
      String(safe.text || '')
    ));
  } catch (error) {
    return false;
  }
}

// SW3：键盘遮挡时上移面板（0 = 收起）。失败静默（面板位置不致命）。
export async function setOverlayImeInset(insetBottom) {
  const module = nativeModule();
  if (!module || typeof module.setImeInset !== 'function') return false;
  try {
    return !!(await module.setImeInset(Number(insetBottom) || 0));
  } catch (error) {
    return false;
  }
}

// ---- 无障碍权限链路 ----
//
// 现状如实说明：跨应用截屏走 MediaProjection（**逐会话授权**，每次开启悬浮窗都要
// 用户在系统弹窗里确认），没有任何无障碍服务参与采集。用户反馈「在 App 外截屏一直
// 失败」，逐会话授权本身就是最可疑的一环。无障碍服务（用户手动开启后由系统常驻绑定）
// 是更省事的备选路径，本批只做「状态查询 + 引导开启」，**不接管采集**。
//
// ⚠️ 未在本地核实：沙箱无 Android SDK / Java，isAccessibilityEnabled 的原生实现
// 无法编译或运行验证；无障碍截屏 API 的可用性也未核实，故完全没有接入。
// 界面文案据此不得把话说满（只承诺「少一次录屏授权」）。

// 无障碍是否已开启（原生查询系统设置 + 进程内绑定标记）。
// 查询失败一律按「未开启」返回 false：调用方据此显示引导，而抛错只会让用户
// 卡在一个他无法处置的错误上。
export async function isAccessibilityEnabled() {
  const module = nativeModule();
  if (!module || typeof module.isAccessibilityEnabled !== 'function') return false;
  try {
    return !!(await module.isAccessibilityEnabled());
  } catch (error) {
    return false;
  }
}

// 跳到系统「无障碍」设置页。**无法直达本应用那一项**（系统没有这样的 Intent
// extra，未在本地核实是否存在厂商扩展），所以界面文案必须说「在列表里找到本应用」。
export async function openAccessibilitySettings() {
  const module = nativeModule();
  if (!module || typeof module.openAccessibilitySettings !== 'function') return false;
  try {
    return !!(await module.openAccessibilitySettings());
  } catch (error) {
    return false;
  }
}

// ---- 后台冻结检测（FIX-4 第 4 条）----
//
// 国产 ROM（荣耀/华为）冻结后台进程时整个主线程暂停，采集的兜底与超时全部失灵，
// 表现就是「悬浮窗还在、点了没反应、一直等」。线程化消不掉系统行为，只能检测 + 引导。
//
// 查询失败按「已放行」返回 true：老构建没有这个方法时不该弹一个用户无法处置的引导。
export async function isIgnoringBatteryOptimizations() {
  const module = nativeModule();
  if (!module || typeof module.isIgnoringBatteryOptimizations !== 'function') return true;
  try {
    return !!(await module.isIgnoringBatteryOptimizations());
  } catch (error) {
    return true;
  }
}

export async function openBatteryOptimizationSettings() {
  const module = nativeModule();
  if (!module || typeof module.openBatteryOptimizationSettings !== 'function') return false;
  try {
    return !!(await module.openBatteryOptimizationSettings());
  } catch (error) {
    return false;
  }
}

// 订阅事件；返回取消函数。原生运行时 Node 进不去，这里是唯一触碰 DeviceEventEmitter 的地方。
export function addCaptureListener(handler) {
  const subscription = DeviceEventEmitter.addListener(OVERLAY_EVENT_CAPTURE, payload => {
    const parsed = parseCaptureEvent(payload);
    if (parsed && typeof handler === 'function') handler(parsed);
  });
  return () => subscription.remove();
}

// 原生采集失败（投影未建立/解码失败/写盘失败）：调用方据此立即结束等待并提示。
export function addCaptureFailedListener(handler) {
  const subscription = DeviceEventEmitter.addListener(OVERLAY_EVENT_CAPTURE_FAILED, payload => {
    if (typeof handler === 'function') handler(parseCaptureFailedEvent(payload));
  });
  return () => subscription.remove();
}

export function addRequestCaptureListener(handler) {
  const subscription = DeviceEventEmitter.addListener(OVERLAY_EVENT_REQUEST_CAPTURE, () => {
    if (typeof handler === 'function') handler();
  });
  return () => subscription.remove();
}

export function addStateListener(handler) {
  const subscription = DeviceEventEmitter.addListener(OVERLAY_EVENT_STATE, payload => {
    if (typeof handler === 'function') handler(parseStateEvent(payload));
  });
  return () => subscription.remove();
}

// SW3：悬浮窗里用户发来的话（{ text, scope }）——scope 决定走哪条管线。
// 空文本由 parseChatSendEvent 挡掉（不把空消息送进模型）。
export function addChatSendListener(handler) {
  const subscription = DeviceEventEmitter.addListener(OVERLAY_EVENT_CHAT_SEND, payload => {
    const parsed = parseChatSendEvent(payload);
    if (parsed && typeof handler === 'function') handler(parsed);
  });
  return () => subscription.remove();
}

// FIX-4：采集链路打点 → 诊断日志。
//
// 为什么必须落诊断：真机上「一直等」此前完全不可观测——不知道卡在请求 / 帧到达 /
// 压缩 / 落盘 / emit / JS 接收的哪一环。荣耀等 ROM 的后台冻结若仍导致偶发挂死，
// 日志会直接指出断点，不必再猜。
// kind 用 'storage'：诊断模块的 VALID_KINDS 里没有专门的采集类目，而采集失败本质是
// 设备/IO 侧问题（与 storage 同类：本机资源不可用），归到那里才不会被打成 'unhandled'
// 而被埋在未捕获异常里。
export function addTraceListener(handler) {
  const subscription = DeviceEventEmitter.addListener(OVERLAY_EVENT_TRACE, payload => {
    const parsed = parseTraceEvent(payload);
    if (!parsed) return;
    recordDiagnostic('storage', new Error(`[screen-overlay] ${parsed.stage}`), parsed.detail);
    if (typeof handler === 'function') handler(parsed);
  });
  return () => subscription.remove();
}
