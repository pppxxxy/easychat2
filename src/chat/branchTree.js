// 对话树 / 分支回溯的纯逻辑：把「撤回时丢弃的尾段」变成可归档、可切换的分支。
// 不依赖任何 RN / 存储，可在 Node 直测。活动时间线仍是扁平消息数组，
// 被归档的尾段由存储层按分支独立分键保存（见 src/storage/sessionBranches.js）。

import { buildPreview } from '../context/sessionLibrary.js';

// 会话内唯一分支 id。random 可注入，便于测试与去重断言。
export function createBranchId(now = Date.now(), random = Math.random) {
  const suffix = Math.floor(random() * 0x1000000).toString(36);
  return `branch-${now}-${suffix}`;
}

// 从活动消息数组切出「分叉点之后」的尾段：forkIndex 是尾段起点。
// 返回 { kept, tail, forkMessageId }；尾段为空返回 null（不建空分支）。
// forkMessageId 是保留段的最后一条消息 id（'' 表示从会话最前分叉）。
export function branchFromTail(messages, forkIndex) {
  const list = Array.isArray(messages) ? messages : [];
  const start = Math.max(0, Math.min(list.length, Math.floor(Number(forkIndex)) || 0));
  const kept = list.slice(0, start);
  const tail = list.slice(start);
  if (tail.length === 0) return null;
  return {
    kept,
    tail,
    forkMessageId: kept.length ? String(kept[kept.length - 1] && kept[kept.length - 1].id || '') : '',
  };
}

// 生成分支索引描述符：不含消息正文，只有定位与预览所需的轻量字段。
export function buildBranchDescriptor(id, forkMessageId, messages, now = Date.now()) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    id: String(id || ''),
    forkMessageId: String(forkMessageId || ''),
    createdAt: Number(now) || Date.now(),
    messageCount: list.length,
    preview: buildPreview(list),
  };
}

// 切换计划：把活动时间线替换为「分叉点及其之前 + 目标分支尾段」。
// branch = { id, forkMessageId, messages }。返回：
// - stale:true —— 分叉点在当前活动数组里已不存在（会话被大幅删除），调用方应清理该分支；
// - 否则 prefix（保留段）、activated（分支尾段）、removedTail（被替换掉的当前尾段）、forkMessageId。
export function planCheckout(activeMessages, branch) {
  const active = Array.isArray(activeMessages) ? activeMessages : [];
  const source = branch && typeof branch === 'object' ? branch : {};
  const forkMessageId = String(source.forkMessageId || '');
  const activated = Array.isArray(source.messages) ? source.messages : [];
  let prefix;
  if (!forkMessageId) {
    prefix = [];
  } else {
    const index = active.findIndex(item => item && String(item.id || '') === forkMessageId);
    if (index < 0) return { stale: true };
    prefix = active.slice(0, index + 1);
  }
  const removedTail = active.slice(prefix.length);
  return {
    stale: false,
    prefix,
    activated,
    removedTail,
    forkMessageId,
  };
}

// 按分叉点分组：Map<forkMessageId, descriptor[]>。供列表在对应消息后渲染入口、
// 以及入口上的「N 条分支」计数。'' 键表示从会话最前分叉。
export function groupBranchesByFork(branches) {
  const map = new Map();
  (Array.isArray(branches) ? branches : []).forEach(branch => {
    if (!branch) return;
    const key = String(branch.forkMessageId || '');
    const list = map.get(key) || [];
    list.push(branch);
    map.set(key, list);
  });
  return map;
}

// 判断某段尾段是否与既有分支消息序列内容一致：用于来回切换时避免产生重复分支。
// 只比较能代表内容的稳定字段（id / role / text / timestamp），忽略瞬时展示字段。
function messageFingerprint(message) {
  return JSON.stringify([
    String(message && message.id || ''),
    String(message && message.role || ''),
    String(message && message.text || ''),
    Number(message && message.timestamp) || 0,
  ]);
}

export function sameMessageSequence(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (messageFingerprint(left[index]) !== messageFingerprint(right[index])) return false;
  }
  return true;
}

// 从既有分支描述符 + 待归档尾段中，找出内容完全一致的分支，避免重复归档。
// candidates 为 [{ descriptor, messages }]。
export function findDuplicateBranch(candidates, tail) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list) {
    if (!candidate || !candidate.descriptor) continue;
    if (sameMessageSequence(candidate.messages, tail)) return candidate.descriptor;
  }
  return null;
}
