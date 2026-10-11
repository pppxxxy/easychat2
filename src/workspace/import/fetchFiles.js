// 扩展导入的「取文件」层：把来源描述符变成 [{ path, content }]。
//
// 两个来源各有一条刻意选择的路线：
//
//   npm —— 走 jsDelivr 的「包文件树 + 每文件 CDN 地址」，不下载 tarball。
//          registry 的 dist.tarball 是 .tgz，要 gunzip + 手写 tar 解析（fflate 有
//          gunzip，没有 tar）；jsDelivr 两次 HTTP 就能拿到同一份内容，还自带 CDN
//          缓存。代价：只镜像 npm 上**已发布**的包——这正是「去 npm 安装」的语义。
//
//   GitHub —— 走 git/trees(recursive=1) 拿全树 + 按 blob sha 逐文件取原文，
//         不下载整包 zip。导入一个技能不该先拉 50MB 仓库快照；树接口还能在
//          下载前就用 isRelevantImportPath 过滤，省流量也省时间。私有仓库同样可用
//         （blob 接口带 token），公开仓库不带 token 也能跑。
//
// 纯逻辑 + 注入 fetchImpl，Node 直测（与 workspace/github/restApi.js 同款约定）。

import { request } from '../github/restApi.js';
import { isRelevantImportPath } from './adapt.js';

export const IMPORT_FETCH_LIMITS = Object.freeze({
  MAX_FILES: 120,
  MAX_FILE_CHARS: 512 * 1024,
  MAX_TOTAL_CHARS: 6 * 1024 * 1024,
  TIMEOUT_MS: 20000,
});

export const NPM_DATA_BASE = 'https://data.jsdelivr.com/v1/packages/npm';
export const NPM_CDN_BASE = 'https://cdn.jsdelivr.net/npm';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 带超时的 fetch 包装。RN 的 fetch 没有 timeout 选项，挂死的请求会让导入界面
// 一直转圈；用 AbortController 兜住（AbortSignal.timeout 在 Hermes 上不保证存在）。
async function fetchWithTimeout(fetchImpl, url, { headers, timeoutMs = IMPORT_FETCH_LIMITS.TIMEOUT_MS, signal } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onOuterAbort = () => controller && controller.abort();
  if (controller && signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onOuterAbort);
  }
  try {
    return await fetchImpl(url, { headers, signal: controller ? controller.signal : signal });
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onOuterAbort);
    }
  }
}

export async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(fetchImpl, url, options);
  if (!response || response.ok !== true) {
    throw fail('IMPORT_HTTP', `HTTP ${response ? response.status : 0} ${url}`);
  }
  return response.json();
}

export async function fetchText(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(fetchImpl, url, options);
  if (!response || response.ok !== true) {
    throw fail('IMPORT_HTTP', `HTTP ${response ? response.status : 0} ${url}`);
  }
  const text = await response.text();
  return typeof text === 'string' ? text : '';
}

// —— npm（jsDelivr）——

export function buildNpmMetaUrl(packageName) {
  return `${NPM_DATA_BASE}/${encodeURIComponent(String(packageName || '')).replace(/%40/g, '@').replace(/%2F/gi, '/')}`;
}

export function buildNpmVersionUrl(packageName, version) {
  const name = encodeURIComponent(String(packageName || '')).replace(/%40/g, '@').replace(/%2F/gi, '/');
  return `${NPM_DATA_BASE}/${name}@${encodeURIComponent(String(version || 'latest'))}`;
}

export function buildNpmCdnUrl(packageName, version, path) {
  const name = encodeURIComponent(String(packageName || '')).replace(/%40/g, '@').replace(/%2F/gi, '/');
  const clean = String(path || '').split('/').map(encodeURIComponent).join('/');
  return `${NPM_CDN_BASE}/${name}@${encodeURIComponent(String(version || 'latest'))}/${clean}`;
}

// jsDelivr 的文件树是「目录节点里嵌 files」的嵌套结构 → 拍平成 { path, size }。
export function flattenNpmFiles(nodes, prefix = '') {
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;
    const name = String(node.name || '').trim();
    if (!name) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (node.type === 'directory' || Array.isArray(node.files)) {
      out.push(...flattenNpmFiles(node.files, path));
      continue;
    }
    out.push({ path, size: Number(node.size) || 0 });
  }
  return out;
}

// 解析要装的版本：显式给了就用（并核对确实存在），否则用 dist-tags 的 latest。
export async function resolveNpmVersion({ fetchImpl, packageName, version, signal } = {}) {
  const meta = await fetchJson(fetchImpl, buildNpmMetaUrl(packageName), { signal });
  const wanted = String(version || '').trim();
  if (wanted) {
    const exists = Array.isArray(meta && meta.versions)
      && meta.versions.some(item => String((item && item.version) || '') === wanted);
    if (!exists) throw fail('IMPORT_NPM_VERSION', `npm 包没有版本 ${wanted}`);
    return wanted;
  }
  const latest = meta && meta.tags && meta.tags.latest;
  if (!latest) throw fail('IMPORT_NPM_VERSION', 'npm 包没有可用的 latest 版本');
  return String(latest);
}

export async function fetchNpmPackageFiles({ fetchImpl, packageName, version = '', limits = IMPORT_FETCH_LIMITS, signal } = {}) {
  const name = String(packageName || '').trim();
  if (!name) throw fail('IMPORT_NPM_NAME', 'npm 包名不能为空');
  const resolved = await resolveNpmVersion({ fetchImpl, packageName: name, version, signal });
  const listing = await fetchJson(fetchImpl, buildNpmVersionUrl(name, resolved), { signal });
  const all = flattenNpmFiles(listing && listing.files);
  const relevant = all
    .filter(item => isRelevantImportPath(item.path) && item.size <= limits.MAX_FILE_CHARS)
    .slice(0, limits.MAX_FILES);
  const downloaded = await downloadEach(relevant, async item => ({
    path: item.path,
    content: await fetchText(fetchImpl, buildNpmCdnUrl(name, resolved, item.path), { signal }),
  }), limits);
  return {
    files: downloaded.files,
    failed: downloaded.failed,
    version: resolved,
    scanned: all.length,
    selected: relevant.length,
  };
}

// —— GitHub ——

export function buildGithubRawUrl({ owner, repo, ref, path }) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${String(path || '').split('/').map(encodeURIComponent).join('/')}`;
}

// 仓库文件：树接口列全量 → 路径过滤 → 按 blob sha 取原文（一次请求一个文件）。
export async function fetchGithubRepoFiles({ fetchImpl = fetch, token, owner, repo, ref = '', subpath = '', limits = IMPORT_FETCH_LIMITS, signal } = {}) {
  const treeRef = String(ref || '').trim() || 'HEAD';
  const listing = await request(fetchImpl, `${'https://api.github.com'}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`, { token });
  const entries = Array.isArray(listing && listing.data && listing.data.tree) ? listing.data.tree : [];
  const prefix = String(subpath || '').replace(/^\/+|\/+$/g, '');
  const scoped = entries
    .filter(item => item && item.type === 'blob')
    .map(item => ({
      path: String(item.path || ''),
      sha: String(item.sha || ''),
      size: Number(item.size) || 0,
    }))
    .filter(item => item.path && item.sha)
    // 先按 subpath 圈定范围再剥前缀：顺序反了会把子路径之外的文件也当成本次导入目标
    .filter(item => !prefix || item.path === prefix || item.path.startsWith(`${prefix}/`))
    .map(item => (prefix ? { ...item, path: item.path === prefix ? '' : item.path.slice(prefix.length + 1) } : item))
    .filter(item => item.path !== '')
    .filter(item => isRelevantImportPath(item.path) && item.size <= limits.MAX_FILE_CHARS)
    .slice(0, limits.MAX_FILES);
  const downloaded = await downloadEach(scoped, async item => ({
    path: item.path,
    content: await request(fetchImpl, `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(item.sha)}`, {
      token,
      accept: 'application/vnd.github.raw',
      parse: 'text',
    }).then(result => (typeof result.data === 'string' ? result.data : '')),
  }), limits, signal);
  return {
    files: downloaded.files,
    failed: downloaded.failed,
    ref: treeRef,
    truncated: Boolean(listing && listing.data && listing.data.truncated === true),
    scanned: entries.length,
    selected: scoped.length,
  };
}

export function normalizeRepoSearchItem(item) {
  const source = item && typeof item === 'object' ? item : {};
  const owner = String((source.owner && source.owner.login) || '').trim();
  return {
    fullName: String(source.full_name || '').trim(),
    owner,
    repo: String(source.name || '').trim(),
    description: String(source.description || '').trim().slice(0, 200),
    stars: Number(source.stargazers_count) || 0,
    defaultBranch: String(source.default_branch || '').trim(),
    url: String(source.html_url || '').trim(),
  };
}

// 关键词搜仓库。GitHub 的仓库搜索是「名字/描述/README」匹配，够用来找插件仓库。
export async function searchGithubRepos({ fetchImpl = fetch, token, query, limit = 10 } = {}) {
  const text = String(query || '').trim();
  if (!text) return [];
  const perPage = Math.min(Math.max(1, Math.floor(Number(limit) || 10)), 30);
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(text)}&sort=stars&order=desc&per_page=${perPage}`;
  const { data } = await request(fetchImpl, url, { token });
  return (Array.isArray(data && data.items) ? data.items : [])
    .map(normalizeRepoSearchItem)
    .filter(item => item.fullName && item.repo);
}

// —— 单个原始文件 ——

export async function fetchRawFile({ fetchImpl, url, limits = IMPORT_FETCH_LIMITS, signal } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw fail('IMPORT_URL', '只支持 http(s) 地址');
  const content = await fetchText(fetchImpl, target, { signal });
  if (content.length > limits.MAX_FILE_CHARS) throw fail('IMPORT_TOO_LARGE', '文件超过单文件上限');
  const path = baseOf(target);
  return { files: [{ path, content }], scanned: 1, selected: 1 };
}

function baseOf(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  const parts = clean.split('/');
  return decodeURIComponent(parts[parts.length - 1] || 'file');
}

// 串行下载 + 总量上限：并发会同时打满 CDN/API 的限流，导入这种一次性动作不值得
// 为几秒的速度去冒 403 的风险；总量上限防「清单说 120 个、实际每个 500KB」撑爆内存。
//
// 单个文件取失败**只跳过它**并计数，不拖垮整次导入——一个仓库里有一个取不到的文件
// （权限/被删/LFS 指针）很常见，为此让用户拿不到其余 20 个技能是坏交易。
async function downloadEach(items, loader, limits, signal) {
  const files = [];
  let total = 0;
  let failed = 0;
  for (const item of items) {
    if (signal && signal.aborted) break;
    let file = null;
    try {
      file = await loader(item);
    } catch (error) {
      failed += 1;
      continue;
    }
    if (!file || typeof file.content !== 'string') continue;
    total += file.content.length;
    if (total > limits.MAX_TOTAL_CHARS) {
      throw fail('IMPORT_TOO_LARGE', '所选文件总量超过导入上限');
    }
    files.push(file);
  }
  return { files, failed };
}
