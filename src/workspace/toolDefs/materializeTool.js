// materialize_repo（C2 的 agent 侧）：把快速检出（云端清单）里还没物化的文件
// 批量下载进本地。agent 在跑 run_shell 搜代码之前，先用它把要搜的范围拉到本地——
// 否则 shell 只能搜到已下载的部分，会得出错误结论。
//
// readOnly: true——它是「下载缓存」不是「改内容」：不修改任何已有文件。
// 单次上限 25 个：防一次调用拉几百个文件把时间/上下文撑爆；剩余量如实报告，
// 模型可再次调用（幂等）。
//
// F 项（2026-10-12，用户麻烦）：大仓库要反复调用 25 个一批，此前只能靠模型自己
// 猜「下次拉哪一批」——它看不见还没物化的范围，于是可能反复停在同一个目录。
// 现在两处一起补：
//   · 新增可选 subdir：把一批收敛到某个子目录（大仓库按目录分批）；
//   · 剩余量不为 0 时**如实列出剩余文件的目录分布**，模型据此决定下一次传哪个 subdir。
// 没有把「一次调用内部循环拉完」做成默认行为：25 个上限是网络/超时的护栏
//（timeoutMs 120s，见下），一次拉几百个文件只会变成「结果未知的超时」。
import { parseRepoFilePath, parseRepoManifest, repoManifestPath } from '../repoPaths.js';

export const MATERIALIZE_MAX_PER_CALL = 25;
// 剩余目录分布最多列几个：够模型挑下一批即可，列全了会把这行变成噪声。
export const MATERIALIZE_DIR_HINT_MAX = 6;

// 目录前缀 → 仓库坐标：repos/o/r/branch/（允许 rel 为空）。
// 在末尾补一个占位再剥掉——复用单文件解析，保证「路径规则只有一处」。
function parseRepoDirPath(path) {
  const value = String(path || '').trim();
  const normalized = value.endsWith('/') ? value : `${value}/`;
  const target = parseRepoFilePath(`${normalized}x`);
  return target ? { owner: target.owner, repo: target.repo, branch: target.branch } : null;
}

// 读清单（内联薄壳——规则来自零依赖的 repoPaths；不 import repoImport：它拖
// fflate，会污染工具定义层的静态链，分层测试用加载炸弹钉着）。
async function readManifest(store, characterId, key) {
  try {
    const result = await store.readWorkspaceFile({ characterId, path: repoManifestPath(key) });
    return parseRepoManifest(result && result.content);
  } catch (error) {
    return null;
  }
}

// 剩余文件 → 目录分布（仓库内相对路径的**首层目录**）。用于告诉模型下一次该传哪个
// subdir；大仓库里这一行才是「反复调用能收敛」的关键（否则模型只能猜）。
// 排序：数量多的在前（先啃大的），同数量按目录名（结果稳定、可断言）。
export function groupPendingByDir(paths, prefix, { max = MATERIALIZE_DIR_HINT_MAX } = {}) {
  const base = String(prefix || '');
  const counts = new Map();
  for (const item of Array.isArray(paths) ? paths : []) {
    const raw = String(item);
    const rel = raw.startsWith(base) ? raw.slice(base.length) : raw;
    const slash = rel.indexOf('/');
    // 顶层文件（没有目录）归到 ''，显示时由调用方写成「（仓库根目录）」。
    const dir = slash > 0 ? rel.slice(0, slash) : '';
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  const list = [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => (b.count - a.count) || a.dir.localeCompare(b.dir));
  return { list: list.slice(0, max), total: list.length };
}

// subdir 归一化成「仓库内相对路径前缀」：剥掉首尾斜杠，拒绝 .. 与 . 段
//（与 git 路径越界的口径一致：子目录过滤只允许落在仓库内部）。
function normalizeSubdir(raw) {
  const value = String(raw == null ? '' : raw).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!value) return '';
  if (value.split('/').some(seg => seg === '..' || seg === '.')) return null;
  return `${value}/`;
}

export const MATERIALIZE_TOOL_DEFINITION = {
  name: 'materialize_repo',
  description: '把「快速检出」清单里还没下载到本地的文件批量下载进工作区（单次最多 '
    + `${MATERIALIZE_MAX_PER_CALL} 个` + '）。要在 run_shell / 终端里搜索或处理 repos/ '
    + '下的文件之前，先用它把目标范围物化——否则只能搜到已下载的部分。'
    + 'path 传仓库目录（如 repos/owner/repo/main/）；一次没拉完会报告剩余数量，'
    + '可再次调用（幂等）。大仓库可传 subdir（仓库内相对目录，如 src/）把一批收敛到'
    + '某个子目录；剩余文件的目录分布会一并列出，照它挑下一次的 subdir 即可逐目录拉完。',
  readOnly: true,
  // 单次最多下载 25 个文件（走网络）——默认 15s 兜底必然误判超时（同类 bug 见 tools.js 注释）。
  timeoutMs: 120000,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '仓库目录前缀（如 repos/owner/repo/main/）。' },
      limit: {
        type: 'number',
        description: `可选：本次最多下载几个（默认与上限 ${MATERIALIZE_MAX_PER_CALL}）。`,
      },
      subdir: {
        type: 'string',
        description: '可选：只处理该子目录（仓库内相对路径，如 src/ 或 docs/api/）。'
          + '大仓库按目录分批时用它，避免反复停在同一个目录。',
      },
    },
    required: ['path'],
  },
  execute: async (options, args, ctx) => {
    const dir = parseRepoDirPath(args && args.path);
    if (!dir) return '（path 需要是仓库目录，形如 repos/<owner>/<repo>/<branch>/。）';
    if (!options.store || typeof options.materializer !== 'function') {
      return '（当前宿主不支持按需物化。）';
    }
    const subdir = normalizeSubdir(args && args.subdir);
    if (subdir === null) return '（subdir 需要是仓库内的相对目录，不能含 .. 或 . 段。）';
    const characterId = ctx && ctx.characterId;
    const manifest = await readManifest(options.store, characterId, dir);
    if (!manifest) {
      return '（这个仓库没有云端清单——先在 GitHub 面板点「快速检出」，或直接用「拉取快照」完整拉取。）';
    }
    const prefix = `repos/${dir.owner}/${dir.repo}/${dir.branch}/`;
    const files = await options.store.listWorkspaceFiles({ characterId });
    const localSet = new Set((Array.isArray(files) ? files : []).map(item => String(item)));
    const pending = manifest.entries
      .filter(item => item.type === 'blob' && item.path && !localSet.has(`${prefix}${item.path}`))
      .map(item => `${prefix}${item.path}`);
    if (pending.length === 0) return '（这个仓库已全部物化，没有需要下载的文件。）';
    // 子目录只影响「这一批拉什么」，不改「还剩多少」的口径：剩余量按**全仓**未物化数报
    //（否则模型会以为传了 subdir 就把仓库拉完了）。
    const scoped = subdir ? pending.filter(item => item.slice(prefix.length).startsWith(subdir)) : pending;
    if (scoped.length === 0) {
      return `（subdir「${subdir}」下没有未物化的文件；全仓还有 ${pending.length} 个未物化。）`;
    }
    const rawLimit = Number(args && args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MATERIALIZE_MAX_PER_CALL)
      : MATERIALIZE_MAX_PER_CALL;
    const batch = scoped.slice(0, limit);
    let ok = 0;
    let failed = 0;
    for (const filePath of batch) {
      try {
        const done = await options.materializer(filePath);
        if (done) ok += 1; else failed += 1;
      } catch (error) {
        failed += 1;
      }
    }
    const remaining = pending.length - batch.length;
    const lines = [`物化完成：成功 ${ok} 个${failed > 0 ? `，失败 ${failed} 个（网络/权限，可稍后重试）` : ''}。`];
    if (remaining > 0) {
      lines.push(`还有 ${remaining} 个未物化——请再次调用 materialize_repo 继续（每次最多 ${MATERIALIZE_MAX_PER_CALL} 个）。`);
      // 剩余目录分布：让「下一次传哪个 subdir」有依据，而不是让模型猜。
      const done = new Set(batch);
      const rest = pending.filter(item => !done.has(item));
      const { list, total } = groupPendingByDir(rest, prefix);
      if (list.length > 0) {
        const shown = list.map(item => `${item.dir || '（仓库根目录）'}/（${item.count} 个）`).join('、');
        lines.push(`未物化的目录：${shown}${total > list.length ? `，另有 ${total - list.length} 个目录` : ''}；`
          + '可用 subdir 指定其中一个逐目录拉完。');
      }
    }
    return lines.join('\n');
  },
};
