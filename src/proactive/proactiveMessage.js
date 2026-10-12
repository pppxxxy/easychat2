// 定时主动消息（原生模块 ProactiveMessage）的 JS 封装。
// 原生实现由 plugins/withProactiveMessage.js 在 prebuild 时注入 android/ 工程。
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

import { normalizePendingMessages } from './proactiveInbox.js';
import { tActive } from '../i18n/index.js';
import { onCharacterDeleted } from '../storage/characterLifecycle.js';

const native = Platform.OS === 'android' ? NativeModules.ProactiveMessage : null;

function requireNative() {
  if (!native) {
    throw new Error(tActive('error.proactive.unsupported'));
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

// 取消某角色的全部时间槽。
// 注意这是**角色级**取消：原生 cancelRole 只按 roleId 过滤，所以它一并清掉同一角色下
// `executor: 'AGENT'` 的定时任务槽（两类槽共用 MessageStore）。角色删除的清理就靠这一处
// ——见文件末尾的 onCharacterDeleted 钩子。
export async function cancelRoleSchedules(roleId) {
  return requireNative().cancelRole(roleId);
}

// 角色删除时清掉它的原生定时槽（主动消息 + 定时 Agent 任务都在里面）。
//
// 为什么必须在这里做：JS 侧的作息/任务记录各有自己的 onCharacterDeleted 钩子（storage/schedule.js、
// storage/agentTasks.js），但**原生闹钟/Worker 是另一份存储**（Kotlin MessageStore）——只清 JS
// 会留下一个「到点仍被系统唤起、但 JS 侧已经没有这个角色」的僵尸定时器：白耗电，且有机会
// 按已删角色的旧快照发消息。此前 cancelRoleSchedules 没有任何调用方，就是漏在这里。
//
// 分层：钩子注册在**领域模块**里（本文件），方向是 proactive → storage/characterLifecycle，
// 与既有 9 个钩子同款；反过来让 storage 去 import agent/proactive 会成环（guard 会拦）。
onCharacterDeleted('proactiveNativeSchedules', async characterIds => {
  if (!native || typeof native.cancelRole !== 'function') return;
  const ids = Array.isArray(characterIds) ? characterIds : [];
  for (const id of ids) {
    const roleId = String(id || '').trim();
    if (!roleId) continue;
    // 单个失败不打断其余角色：清理是尽力而为，不能因为一个原生异常漏掉其它角色。
    // 用 Promise.resolve 包一层，是为了兼容「原生同步返回布尔」的旧实现——直接 .catch 会抛
    // TypeError，而 runCharacterCleanup 只把它记成诊断，等于整轮清理静默失效。
    try {
      await Promise.resolve(native.cancelRole(roleId)).catch(() => {});
    } catch (error) {
      // 同步抛也吃掉：理由同上，交给 runCharacterCleanup 的「尽力而为」语义。
    }
  }
});

// apiKey 来自用户自己在设置页填写的值（仍走原生加密存储；本函数不落明文日志）。
// protocol/authHeader/authScheme/extraHeadersJson 由 JS 按所选协议计算（见 proactiveRequest.js）。
export async function setProactiveApiSettings({
  endpoint,
  model,
  apiKey,
  protocol = 'openai',
  authHeader = 'Authorization',
  authScheme = 'Bearer ',
  extraHeadersJson = '{}',
}) {
  return requireNative().setApiSettings({
    endpoint,
    model,
    apiKey,
    protocol,
    authHeader,
    authScheme,
    extraHeadersJson,
  });
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
    return normalizePendingMessages(await native.consumePendingMessages());
  } catch (error) {
    return [];
  }
}

// 已成功落库的消息按 id 从待写队列移除（原生侧持久化，App 重启前不丢）。
// 传 JSON 字符串而非数组：数组跨 Interop 编组不可靠（见上方注释）。
export async function ackPendingMessages(ids) {
  if (!native || typeof native.ackPendingMessages !== 'function') return false;
  const list = (Array.isArray(ids) ? ids : []).map(item => String(item || '')).filter(Boolean);
  if (list.length === 0) return true;
  try {
    return await native.ackPendingMessages(JSON.stringify(list));
  } catch (error) {
    return false;
  }
}
