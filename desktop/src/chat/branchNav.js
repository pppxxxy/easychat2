// 桌面聊天页的分支导航映射（纯函数，Node 直测）。
//
// 版式与 Android MessageList 同口径：版本切换器挂在「分叉点之后的第一条消息」上——
// 被重新生成的那条助手回复才是「当前版本」。分叉点 = 它的前一条消息。
// 这里只算哪些消息该显示 `< N/M >`，以及前后版本各对应哪条归档分支；
// 真正的切换（读分支正文、归档当前尾段、替换活动时间线）在 useDesktopBranches 里。
import { buildForkVersions } from '../../../src/chat/branchTree.js';

// forkMap: Map<forkMessageId, descriptor[]>（共享 groupBranchesByFork 的产物）。
// 返回 Map<messageId, { index, total, prevId, nextId, branches }>。
// 用户消息不挂切换器（版本只在助手回复上切换，与 Android 一致）。
export function buildBranchNav(messages, forkMap) {
  const list = Array.isArray(messages) ? messages : [];
  const nav = new Map();
  if (!forkMap || typeof forkMap.get !== 'function') return nav;
  for (let index = 1; index < list.length; index += 1) {
    const message = list[index];
    if (!message || message.role === 'user') continue;
    const id = String(message.id || '');
    if (!id) continue;
    const prevId = String(list[index - 1] && list[index - 1].id || '');
    if (!prevId) continue;
    const branches = forkMap.get(prevId);
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const versions = buildForkVersions(branches, message.timestamp);
    if (!(versions.total > 1)) continue;
    nav.set(id, { ...versions, branches });
  }
  return nav;
}