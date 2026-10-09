// 仓库路径与清单路径的**纯字符串规则**（零依赖——layering 契约：引用它的模块
// 不会被拖进 fflate / 网络层）。
//
// 为什么单独一个文件：materializeTool（工具定义层）需要这些规则，而 repoImport
// 与 repoMaterialize 都拖 fflate——工具定义层的静态链必须干净（分层测试用加载
// 炸弹钉着）。规则只有一份，谁都从这里取。

// 沙盒路径 → 仓库坐标：repos/<owner>/<repo>/<branch>/<rel>。
// 不满足形态（不在 repos/ 下、段数不足）返回 null——调用方按「普通文件」处理。
export function parseRepoFilePath(path) {
  const parts = String(path || '').split('/');
  if (parts[0] !== 'repos' || parts.length < 5) return null;
  const owner = parts[1];
  const repo = parts[2];
  const branch = parts[3];
  const rel = parts.slice(4).join('/');
  if (!owner || !repo || !branch || !rel) return null;
  return { owner, repo, branch, rel };
}

// 清单缓存路径：.easychat/repos-manifest/{owner}__{repo}__{branch}.json。
// 三段都 encodeURIComponent——branch 可能含 `/`，直接拼会造出假目录。
export function repoManifestPath({ owner, repo, branch } = {}) {
  const key = [owner, repo, branch].map(part => encodeURIComponent(String(part || ''))).join('__');
  return `.easychat/repos-manifest/${key}.json`;
}

// 纯函数：清单文本 → { entries, truncated, at }；坏输入 → null（当作没有清单）。
export function parseRepoManifest(text) {
  try {
    const source = typeof text === 'string' ? JSON.parse(text) : text;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const entries = (Array.isArray(source.entries) ? source.entries : [])
      .map(item => ({
        path: String((item && item.path) || ''),
        type: String((item && item.type) || (String((item && item.path) || '').endsWith('/') ? 'tree' : 'blob')),
        sha: String((item && item.sha) || ''),
        size: Number(item && item.size) || 0,
      }))
      .filter(item => item.path);
    return { entries, truncated: source.truncated === true, at: Number(source.at) || 0 };
  } catch (error) {
    return null;
  }
}
