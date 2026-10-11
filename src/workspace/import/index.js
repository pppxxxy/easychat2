// 扩展导入编排（对外唯一入口）：一行输入 → 预览（检测到什么）→ 导入（写进本应用）。
//
// 拆成 preview / run 两步是刻意的：导入是**写操作**（插件还能执行代码），必须先让用户
// 看清「这一步会装进来什么」再落盘。界面按这两步做两段式交互，agent 工具则一次跑完
// （但把预览结果原样回报，且不允许装插件——见 install.js 文件头）。
//
// 纯逻辑 + 注入 fetchImpl / store / mcp，Node 直测。

import { parseImportSource } from './sources.js';
import { detectArtifacts, summarizeArtifacts, hasArtifacts } from './adapt.js';
import { fetchNpmPackageFiles, fetchGithubRepoFiles, fetchRawFile, searchGithubRepos } from './fetchFiles.js';
import { installArtifacts, summarizeInstall } from './install.js';

export { parseImportSource, IMPORT_METHODS, IMPORT_SOURCE_KINDS } from './sources.js';
export { detectArtifacts, summarizeArtifacts, hasArtifacts, ADAPTER_LIMITS } from './adapt.js';
export { installArtifacts, summarizeInstall, mergeMcpServer } from './install.js';
export { searchGithubRepos, IMPORT_FETCH_LIMITS } from './fetchFiles.js';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 来源描述符 → 人读标签（界面与工具输出都用它，不硬编码中文）。
export function importSourceLabel(source) {
  const item = source && typeof source === 'object' ? source : {};
  if (item.kind === 'github') return `${item.owner}/${item.repo}${item.ref ? `@${item.ref}` : ''}${item.subpath ? `/${item.subpath}` : ''}`;
  if (item.kind === 'npm') return `${item.package}${item.version ? `@${item.version}` : ''}`;
  if (item.kind === 'url') return item.label || item.url || '';
  if (item.kind === 'paste') return item.path || 'pasted';
  return '';
}

// 来源 → 文件清单。四种来源在这里收敛成同一个 [{ path, content }]，后面的适配层
// 完全不知道文件从哪来（这也是「加一种来源不用改适配层」的原因）。
export async function loadSourceFiles({ source, fetchImpl = fetch, token = '', signal, limits } = {}) {
  const item = source && typeof source === 'object' ? source : {};
  if (item.kind === 'github') {
    const result = await fetchGithubRepoFiles({
      fetchImpl,
      token,
      owner: item.owner,
      repo: item.repo,
      ref: item.ref,
      subpath: item.subpath,
      signal,
      ...(limits ? { limits } : {}),
    });
    return { files: result.files, meta: { scanned: result.scanned, selected: result.selected, failed: result.failed, truncated: result.truncated, ref: result.ref } };
  }
  if (item.kind === 'npm') {
    const result = await fetchNpmPackageFiles({
      fetchImpl,
      packageName: item.package,
      version: item.version,
      signal,
      ...(limits ? { limits } : {}),
    });
    return { files: result.files, meta: { scanned: result.scanned, selected: result.selected, failed: result.failed, version: result.version } };
  }
  if (item.kind === 'url') {
    const result = await fetchRawFile({ fetchImpl, url: item.url, signal, ...(limits ? { limits } : {}) });
    return { files: result.files, meta: { scanned: result.scanned, selected: result.selected } };
  }
  if (item.kind === 'paste') {
    return { files: [{ path: item.path || 'pasted.json', content: String(item.text || '') }], meta: { scanned: 1, selected: 1 } };
  }
  throw fail('IMPORT_SOURCE', '无法识别的导入来源');
}

// 只检测不落盘。返回 { ok, source, label, artifacts, summary, meta, error }。
export async function previewImport({ input, fetchImpl = fetch, token = '', signal, limits } = {}) {
  const source = parseImportSource(input);
  const label = importSourceLabel(source);
  if (source.kind === 'invalid') {
    return { ok: false, source, label, artifacts: null, summary: summarizeArtifacts(null), meta: {}, error: source.reason };
  }
  try {
    const loaded = await loadSourceFiles({ source, fetchImpl, token, signal, limits });
    const artifacts = detectArtifacts(loaded.files, { sourceLabel: label });
    return {
      ok: true,
      source,
      label,
      artifacts,
      summary: summarizeArtifacts(artifacts),
      meta: loaded.meta,
      fileCount: loaded.files.length,
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      source,
      label,
      artifacts: null,
      summary: summarizeArtifacts(null),
      meta: {},
      error: String((error && error.code) || (error && error.message) || error),
    };
  }
}

// 检测 + 落盘。allowPlugins 默认 false：调用方（agent 工具）显式打开才装插件。
export async function runImport({
  input,
  store,
  characterId,
  fetchImpl = fetch,
  token = '',
  mcp = null,
  allowPlugins = false,
  overwrite = true,
  signal,
  limits,
} = {}) {
  const preview = await previewImport({ input, fetchImpl, token, signal, limits });
  if (!preview.ok) return { ...preview, install: null };
  if (!hasArtifacts(preview.artifacts)) {
    return { ...preview, ok: false, install: null, error: 'noArtifacts' };
  }
  const install = await installArtifacts({
    store,
    characterId,
    artifacts: preview.artifacts,
    mcp,
    allowPlugins,
    overwrite,
  });
  return { ...preview, ok: install.ok, install, installSummary: summarizeInstall(install) };
}

// 关键词找仓库（界面的「搜索」入口用）。空关键词返回空数组，不打网络。
export async function findRepos({ query, fetchImpl = fetch, token = '', limit = 10 } = {}) {
  return searchGithubRepos({ fetchImpl, token, query, limit });
}
