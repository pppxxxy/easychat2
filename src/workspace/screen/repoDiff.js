// 本地副本 vs 最近一次拉取/推送的「清单快照」：算出待同步的新增与删除（纯函数，Node 直测）。
//
// 口径说明（如实标注，不假装能自动 diff 内容）：快照只记**路径**——listWorkspaceFiles
// 只返回路径，逐个读文件算哈希在大仓库上是几百次读盘。因此这里能判定「本地新增 /
// 本地删除」，判定不了「内容改动」；后者由助手用 GitHub 工具逐文件比对（交接指令里写清）。

// 当前本地副本里属于该仓库前缀的文件（相对路径），供写入快照与 diff 共用。
export function localRepoPaths({ files, prefix } = {}) {
  const base = String(prefix || '');
  return (Array.isArray(files) ? files : [])
    .map(item => String(item || ''))
    .filter(path => path && !path.endsWith('/') && path.startsWith(base))
    .map(path => path.slice(base.length))
    .sort();
}

export function diffRepoSnapshot({ files, prefix, snapshotPaths } = {}) {
  const local = localRepoPaths({ files, prefix });
  const localSet = new Set(local);
  const snapshotSet = new Set(
    (Array.isArray(snapshotPaths) ? snapshotPaths : []).map(item => String(item || '')).filter(Boolean)
  );
  const added = local.filter(path => !snapshotSet.has(path));
  const removed = [...snapshotSet].filter(path => !localSet.has(path)).sort();
  return { added, removed, total: local.length, pending: added.length + removed.length };
}
