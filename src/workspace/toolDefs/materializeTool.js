// materialize_repo（C2 的 agent 侧）：把快速检出（云端清单）里还没物化的文件
// 批量下载进本地。agent 在跑 run_shell 搜代码之前，先用它把要搜的范围拉到本地——
// 否则 shell 只能搜到已下载的部分，会得出错误结论。
//
// readOnly: true——它是「下载缓存」不是「改内容」：不修改任何已有文件。
// 单次上限 25 个：防一次调用拉几百个文件把时间/上下文撑爆；剩余量如实报告，
// 模型可再次调用（幂等）。
import { parseRepoFilePath, parseRepoManifest, repoManifestPath } from '../repoPaths.js';

export const MATERIALIZE_MAX_PER_CALL = 25;

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

export const MATERIALIZE_TOOL_DEFINITION = {
  name: 'materialize_repo',
  description: '把「快速检出」清单里还没下载到本地的文件批量下载进工作区（单次最多 '
    + `${MATERIALIZE_MAX_PER_CALL} 个` + '）。要在 run_shell / 终端里搜索或处理 repos/ '
    + '下的文件之前，先用它把目标范围物化——否则只能搜到已下载的部分。'
    + 'path 传仓库目录（如 repos/owner/repo/main/）；一次没拉完会报告剩余数量，'
    + '可再次调用（幂等）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '仓库目录前缀（如 repos/owner/repo/main/）。' },
      limit: {
        type: 'number',
        description: `可选：本次最多下载几个（默认与上限 ${MATERIALIZE_MAX_PER_CALL}）。`,
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
    const rawLimit = Number(args && args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MATERIALIZE_MAX_PER_CALL)
      : MATERIALIZE_MAX_PER_CALL;
    const batch = pending.slice(0, limit);
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
    }
    return lines.join('\n');
  },
};
