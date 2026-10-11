// 一键回滚（差距 #5）：把「代码」与「对话」一起退回某一轮之前。
//
// 参考做法：Claude `/rewind`（同时回滚代码 + 对话）、ZCode 时光机（改历史指令并重推）。
// 本模块做**最小可行切面**：给定一条消息 id，对话截断到它之前；若本地版本控制开着，
// 再把该轮落下的 git 检查点撤销（恢复该轮改动过的文件）。
//
// 分工：
//   planRewind / rewindMessages —— 纯函数（对话侧，Node 直测）；
//   rewindCode                  —— 代码侧（走 git 句柄；runner 可注入以便测试）；
//   rewindSession               —— 组合两者，返回新的消息列表 + 代码回滚结果。
//
// 破坏性操作：调用方负责「先归档被丢弃的尾段」（可接对话分支 sessionBranches.js）。

import { buildCheckpointMessage } from './gitCheckpoint.js';

export const REWIND_DEPTH_DEFAULT = 50;

// 纯：规划一次回滚。messageId 指向「要退回的那条消息」（通常是发起该轮的用户消息）。
// 返回 { ok, index, keep, dropped, turnRequest, reason }。
export function planRewind(messages, { messageId } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const id = String(messageId == null ? '' : messageId);
  if (!id) return { ok: false, reason: 'no-id', index: -1, keep: list, dropped: [], turnRequest: '' };
  const index = list.findIndex(item => item && String(item.id) === id);
  if (index < 0) return { ok: false, reason: 'not-found', index: -1, keep: list, dropped: [], turnRequest: '' };
  const keep = list.slice(0, index);
  const dropped = list.slice(index);
  const firstUser = dropped.find(item => item && item.role === 'user');
  return { ok: true, index, keep, dropped, turnRequest: String((firstUser && firstUser.content) || '') };
}

// 纯：只取截断后的消息列表（不改动入参）。
export function rewindMessages(messages, { messageId } = {}) {
  return planRewind(messages, { messageId }).keep;
}

// 代码侧：撤销某轮检查点（按提交说明匹配），恢复该轮改动过的文件，并落一次「回滚」提交。
// 返回 { ok, restored?, paths?, reason? }（不抛；任何异常都转成 reason）。
export async function rewindCode({ git, characterId = 'default', request = '', depth = REWIND_DEPTH_DEFAULT } = {}) {
  if (!git || typeof git.open !== 'function') return { ok: false, reason: 'no-git' };
  try {
    const handle = git.open({ characterId });
    if (typeof handle.isRepo === 'function' && !(await handle.isRepo())) return { ok: false, reason: 'no-repo' };
    const commits = await handle.log({ depth });
    const target = buildCheckpointMessage(request);
    const index = commits.findIndex(item => String((item && item.message) || '').trim() === target);
    if (index < 0) return { ok: false, reason: 'no-checkpoint' };
    const parent = commits[index + 1];
    if (!parent) return { ok: false, reason: 'no-parent' };
    const changed = await handle.changedInCommit(commits[index].oid);
    const paths = changed.map(row => row && row.path).filter(Boolean);
    if (paths.length === 0) return { ok: false, reason: 'no-change' };
    const restored = await handle.restorePathsFrom(parent.oid, paths);
    await handle.commitAll(`回滚：${target}`);
    return { ok: true, restored, paths };
  } catch (error) {
    return { ok: false, reason: 'failed', error: String((error && error.message) || error) };
  }
}

// 组合：对话截断 + （可选）代码回滚。返回 { ok, messages, dropped, code, reason? }。
export async function rewindSession({ messages, messageId, git, characterId } = {}) {
  const plan = planRewind(messages, { messageId });
  if (!plan.ok) return { ok: false, reason: plan.reason, messages: plan.keep, dropped: [] };
  let code = null;
  if (git && plan.turnRequest) {
    code = await rewindCode({ git, characterId, request: plan.turnRequest });
  }
  return { ok: true, messages: plan.keep, dropped: plan.dropped, turnRequest: plan.turnRequest, code };
}
