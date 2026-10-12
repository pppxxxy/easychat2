// 定时 Agent 任务的原生桥。
//
// 复用既有的原生模块 ProactiveMessage（plugins/withProactiveMessage.js 注入），
// 但用 `executor: 'AGENT'` 标记：到点时原生不再自己调模型，而是启动一个无界面
// （Headless JS）服务，把 slotId 交回 JS，由 taskRunner 跑工具循环。
//
// 这里只做薄封装 + 平台守卫；原生缺席（iOS / 旧构建）时返回 null/空，不抛。

import { NativeModules, Platform } from 'react-native';

const native = Platform.OS === 'android' ? NativeModules.ProactiveMessage : null;

export function isAgentTaskNativeAvailable() {
  return !!native && typeof native.schedule === 'function';
}

// task: { taskId, roleId, roleName, persona, hour, minute, mode, enabled, revision, avatarUri }
// 原生据此排定每日闹钟/Worker；executor 固定 AGENT。
export function scheduleAgentTask(task) {
  if (!isAgentTaskNativeAvailable()) return Promise.resolve(null);
  const source = task && typeof task === 'object' ? task : {};
  return native.schedule({
    roleId: String(source.roleId || ''),
    roleName: String(source.roleName || ''),
    persona: String(source.persona || ''),
    hour: Number(source.hour) || 0,
    minute: Number(source.minute) || 0,
    mode: source.mode === 'EXACT' ? 'EXACT' : 'WORK',
    enabled: source.enabled !== false,
    slotId: String(source.taskId || ''),
    revision: String(source.revision || ''),
    executor: 'AGENT',
    avatarUri: String(source.avatarUri || ''),
  });
}

export function cancelAgentTask(taskId) {
  if (!isAgentTaskNativeAvailable()) return Promise.resolve(false);
  return native.cancel(String(taskId || ''));
}

// 这里**故意没有** cancelAgentTasksForRole：原生 cancelRole 只按 roleId 过滤，与执行器类型无关，
// 所以它和主动消息的「取消角色全部时间槽」是同一个调用。那份实现由 proactive/proactiveMessage.js
// 的 onCharacterDeleted 钩子在角色删除时统一调用（一次清掉主动消息槽与本文件的 AGENT 槽）。
// 两处各写一遍只会让人误以为它们清的是不同的东西。

// 执行完成后展示通知（复用主动消息的通知渠道与头像）。原生缺席时静默。
export function notifyAgentTaskResult(taskId, text) {
  if (!native || typeof native.notifyAgentTaskResult !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(native.notifyAgentTaskResult(String(taskId || ''), String(text || '')));
  } catch (error) {
    return Promise.resolve(false);
  }
}
