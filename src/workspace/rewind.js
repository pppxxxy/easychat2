// 工作区回退（Z 系采纳 #7）：把「对话回退到某分支」与「工作区文件回退到同一时刻」联动。
//
// 现状：对话分支（branchTree）与文件写前快照（fileHistory）各自独立——回退对话**不会**
// 回退文件，于是「时间线回到三小时前、工作区却还是现在」这种不一致会误导后续推理。
//
// 语义（按 fileHistory 的 at = 「那次写入发生的时刻，快照的是写前内容」）：
//   某文件在分叉时刻 T 的状态 = **T 之后最早那次写入**的快照内容；
//   若 T 之后没有写过，则该文件本来就还是 T 时的样子，不用动。
// 所以回退 = 对每个「T 之后被写过」的路径，恢复它 T 后最早那条快照。
//
// 纯函数 planWorkspaceRewind 可 Node 直测；IO 部分只做读写。

import { readFileHistoryIndex, restoreFileHistory } from './fileHistory.js';

// 纯函数：给定 file-history 索引与分叉时刻，算出需要恢复哪些条目。
export function planWorkspaceRewind(index, targetAt) {
  const t = Number(targetAt);
  if (!Number.isFinite(t) || t <= 0) return { restores: [] };
  const byPath = new Map();
  for (const entry of (Array.isArray(index) ? index : [])) {
    if (!entry || !entry.path) continue;
    const at = Number(entry.at) || 0;
    if (at <= t) continue; // 分叉点之前（含）的写入：不影响分叉时的状态
    const prev = byPath.get(entry.path);
    if (!prev || at < prev.at) byPath.set(entry.path, entry); // 分叉后**最早**的一次写
  }
  return {
    restores: [...byPath.values()]
      .map(entry => ({
        path: entry.path,
        entryId: entry.id,
        at: entry.at,
        restorable: entry.restorable !== false,
      }))
      .sort((a, b) => a.at - b.at),
  };
}

// IO：只规划不落盘（确认弹框要先知道会影响几个文件）。
export async function planWorkspaceRewindForStore({ store, characterId, targetAt } = {}) {
  const index = await readFileHistoryIndex(store, characterId);
  return planWorkspaceRewind(index, targetAt);
}

// IO：把工作区文件回退到 targetAt 时刻。返回 { total, restored, skipped }。
// 只读一次索引；逐条恢复（restoreFileHistory 内部会先快照当前，天然可逆）。
export async function rewindWorkspaceFiles({ store, characterId, targetAt } = {}) {
  const { restores } = await planWorkspaceRewindForStore({ store, characterId, targetAt });
  const restored = [];
  const skipped = [];
  for (const item of restores) {
    if (!item.restorable) {
      skipped.push({ path: item.path, reason: 'not-restorable' });
      continue;
    }
    const result = await restoreFileHistory(store, characterId, item.entryId, { currentContent: null });
    if (result && result.ok) restored.push(item.path);
    else skipped.push({ path: item.path, reason: (result && result.reason) || 'failed' });
  }
  return { total: restores.length, restored, skipped };
}
