// H3：推送前基线 + 一键回滚（吸收 JGit 调研的「回滚/diff 增量」内核，本地轻量实现）。
//
// 语义：每次推送**成功前**把本次 modified/removed 的**远程旧内容**（repoPush 的
// collectRollbackEntries 拉回）存成一份快照；「回滚」= 把本地文件写回旧内容
//（modified）或恢复被删文件（removed），再走一次推送即反向同步——全程离线可用、
// 复用既有推送确认门，不用 API 反向建提交。
//
// 存哪：`.easychat/rollback/<ts>.json`（与 sessions/manifest 同域）；**保留最近 3 份**
//（超出丢最旧——每份都可能几 MB，不能无限留）。
//
// 诚实边界：超出 repoPush 三重限额（文件数/单文件/总量）的条目 content 为 null，
// 快照如实记 reason——回滚入口对这些条目明确「不可自动恢复」，绝不假装能回。

export const ROLLBACK_DIR = '.easychat/rollback';
export const ROLLBACK_KEEP = 3;

export function rollbackSnapshotPath(ts) {
  const at = Number.isFinite(Number(ts)) && Number(ts) > 0 ? Math.floor(Number(ts)) : Date.now();
  return `${ROLLBACK_DIR}/${at}.json`;
}

// 纯函数：构造快照 payload（自包含 owner/repo/branch——恢复时据此重建前缀）。
export function buildRollbackPayload({ owner, repo, branch, commit, rollback, at = 0 } = {}) {
  const list = Array.isArray(rollback && rollback.entries) ? rollback.entries : [];
  const entries = list
    .filter(item => item && item.path)
    .map(item => ({
      path: String(item.path),
      sha: String(item.sha || ''),
      content: item.content === null || item.content === undefined ? null : String(item.content),
      ...(item.reason ? { reason: String(item.reason) } : {}),
    }));
  return {
    owner: String(owner || ''),
    repo: String(repo || ''),
    branch: String(branch || ''),
    commit: String(commit || ''),
    at: Number.isFinite(Number(at)) && Number(at) > 0 ? Math.floor(Number(at)) : Date.now(),
    ...(Number.isFinite(Number(rollback && rollback.skippedCount)) && Number(rollback.skippedCount) > 0
      ? { skippedCount: Number(rollback.skippedCount) }
      : {}),
    entries,
  };
}

// 纯函数：JSON 文本 → payload（坏输入 → null，当作没有）。
export function parseRollbackSnapshot(text) {
  try {
    const source = typeof text === 'string' ? JSON.parse(text) : text;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    if (!Array.isArray(source.entries)) return null;
    return source;
  } catch (error) {
    return null;
  }
}

// 纯函数：从 listWorkspaceFiles 输出里挑快照（`.easychat/rollback/<ts>.json`），
// 按时间戳降序（最新在前）。
export function pickRollbackSnapshots(entries) {
  const prefix = `${ROLLBACK_DIR}/`;
  const found = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = String(entry || '');
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const match = path.slice(prefix.length).match(/^(\d+)\.json$/);
    if (!match) continue;
    found.push({ path, ts: Number(match[1]) || 0 });
  }
  return found.sort((a, b) => b.ts - a.ts);
}

// 纯函数：轮换——保留最近 keep 份，返回要删除的路径列表。
export function rollbackRotationDeletes(snapshots, keep = ROLLBACK_KEEP) {
  return (Array.isArray(snapshots) ? snapshots : []).slice(Math.max(1, Math.floor(Number(keep)) || ROLLBACK_KEEP))
    .map(item => item.path);
}

// 纯函数：可恢复性分组（content 非 null 才可自动恢复）。
export function rollbackRestorableEntries(payload) {
  const list = Array.isArray(payload && payload.entries) ? payload.entries : [];
  const restorable = list.filter(item => item && item.path && typeof item.content === 'string');
  const unrestorable = list.filter(item => item && item.path && typeof item.content !== 'string');
  return { restorable, unrestorable };
}

// IO：列出快照（只读元信息，不读内容）。
export async function listRollbackSnapshots(store, characterId) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return [];
  try {
    const entries = await store.listWorkspaceFiles({ characterId, subdir: ROLLBACK_DIR });
    return pickRollbackSnapshots(entries);
  } catch (error) {
    return [];
  }
}

// IO：读最新一份快照（没有/坏文件 → null）。
export async function readLatestRollbackSnapshot(store, characterId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return null;
  const snapshots = await listRollbackSnapshots(store, characterId);
  if (snapshots.length === 0) return null;
  try {
    const result = await store.readWorkspaceFile({ characterId, path: snapshots[0].path });
    const payload = parseRollbackSnapshot(result && result.content);
    return payload ? { ...payload, path: snapshots[0].path } : null;
  } catch (error) {
    return null;
  }
}

// IO：写快照 + 轮换（保留最近 3 份）。返回写入路径或 null（写失败静默——旁路机制）。
export async function writeRollbackSnapshot(store, characterId, payload) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return null;
  try {
    const path = rollbackSnapshotPath(payload && payload.at);
    await store.writeWorkspaceFile({ characterId, path, content: JSON.stringify(payload) });
    // 轮换：写成功后删最旧的（删除失败无害——下次再删）。
    const snapshots = await listRollbackSnapshots(store, characterId);
    for (const stale of rollbackRotationDeletes(snapshots)) {
      try {
        await store.deleteFile({ characterId, path: stale });
      } catch (error) {}
    }
    return path;
  } catch (error) {
    return null;
  }
}

// IO：应用回滚——可恢复条目写回本地（断点续行：单条失败不影响其余，如实记账）。
// localPrefix：`repos/<owner>/<repo>/<branch>/`（快照的 path 是相对路径）。
export async function applyRollbackSnapshot({ store, characterId, payload, localPrefix } = {}) {
  const { restorable, unrestorable } = rollbackRestorableEntries(payload);
  const prefix = String(localPrefix || '');
  const restored = [];
  const failed = [];
  if (!store || typeof store.writeWorkspaceFile !== 'function') {
    return { restored, failed: restorable.map(item => item.path), unrestorable: unrestorable.map(item => item.path) };
  }
  for (const item of restorable) {
    try {
      await store.writeWorkspaceFile({
        characterId,
        path: `${prefix}${item.path}`,
        content: item.content,
      });
      restored.push(item.path);
    } catch (error) {
      failed.push(item.path);
    }
  }
  return { restored, failed, unrestorable: unrestorable.map(item => item.path) };
}
