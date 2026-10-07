// 工作区文件的「项目分组」与「目录树」纯函数（零依赖，Node 直测）。
//
// 背景（v2 §1.2 诉求④）：listWorkspaceFiles 返回的是**平铺**的相对路径数组，
// 旧面板一维渲染，于是 css/、js/、repos/easychat2/main/src/... 混居成一长条，
// 路径被截断成「repos/leiting-zhanji-h5/main/RE...」。分组 + 逐层下钻后，
// 文件按项目成卡、点进去只看当前层，长路径问题自然消失。
//
// 两种项目前缀（v1 §0 缺陷 4 的两套规范，读侧都兼容）：
//   repos/<owner>/<repo>/<branch>/…   面板侧导入（分支快照，v2 起为唯一写入规范）
//   projects/<owner>__<repo>/…        聊天侧导入（旧规范，只读兼容，不迁移文件）

export const REPOS_PREFIX = 'repos';
export const LEGACY_PROJECTS_PREFIX = 'projects';

function segments(path) {
  return String(path || '').split('/').filter(Boolean);
}

// 从相对路径解析出项目组。返回 { id, label, kind, prefix } 或 null（不属于任何项目）。
// id/prefix 用于 listWorkspaceFiles({ subdir }) 下钻；label 是展示名。
export function projectGroupOf(path) {
  const segs = segments(path);
  if (segs.length < 2) return null;
  if (segs[0] === REPOS_PREFIX) {
    // repos/<owner>/<repo>[/<branch>][/…]
    // 第 4 段是「分支目录」还是「仓库根下的文件」？store 的约定是目录条目带尾斜杠：
    // 只有第 5 段存在、或第 4 段本身带尾斜杠时，才把第 4 段当分支。
    if (segs.length < 3) return null;
    const owner = segs[1];
    const repo = segs[2];
    const hasBranch = segs.length > 4 || (segs.length === 4 && String(path).endsWith('/'));
    const branch = hasBranch ? segs[3] : '';
    const prefix = branch ? `${owner}/${repo}/${branch}/` : `${owner}/${repo}/`;
    return {
      id: `${REPOS_PREFIX}/${prefix.replace(/\/$/, '')}`,
      label: branch ? `${owner}/${repo} · ${branch}` : `${owner}/${repo}`,
      kind: 'repo',
      prefix: `${REPOS_PREFIX}/${prefix}`,
    };
  }
  if (segs[0] === LEGACY_PROJECTS_PREFIX) {
    if (segs.length < 2) return null;
    const name = segs[1];
    return {
      id: `${LEGACY_PROJECTS_PREFIX}/${name}`,
      label: name.replace(/__/, '/'),
      kind: 'legacy',
      prefix: `${LEGACY_PROJECTS_PREFIX}/${name}/`,
    };
  }
  return null;
}

// 把平铺条目分组成：根级条目（工作区自己的散文件/目录）+ 每个项目一张卡。
// 条目形如 'a.txt'、'css/'、'repos/easychat2/main/App.js'（目录带尾斜杠，沿用 store 的约定）。
export function groupWorkspaceFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const rootEntries = [];
  const groupsById = new Map();
  for (const entry of list) {
    const group = projectGroupOf(entry);
    if (!group) {
      rootEntries.push(entry);
      continue;
    }
    if (!groupsById.has(group.id)) {
      groupsById.set(group.id, { ...group, fileCount: 0, dirCount: 0 });
    }
    const bucket = groupsById.get(group.id);
    if (String(entry).endsWith('/')) bucket.dirCount += 1;
    else bucket.fileCount += 1;
  }
  // 稳定的展示顺序：新导入的（repos）在前，旧的（projects）在后；组内按 id 字典序。
  const groups = [...groupsById.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'repo' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return { rootEntries, groups };
}

// 某个前缀下**当前层**的子项（目录在前、文件在后，各自字典序）。
// 用于逐层下钻：传入当前目录前缀（'' = 根），返回直接子项；不含更深层的条目。
export function directoryChildren(files, prefix = '') {
  const list = Array.isArray(files) ? files : [];
  const base = String(prefix || '');
  const dirs = new Map();
  const plain = [];
  for (const entry of list) {
    const path = String(entry || '');
    if (base && !path.startsWith(base)) continue;
    const rest = base ? path.slice(base.length) : path;
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      // 本层文件（不带尾斜杠）或本层目录（带尾斜杠，store 的约定）
      if (path.endsWith('/')) dirs.set(rest, `${base}${rest}/`);
      else plain.push({ name: rest, path, isDirectory: false });
      continue;
    }
    const name = rest.slice(0, slash);
    dirs.set(name, `${base}${name}/`);
  }
  const dirEntries = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, path]) => ({ name, path, isDirectory: true }));
  const fileEntries = plain.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirEntries, ...fileEntries];
}

// 面包屑：'repos/easychat2/main/src/' → [{ name: '工作区', path: '' }, …, { name: 'src', path: 'repos/easychat2/main/src/' }]
// rootLabel 由调用方给（走 i18n），函数本身不引 i18n。
export function breadcrumbsOf(prefix = '', rootLabel = '') {
  const base = String(prefix || '');
  const crumbs = [{ name: rootLabel, path: '' }];
  if (!base) return crumbs;
  const segs = segments(base);
  let acc = '';
  for (const seg of segs) {
    acc += `${seg}/`;
    crumbs.push({ name: seg, path: acc });
  }
  return crumbs;
}
