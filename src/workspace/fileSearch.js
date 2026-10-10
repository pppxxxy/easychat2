// 工作区文件搜索（纯函数，Node 可直测）。
//
// 背景：文件面板只能逐层下钻（`directoryChildren`），**没有搜索**——工作区文件一多，
// 找一个已知名字的文件只能靠记忆一层层点。全仓唯一的搜索框在 GitHub 面板。
//
// 输入形状：`files` 是**路径字符串数组**（store 的约定，目录以 `/` 结尾），
// 与 `buildTree.js` 的 `directoryChildren` 同源。
//
// 两个有意的取舍：
//   1) **只搜文件，不搜目录**——在文件面板里搜「readme」的人要的是文件；目录本来就能
//      逐层点进去，混进结果里只是噪声。命中结果里会带出所在目录，所以想找目录也能看出来。
//   2) **不返回空查询的结果**——空查询时界面该显示原来的树，而不是「全部文件」的平铺。

// 命中排序：文件名命中 > 仅路径命中；同为文件名命中时路径越短（越浅）越靠前；最后字典序。
// 这样搜 `chat` 时 `src/chat.js` 会排在 `repos/x/y/src/chat/deep/thing.js` 前面。
export function searchWorkspaceFiles(files, query, { limit = 50 } = {}) {
  const list = Array.isArray(files) ? files : [];
  const needle = String(query == null ? '' : query).trim().toLowerCase();
  if (!needle) return { matches: [], total: 0, truncated: false };

  const hits = [];
  for (const entry of list) {
    const path = String(entry || '');
    if (!path || path.endsWith('/')) continue;
    if (!path.toLowerCase().includes(needle)) continue;
    const slash = path.lastIndexOf('/');
    const name = slash === -1 ? path : path.slice(slash + 1);
    const dir = slash === -1 ? '' : path.slice(0, slash + 1);
    hits.push({ path, name, dir, rank: name.toLowerCase().includes(needle) ? 0 : 1 });
  }

  hits.sort((a, b) => (a.rank - b.rank)
    || (a.path.length - b.path.length)
    || a.path.localeCompare(b.path));

  // 注意别写成 `Number(limit) || 50`：`limit: 0` 会因此变成 50（0 是 falsy）。
  const parsed = Number(limit);
  const safeLimit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
  return {
    matches: hits.slice(0, safeLimit).map(({ path, name, dir }) => ({ path, name, dir })),
    total: hits.length,
    truncated: hits.length > safeLimit,
  };
}
