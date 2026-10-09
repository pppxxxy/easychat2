// 工作区文件的「项目分组」与「目录树」纯函数（零依赖，Node 直测）。
//
// 背景（v2 §1.2 诉求④）：listWorkspaceFiles 返回的是**平铺**的相对路径数组，
// 旧面板一维渲染，于是 css/、js/、repos/pppxxxy/easychat2/main/src/... 混居成一长条，
// 路径被截断成「repos/leiting-zhanji-h5/main/RE...」。分组 + 逐层下钻后，
// 文件按项目成卡、点进去只看当前层，长路径问题自然消失。
//
// 项目前缀（v2 起为唯一规范；旧的 projects/<owner>__<repo>/ 已随聊天侧导入一并移除）：
//   repos/<owner>/<repo>/<branch>/…   分支快照（GitHub 工作台拉取）

export const REPOS_PREFIX = 'repos';

function segments(path) {
  return String(path || '').split('/').filter(Boolean);
}

// 从相对路径解析出项目组。返回 { id, label, prefix } 或 null（不属于任何项目）。
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
      prefix: `${REPOS_PREFIX}/${prefix}`,
    };
  }
  return null;
}

// 把平铺条目分组成：根级条目（工作区自己的散文件/目录）+ 每个项目一张卡。
// 条目形如 'a.txt'、'css/'、'repos/pppxxxy/easychat2/main/App.js'（目录带尾斜杠，沿用 store 的约定）。
// 注意 repos/ 下的路径一律带 owner 段（repos/<owner>/<repo>/<branch>/）——注释里的旧格式
// 示例已全部清除：无 owner 的写法曾是历史遗留，留着只会让排查时把它当成现行格式。
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
  // 稳定顺序：按 id 字典序（同一仓库的多个分支相邻）。
  const groups = [...groupsById.values()].sort((a, b) => a.id.localeCompare(b.id));
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

// 面包屑：'repos/pppxxxy/easychat2/main/src/' → [{ name: '工作区', path: '' }, …, { name: 'src', path: '…/src/' }]
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

// C1：本地物化文件 ∪ 清单条目（快速检出后「未物化的文件」也出现在树里）。
// 清单里 path 是**仓库内相对路径**（'src/a.js'，listTree 直出），拼上 prefix
// 变成沙盒全路径再与本地对齐。返回 { entries, virtual }：entries 是合并后的
// 条目数组（目录带尾斜杠，沿用 store 约定，可直接喂 directoryChildren）；
// virtual 是「只在清单里」的沙盒全路径集合（渲染层画云朵角标 = 点开时按需下载）。
// 本地存在的一律以本地为准（含「清单说目录、本地是文件」这类形态冲突）。
export function mergeManifestEntries({ files, manifestEntries, prefix } = {}) {
  const base = String(prefix || '');
  const local = new Set((Array.isArray(files) ? files : []).map(item => String(item || '')));
  const entries = new Set();
  for (const entry of local) {
    if (entry.startsWith(base)) entries.add(entry);
  }
  const virtual = new Set();
  for (const item of (Array.isArray(manifestEntries) ? manifestEntries : [])) {
    // 显式分支：字符串条目直接用；对象只认 path 字段——绝不让「path 为空串」
    // 把对象本身 String 成 '[object Object]'（曾这么错过一次，被测试钉回来）。
    const raw = typeof item === 'string'
      ? item.trim()
      : String((item && item.path) || '').trim();
    if (!raw) continue;
    const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const isTree = (item && item.type === 'tree') || raw.endsWith('/');
    const full = `${base}${normalized}${isTree ? '/' : ''}`;
    if (!normalized || !full.startsWith(base)) continue;
    entries.add(full);
    if (virtual.has(full)) continue;
    // 本地已有（文件或目录两种形态）就不算 virtual——本地为准。
    if (local.has(full) || local.has(`${base}${normalized}`) || local.has(`${base}${normalized}/`)) continue;
    virtual.add(full);
  }
  return { entries: [...entries].sort(), virtual };
}

// 上一级目录：'repos/a/b/' → 'repos/a/'；'a/' → ''（回到根层）。
// F1 的空目录空状态里「返回上级」用它——比在组件里内联正则更可测。
export function parentDirectoryOf(path) {
  const value = String(path || '');
  if (!value) return '';
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? '' : `${trimmed.slice(0, index)}/`;
}
