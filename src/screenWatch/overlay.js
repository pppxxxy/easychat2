// 看屏幕悬浮窗的原生桥薄封装：惰性取 NativeModules.ScreenOverlay，所有方法在
// 不支持该构建时安全降级（返回 false / 空），调用方据此显示「当前构建不支持」。
// 原生模块名、方法名与事件名见 plugins/screenOverlay/android/ScreenOverlayModule.kt
// 与 OverlayService.kt；事件参数解析走 overlayEvents.js（纯函数）。

import { DeviceEventEmitter, NativeModules } from 'react-native';

import {
  OVERLAY_EVENT_CAPTURE,
  OVERLAY_EVENT_REQUEST_CAPTURE,
  OVERLAY_EVENT_STATE,
  parseCaptureEvent,
  parseStateEvent,
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

// 订阅事件；返回取消函数。原生运行时 Node 进不去，这里是唯一触碰 DeviceEventEmitter 的地方。
export function addCaptureListener(handler) {
  const subscription = DeviceEventEmitter.addListener(OVERLAY_EVENT_CAPTURE, payload => {
    const parsed = parseCaptureEvent(payload);
    if (parsed && typeof handler === 'function') handler(parsed);
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
