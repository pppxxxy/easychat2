// 定时主动消息（原生模块 ProactiveMessage）的 JS 封装。
// 原生实现由 plugins/withProactiveMessage.js 在 prebuild 时注入 android/ 工程。
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

const native = Platform.OS === 'android' ? NativeModules.ProactiveMessage : null;

function requireNative() {
  if (!native) {
    throw new Error('当前环境不支持定时主动消息（仅 Android 原生构建可用）');
  }
  return native;
}

export function isProactiveMessageAvailable() {
  return !!native;
}

// config: { roleId, roleName, persona, hour, minute, mode: 'WORK'|'EXACT', enabled }
export async function scheduleDailyMessage(config) {
  return requireNative().schedule(config);
}

export async function cancelDailyMessage(roleId) {
  return requireNative().cancel(roleId);
}

// apiKey 来自用户自己在设置页填写的值
export async function setProactiveApiSettings({ endpoint, model, apiKey }) {
  return requireNative().setApiSettings({ endpoint, model, apiKey });
}

export async function canScheduleExactAlarms() {
  return requireNative().canScheduleExactAlarms();
}

export async function openExactAlarmSettings() {
  return requireNative().openExactAlarmSettings();
}

export async function openBatteryOptimizationSettings() {
  return requireNative().openBatteryOptimizationSettings();
}

// Android 13+ 通知运行时权限，用 RN 内置 API 申请
export async function requestNotificationPermission() {
  if (Platform.OS !== 'android') return false;
  // PermissionsAndroid 常量仅在 API 33+ 定义
  const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!perm) return true;
  const result = await PermissionsAndroid.request(perm);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

// 通知点击 -> roleId。返回取消订阅函数。
export function addOpenRoleListener(callback) {
  if (!native) return () => {};
  const emitter = new NativeEventEmitter(native);
  const subscription = emitter.addListener('ProactiveMessage:onOpenRole', callback);
  return () => subscription.remove();
}

// 冷启动时（App 被杀后点通知进入）取一次 roleId
export async function consumeInitialRole() {
  if (!native) return null;
  return native.consumeInitialRole();
}
