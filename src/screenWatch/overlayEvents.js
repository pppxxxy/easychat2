// 悬浮窗原生事件的纯解析层：事件名常量 + 参数归一。
// 不依赖 react-native，可在纯 Node 测试里直接加载（overlay.js 才触碰原生模块）。

export const OVERLAY_EVENT_CAPTURE = 'ScreenOverlay:onCapture';
export const OVERLAY_EVENT_CAPTURE_FAILED = 'ScreenOverlay:onCaptureFailed';
export const OVERLAY_EVENT_REQUEST_CAPTURE = 'ScreenOverlay:onRequestCapture';
export const OVERLAY_EVENT_STATE = 'ScreenOverlay:onState';

// 原生抓到一帧：{ path }（file:// URI）。无路径视为无效事件。
export function parseCaptureEvent(payload) {
  const path = String((payload && payload.path) || '');
  if (!path) return null;
  return { path };
}

// 原生采集失败：{ reason }。reason 用于区分处置方式（授权失效 vs 一般失败），缺省按未知。
export function parseCaptureFailedEvent(payload) {
  return { reason: String((payload && payload.reason) || 'unknown') };
}

// 服务启停：{ active }。缺字段按 false 处理。
export function parseStateEvent(payload) {
  return { active: !!(payload && payload.active) };
}
