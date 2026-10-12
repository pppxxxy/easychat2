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

// —— R1 残缺态裁决（纯函数，Node 直测）——
//
// 背景：B3 覆盖守卫拿「当前本地 vs 上次成功基线」的路径 diff 判定「未推送改动」，
// 但一次**中断的拉取**（manifest 残留 = F4 信号）会让同一份 diff 把缺口（removed）
// 和残骸（added）误报成用户的工作——「425 处未推送的增删」全部来自残缺，没有一处
// 是用户改的。守卫必须先查 manifest 残留，再谈覆盖确认。
//
// 输入：manifest = readPullManifest 结果（null/坏对象 = 无残留）；
// diff = diffRepoSnapshot 返回；hasLocal = 本地副本该前缀下是否非空。
// 输出裁决序（R1-1）：
//   'dirtyPull'  —— 上次拉取中断（本地处于不完整状态）：跳过 B3 覆盖守卫，
//                   改弹说明性的「重新拉取将修复缺失文件」确认；
//   'overwrite'  —— 无残留且有未推送增删：走 B3 守卫，suspect=true 表示
//                   「缺失多于新增」——残缺嫌疑（上次可能没拉完整），文案附提示；
//   'clean'      —— 无增删或本地为空（首次拉取）：直接放行。
export function classifyPullGuard({ manifest, diff, hasLocal } = {}) {
  const added = diff && Array.isArray(diff.added) ? diff.added.length : 0;
  const removed = diff && Array.isArray(diff.removed) ? diff.removed.length : 0;
  const pending = Number(diff && diff.pending) || 0;
  const manifestOk = manifest && typeof manifest === 'object' && !Array.isArray(manifest);
  if (manifestOk) {
    return {
      kind: 'dirtyPull',
      added,
      removed,
      missing: removed,
      target: Math.max(0, Math.floor(Number(manifest.files) || 0)),
      suspect: false,
    };
  }
  if (!hasLocal || pending <= 0) {
    return { kind: 'clean', added, removed, missing: removed, target: 0, suspect: false };
  }
  return { kind: 'overwrite', added, removed, missing: removed, target: 0, suspect: removed > added };
}

// 残缺态判定（推送面板防误删）：**硬信号 = manifest 残留**（上次拉取中断，本地是
// 不完整中间态——removed 是缺口，推上去就是删远端文件）。此态必须阻断推送。
export function isDirtyPullState({ manifest } = {}) {
  return Boolean(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
}

// 软信号（只提示、不阻断）：缺失远多于新增——上次可能拉取不完整但 manifest 已被
// 清掉的窗口。不拿来阻断是因为「用户真的删了 20 个文件再推送」是合法操作，阻断会
// 死锁（重新拉取会把删掉的文件拉回来）。批量推送确认门另有「异常放大二次确认」兜底。
export function hasMissingGaps({ diff, suspectMinRemoved = 10 } = {}) {
  const added = diff && Array.isArray(diff.added) ? diff.added.length : 0;
  const removed = diff && Array.isArray(diff.removed) ? diff.removed.length : 0;
  return removed >= suspectMinRemoved && removed > added;
}

// 文案拼装（纯函数）：按裁决产出弹窗正文需要的 i18n 键与参数，供 Node 直测。
// 语言包只负责句式，这里负责「报告哪些数字」——B3 的旧文案只报一个合并数
// （added+removed），残缺态下就是误导的源头。
export function pullGuardCopy({ decision } = {}) {
  const kind = decision && decision.kind;
  if (kind === 'dirtyPull') {
    return { key: 'workspace.github.pull.dirtyBody', params: { missing: decision.missing, target: decision.target } };
  }
  if (kind === 'overwrite') {
    return decision.suspect
      ? { key: 'workspace.github.pull.overwriteBodySuspect', params: { added: decision.added, removed: decision.removed } }
      : { key: 'workspace.github.pull.overwriteBodySplit', params: { added: decision.added, removed: decision.removed } };
  }
  return { key: '', params: {} };
}
