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

// 权限状态：{ notification, exactAlarm, battery, autostart }。
// 能判定的返回 boolean；无法判定（自启动白名单无公开 API）为 null（JS 侧显示问号）。
// 原生未就绪或旧版本无此方法时返回全 null，交由界面显示未知。
export async function getPermissionStatus() {
  if (!native || typeof native.getPermissionStatus !== 'function') {
    return { notification: null, exactAlarm: null, battery: null, autostart: null };
  }
  try {
    const raw = await native.getPermissionStatus();
    const pick = key => (typeof raw[key] === 'boolean' ? raw[key] : null);
    return {
      notification: pick('notification'),
      exactAlarm: pick('exactAlarm'),
      battery: pick('battery'),
      autostart: pick('autostart'),
    };
  } catch (error) {
    return { notification: null, exactAlarm: null, battery: null, autostart: null };
  }
}

// config: { slotId, roleId, roleName, persona, hour, minute, mode: 'WORK'|'EXACT', enabled, revision }
// 返回原生确认的 slotId；同一角色可排多个时间槽。
export async function scheduleDailyMessage(config) {
  return requireNative().schedule(config);
}

// 取消单个时间槽
export async function cancelDailySchedule(slotId) {
  return requireNative().cancel(slotId);
}

// 取消某角色的全部时间槽
export async function cancelRoleSchedules(roleId) {
  return requireNative().cancelRole(roleId);
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

export async function openAutostartSettings() {
  return requireNative().openAutostartSettings();
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

// 取出待写队列（原生生成但尚未写入会话的主动消息）。不清空，落库后需 ackPendingMessages。
export async function consumePendingMessages() {
  if (!native || typeof native.consumePendingMessages !== 'function') return [];
  try {
    const list = await native.consumePendingMessages();
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

// 已成功落库的消息按 id 从待写队列移除（原生侧持久化，App 重启前不丢）。
export async function ackPendingMessages(ids) {
  if (!native || typeof native.ackPendingMessages !== 'function') return false;
  const list = (Array.isArray(ids) ? ids : []).map(item => String(item || '')).filter(Boolean);
  if (list.length === 0) return true;
  try {
    return await native.ackPendingMessages(list);
  } catch (error) {
    return false;
  }
}
