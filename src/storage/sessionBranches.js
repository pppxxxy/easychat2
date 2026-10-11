// 对话分支存储：把撤回时被丢弃的消息尾段按分支独立分键保存，支持回溯切换。
// 活动时间线仍是 @easychat2_messages::<sessionId> 的扁平数组，本模块只管「分支」。
// 键结构：
//   @easychat2_branch_index::<sessionId>          轻量索引（提交点，最后写入）
//   @easychat2_branch_item::<sessionId>::<id>     单条分支正文
// 读写形状与其它存储域一致：读取返回 { status }，损坏先备份原始值再说。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { buildBranchDescriptor, createBranchId } from '../chat/branchTree.js';
import { backupCorruptValue, readJsonStatus } from './io.js';
import { markMediaWrite } from './mediaProtection.js';
import {
  enqueueSessionMutation,
  sessionBranchIndexKey,
  sessionBranchItemKey,
  sessionBranchItemPrefix,
} from './sessionCore.js';
import { imageUrisFromMessages, voiceUrisFromMessages } from './sessionFiles.js';

function normalizeDescriptor(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = String(source.id || '');
  if (!id) return null;
  return {
    id,
    forkMessageId: String(source.forkMessageId || ''),
    createdAt: Number(source.createdAt) || 0,
    messageCount: Number(source.messageCount) || 0,
    preview: String(source.preview || ''),
  };
}

async function readBranchIndex(sessionId) {
  const key = sessionBranchIndexKey(sessionId);
  const stored = await readJsonStatus(key);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return { status: 'corrupt', branches: [] };
  }
  const branches = (Array.isArray(stored.value) ? stored.value : [])
    .map(item => normalizeDescriptor(item))
    .filter(Boolean);
  return {
    status: stored.status === 'missing' ? 'missing' : 'ok',
    branches,
  };
}

export async function getBranchIndexStatus(sessionId) {
  return readBranchIndex(sessionId);
}

export async function getBranchIndex(sessionId) {
  const { branches } = await getBranchIndexStatus(sessionId);
  return branches;
}

// 读取单条分支正文。索引里存在但正文读不出（缺失/损坏/非数组）视为 corrupt，
// 调用方据此提示且不清除索引（避免把“暂时读不出”当成“没有分支”）。
export async function getBranch(sessionId, branchId) {
  const id = String(branchId || '');
  if (!id) return { status: 'missing', branch: null };
  const stored = await readJsonStatus(sessionBranchItemKey(sessionId, id));
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(sessionBranchItemKey(sessionId, id));
    return { status: 'corrupt', branch: null };
  }
  if (stored.status === 'missing') return { status: 'missing', branch: null };
  const messages = stored.value.filter(item => item && !item.pending);
  return { status: 'ok', branch: { id, messages } };
}

function collectBranchMedia(messages) {
  [...imageUrisFromMessages(messages), ...voiceUrisFromMessages(messages)].forEach(markMediaWrite);
}

// 归档一段分支：先写条目（正文）、后写索引（提交点）。
// 分支条目本身携带会话级 branchId 到每条消息上，便于活动时间线切换回来后复用。
async function archiveBranchInternal(sessionId, forkMessageId, messages) {
  const sid = String(sessionId || '');
  const list = Array.isArray(messages) ? messages.filter(item => item && !item.pending) : [];
  if (!sid || list.length === 0) return null;
  const status = await readBranchIndex(sid);
  if (status.status === 'corrupt') return null;
  const branchId = createBranchId(Date.now(), Math.random, status.branches.map(item => item.id));
  const stamped = list.map(item => ({
    ...item,
    branchId,
    forkMessageId: String(forkMessageId || ''),
  }));
  collectBranchMedia(stamped);
  const descriptor = buildBranchDescriptor(branchId, forkMessageId, stamped);
  try {
    await AsyncStorage.setItem(sessionBranchItemKey(sid, branchId), JSON.stringify(stamped));
    const next = [...status.branches, descriptor];
    await AsyncStorage.setItem(sessionBranchIndexKey(sid), JSON.stringify(next));
    return descriptor;
  } catch (error) {
    // 索引未写成即视为未归档：条目成为无主键，下次会话删除/回收会一并清理。
    return null;
  }
}

export function archiveBranch(sessionId, forkMessageId, messages) {
  return enqueueSessionMutation(() => archiveBranchInternal(sessionId, forkMessageId, messages));
}

// 删除分支的**提交点**：先写索引、后删条目。
//
// 与归档方向相反是**刻意的**（两边都以「索引是事实源」为准，但提交点必然相反）：
// - 归档 = 条目 → 索引：索引最后写。写索引失败 = 这次归档不存在，孤儿条目由前缀扫描兜底；
// - 删除 = 索引 → 条目：索引先写。写索引失败 = 这次删除没发生（条目还在、索引还指着它，
//   不会出现「索引指着一条已删条目」的悬空引用）；条目删不掉只是残留，由前缀扫描兜底。
// 单条删除与清理过期分支共用本函数——两条删除路径各写一份提交顺序，迟早会写反。
async function commitBranchRemoval(sessionId, keptBranches, removedIds) {
  const sid = String(sessionId || '');
  const ids = (Array.isArray(removedIds) ? removedIds : []).map(id => String(id || '')).filter(Boolean);
  await AsyncStorage.setItem(sessionBranchIndexKey(sid), JSON.stringify(keptBranches));
  if (ids.length === 0) return;
  try {
    await AsyncStorage.multiRemove(ids.map(id => sessionBranchItemKey(sid, id)));
  } catch (error) {
    // 索引已是事实源：条目删不掉只是残留（会话删除/回收按前缀扫掉），
    // 不能因此回滚索引——回滚会把用户刚删掉的分支重新暴露出来。
  }
}

// 删除单条分支：索引是事实源，条目残留由清理兜底。
async function deleteBranchInternal(sessionId, branchId) {
  const sid = String(sessionId || '');
  const id = String(branchId || '');
  if (!sid || !id) return false;
  const status = await readBranchIndex(sid);
  if (status.status === 'corrupt') return false;
  const next = status.branches.filter(item => String(item.id) !== id);
  await commitBranchRemoval(sid, next, [id]);
  return true;
}

export function deleteBranch(sessionId, branchId) {
  return enqueueSessionMutation(() => deleteBranchInternal(sessionId, branchId));
}

// 清理「分叉点已不在活动时间线上」的分支：会话被大幅删除后，旧分支无从恢复。
// activeMessageIds 为当前活动时间线上的消息 id 集合；forkMessageId='' 始终保留。
async function pruneStaleBranchesInternal(sessionId, activeMessageIds) {
  const sid = String(sessionId || '');
  const active = activeMessageIds instanceof Set
    ? activeMessageIds
    : new Set((Array.isArray(activeMessageIds) ? activeMessageIds : []).map(String));
  const status = await readBranchIndex(sid);
  if (status.status !== 'ok') return { removed: [] };
  const removed = [];
  const kept = [];
  for (const branch of status.branches) {
    const fork = String(branch.forkMessageId || '');
    if (fork && !active.has(fork)) {
      removed.push(branch.id);
      continue;
    }
    kept.push(branch);
  }
  if (removed.length > 0) {
    await commitBranchRemoval(sid, kept, removed);
  }
  return { removed };
}

export function pruneStaleBranches(sessionId, activeMessageIds) {
  return enqueueSessionMutation(() => pruneStaleBranchesInternal(sessionId, activeMessageIds));
}

// 会话语义的整体清理：删除索引与该会话全部条目键。供会话删除调用。
// 注意必须放在调用方已有的 mutation 队列内使用 `deleteAllBranchesInternal`，
// 或直接调用本包装（内部会再次入队，嵌套 enqueue 会自我等待，故对外导出内部版）。
export async function deleteAllBranchesInternal(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return;
  const prefix = sessionBranchItemPrefix(sid);
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    keys = [];
  }
  const itemKeys = (Array.isArray(keys) ? keys : []).filter(key => (
    typeof key === 'string' && key.startsWith(prefix)
  ));
  try {
    await AsyncStorage.multiRemove([sessionBranchIndexKey(sid), ...itemKeys]);
  } catch (error) {}
}

export function deleteAllBranches(sessionId) {
  return enqueueSessionMutation(() => deleteAllBranchesInternal(sessionId));
}
