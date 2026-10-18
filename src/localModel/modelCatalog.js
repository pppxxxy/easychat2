// 本地模型目录：HuggingFace 与魔搭社区（ModelScope）的仓库搜索与文件解析。
// 解析函数全部是纯函数（便于单测）；网络函数只负责拼请求并调用可注入的 fetch。
// 约定：只收录含 `.gguf` 的仓库，文件列表只保留 `.gguf` 与配套 mmproj。

import {
  DEFAULT_LOCAL_MODEL_SOURCE_ID,
  LOCAL_MODEL_DOWNLOAD_SOURCES,
  resolveLocalModelSourceId,
} from './modelState.js';
import { tActive } from '../i18n/index.js';
import { recordDiagnostic } from '../storage/diagnostics.js';

// 目录提供方：hf-mirror 复用 HuggingFace 的搜索/文件接口，仅下载主机不同。
// （原 CATALOG_PROVIDERS 常量只有 id/name/revision，全仓零消费，已删。）
const SOURCE_PROVIDER = {
  huggingface: 'huggingface',
  'hf-mirror': 'huggingface',
  modelscope: 'modelscope',
};

// 下载源 → resolve 路径前缀与默认分支：魔搭的下载地址多一层 /models。
const SOURCE_DOWNLOAD = {
  huggingface: { prefix: '', revision: 'main' },
  'hf-mirror': { prefix: '', revision: 'main' },
  modelscope: { prefix: 'models', revision: 'master' },
};

export function catalogProviderForSource(sourceId) {
  // 空/未知源一律按**默认源**解释（T2）。此前回落字面量 'huggingface'——
  // 而默认源已改成 hf-mirror（见 modelState.DEFAULT_LOCAL_MODEL_SOURCE_ID 的注释：
  // 官方站在国内直连必失败，默认指过去等于让用户「啥都搜不到」）。
  // 注意本函数返回的是**provider**（'huggingface' / 'modelscope'），不是 sourceId：
  // hf-mirror 复用 HuggingFace 的接口形态，所以它的 provider 本来就是 'huggingface'。
  const resolved = resolveLocalModelSourceId(sourceId);
  return SOURCE_PROVIDER[resolved] || SOURCE_PROVIDER[DEFAULT_LOCAL_MODEL_SOURCE_ID] || 'huggingface';
}

export function defaultRevisionForSource(sourceId) {
  const entry = SOURCE_DOWNLOAD[String(sourceId || '')];
  return (entry && entry.revision) || 'main';
}

export function isGgufFile(filePath) {
  return String(filePath || '').toLowerCase().endsWith('.gguf');
}

// 多模态投影文件（mmproj）用于识图/听声，不单独作为可运行模型。
export function isProjectorFile(filePath) {
  const base = String(filePath || '').toLowerCase().split('/').pop();
  return base.includes('mmproj');
}

export function classifyGgufFile(filePath) {
  if (!isGgufFile(filePath)) return null;
  return isProjectorFile(filePath) ? 'projector' : 'model';
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function firstPositiveSize(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return 0;
}

function splitGgufEntries(entries) {
  const modelFiles = [];
  const projectorFiles = [];
  entries.forEach(entry => {
    if (entry.kind === 'projector') projectorFiles.push(entry);
    else modelFiles.push(entry);
  });
  modelFiles.sort((a, b) => a.size - b.size);
  projectorFiles.sort((a, b) => a.size - b.size);
  return { modelFiles, projectorFiles };
}

function encodeRepoPath(repoId) {
  return String(repoId || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function encodeFilePath(filePath) {
  return String(filePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// 取某下载源的基地址（去尾斜杠）。目录搜索/文件列表与下载共用同一主机，
// 这样 HF Mirror 不仅下载走镜像，搜索与文件接口也走镜像（否则国内仍连不上官方站）。
//
// 空/未知源先归一到**默认源**再查表（T2）：此前直接拿空串查表、查不到就回落
// 'https://huggingface.co'，于是「手动输入 URL」「selection.sourceId 为空」这类
// 路径会绕过界面默认值、悄悄打官方站——正是「啥都搜不到」的另一条入口。
function catalogBaseUrl(sourceId) {
  const resolved = resolveLocalModelSourceId(sourceId);
  const source = LOCAL_MODEL_DOWNLOAD_SOURCES.find(item => item.id === resolved)
    || LOCAL_MODEL_DOWNLOAD_SOURCES.find(item => item.id === DEFAULT_LOCAL_MODEL_SOURCE_ID);
  // 字面量只作最后的绝对兜底（列表为空这种不可能的情况），不再是「未知源」的去处。
  return String((source && source.baseUrl) || 'https://huggingface.co').replace(/\/+$/, '');
}

// --- HuggingFace ---

export function parseHuggingFaceSearch(json) {
  const list = Array.isArray(json) ? json : [];
  const results = [];
  list.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const repoId = String(item.modelId || item.id || '').trim();
    if (!repoId) return;
    const tags = Array.isArray(item.tags) ? item.tags.map(tag => String(tag).toLowerCase()) : [];
    if (!tags.includes('gguf')) return;
    results.push({
      provider: 'huggingface',
      repoId,
      name: repoId.split('/').pop(),
      downloads: toCount(item.downloads),
      likes: toCount(item.likes),
      revision: 'main',
    });
  });
  return results;
}

export function parseHuggingFaceTree(json, repoId, revision = 'main') {
  const list = Array.isArray(json) ? json : [];
  const entries = [];
  list.forEach(item => {
    if (!item || item.type !== 'file') return;
    const path = String(item.path || '');
    const kind = classifyGgufFile(path);
    if (!kind) return;
    entries.push({
      path,
      size: firstPositiveSize(item.lfs && item.lfs.size, item.size),
      // HuggingFace 对 LFS 文件返回 sha256（与 size 同级）；存下来供下载完整性校验/
      // 未来分块哈希使用。非 LFS 小文件没有该字段，留空。
      sha256: String((item.lfs && item.lfs.sha256) || '').toLowerCase(),
      kind,
    });
  });
  return { repoId: String(repoId || ''), revision, ...splitGgufEntries(entries) };
}

// --- 魔搭社区（ModelScope）---

export function parseModelScopeSearch(json) {
  const models = json && json.Data && json.Data.Model && Array.isArray(json.Data.Model.Models)
    ? json.Data.Model.Models
    : [];
  const results = [];
  models.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const namespace = String(item.Path || '').trim();
    const name = String(item.Name || '').trim();
    if (!namespace || !name) return;
    const libraries = Array.isArray(item.Libraries) ? item.Libraries.map(lib => String(lib).toLowerCase()) : [];
    if (!libraries.includes('gguf')) return;
    results.push({
      provider: 'modelscope',
      repoId: `${namespace}/${name}`,
      name,
      downloads: toCount(item.Downloads),
      likes: 0,
      revision: 'master',
    });
  });
  return results;
}

export function parseModelScopeFiles(json, repoId, revision = 'master') {
  const files = json && json.Data && Array.isArray(json.Data.Files) ? json.Data.Files : [];
  const entries = [];
  files.forEach(item => {
    if (!item || typeof item !== 'object') return;
    if (String(item.Type || '').toLowerCase() === 'tree') return;
    const path = String(item.Path || item.Name || '');
    const kind = classifyGgufFile(path);
    if (!kind) return;
    entries.push({ path, size: firstPositiveSize(item.Size), kind });
  });
  return { repoId: String(repoId || ''), revision, ...splitGgufEntries(entries) };
}

// --- 下载地址 ---

export function buildDownloadUrl(sourceId, repoId, revision, filePath) {
  // 空/未知源归一到默认源（T2）：否则「手动输入 URL」等路径会生成官方站地址，
  // 在国内下不动，而用户以为自己选的是镜像。
  const id = resolveLocalModelSourceId(sourceId);
  const source = LOCAL_MODEL_DOWNLOAD_SOURCES.find(item => item.id === id)
    || LOCAL_MODEL_DOWNLOAD_SOURCES.find(item => item.id === DEFAULT_LOCAL_MODEL_SOURCE_ID);
  // 路径前缀（魔搭多一层 /models）与默认分支也按**归一后的** id 取，
  // 免得出现「主机是镜像、路径按官方站拼」的混合体。
  const prefixInfo = SOURCE_DOWNLOAD[id]
    || SOURCE_DOWNLOAD[DEFAULT_LOCAL_MODEL_SOURCE_ID]
    || SOURCE_DOWNLOAD.huggingface;
  const base = String((source && source.baseUrl) || 'https://huggingface.co').replace(/\/+$/, '');
  const repo = encodeRepoPath(repoId);
  const path = encodeFilePath(filePath);
  if (!repo || !path) return '';
  const rev = String(revision || '').trim() || prefixInfo.revision;
  const prefix = prefixInfo.prefix ? `${prefixInfo.prefix}/` : '';
  return `${base}/${prefix}${repo}/resolve/${rev}/${path}`;
}

// 解析任意来源的下载地址，换成目标下载源（保留仓库/分支/文件名）。解析失败返回 ''。
export function parseDownloadUrl(url) {
  const withoutHost = String(url || '').replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
  const parts = withoutHost.split('/').filter(Boolean);
  const index = parts.indexOf('resolve');
  if (index < 2 || index + 1 >= parts.length) return null;
  let repoParts = parts.slice(0, index);
  if (repoParts[0] === 'models') repoParts = repoParts.slice(1);
  const repoId = repoParts.join('/');
  const revision = parts[index + 1];
  const filePath = parts.slice(index + 2).join('/');
  if (!repoId || !revision || !filePath) return null;
  return { repoId, revision, filePath };
}

export function rewriteDownloadSourceUrl(url, targetSourceId) {
  const parsed = parseDownloadUrl(url);
  if (!parsed) return '';
  return buildDownloadUrl(targetSourceId, parsed.repoId, parsed.revision, parsed.filePath);
}

// --- 网络请求 ---

const CATALOG_ADAPTERS = {
  huggingface: {
    provider: 'huggingface',
    revision: 'main',
    searchRequest: (query, baseUrl) => ({
      url: `${baseUrl}/api/models?search=${encodeURIComponent(String(query || ''))}&filter=gguf&sort=downloads&direction=-1&limit=30`,
      init: { method: 'GET' },
    }),
    filesRequest: (repoId, revision, baseUrl) => ({
      url: `${baseUrl}/api/models/${encodeRepoPath(repoId)}/tree/${encodeURIComponent(revision || 'main')}?recursive=true`,
      init: { method: 'GET' },
    }),
    parseSearch: parseHuggingFaceSearch,
    parseFiles: parseHuggingFaceTree,
  },
  modelscope: {
    provider: 'modelscope',
    revision: 'master',
    searchRequest: (query, baseUrl) => ({
      url: `${baseUrl || 'https://modelscope.cn'}/api/v1/dolphin/models`,
      init: {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          PageSize: 30,
          PageNumber: 1,
          Name: String(query || ''),
          SortBy: 'Default',
          Target: '',
          SingleCriterion: [],
        }),
      },
    }),
    filesRequest: (repoId, revision, baseUrl) => ({
      url: `${baseUrl || 'https://modelscope.cn'}/api/v1/models/${encodeRepoPath(repoId)}/repo/files?Revision=${encodeURIComponent(revision || 'master')}`,
      init: { method: 'GET' },
    }),
    parseSearch: parseModelScopeSearch,
    parseFiles: parseModelScopeFiles,
  },
};

function resolveFetch(options) {
  if (options && typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (typeof fetch === 'function') return fetch;
  throw new Error(tActive('error.localModel.fetchUnsupported'));
}

async function requestJson(request, options) {
  const fetchImpl = resolveFetch(options);
  const response = await fetchImpl(request.url, { ...request.init, signal: options && options.signal });
  if (!response || response.ok === false) {
    const status = response && response.status ? `（${response.status}）` : '';
    throw new Error(`请求失败${status}`);
  }
  return response.json();
}

// 搜索/取文件失败时**必须留痕**。
//
// 真机事故（2026-10-19）：用户在国内点开搜索，任何关键词都搜不到，而诊断日志里
// **一条记录都没有**——本模块此前完全没有 recordDiagnostic。用户与开发者都无从判断
// 是「网络不通」「接口改了」还是「源选错了」。同型纪律见 storage/diagnostics.js 文件头
// 与 backupRead 的 recordReadTrace：失败路径的留痕不是可选项。
//
// 只记 sourceId / 主机 / 状态或错误首行——**不记 query 全文**（用户搜的可能是私人内容）。
//
// T4：留痕实现可注入（`options.recordFailure`），让「失败时到底记了什么」能被**运行时**
// 断言，而不是只靠扫源码字符串。默认仍是 recordDiagnostic，生产路径行为不变。
function noteCatalogFailure(stage, sourceId, baseUrl, error, recordFailure = recordDiagnostic) {
  try {
    const host = String(baseUrl || '').replace(/^https?:\/\//i, '').split('/')[0];
    const reason = String((error && error.message) || error || 'unknown').split('\n')[0].slice(0, 200);
    recordFailure(
      'api',
      { message: `[local-model] ${stage} failed on ${host || sourceId}` },
      `source=${String(sourceId || '')} reason=${reason}`
    );
  } catch {
    // 留痕失败绝不挡主流程（T5：不绑定 error，免得遮蔽上面的参数）。
  }
}

// 从 options 取留痕实现：只在**显式传入函数**时替换，避免 undefined/null 把默认实现顶掉。
function resolveRecordFailure(options) {
  const candidate = options && options.recordFailure;
  return typeof candidate === 'function' ? candidate : recordDiagnostic;
}

export async function searchModels(sourceId, query, options = {}) {
  const adapter = CATALOG_ADAPTERS[catalogProviderForSource(sourceId)];
  const baseUrl = catalogBaseUrl(sourceId);
  try {
    const json = await requestJson(adapter.searchRequest(query, baseUrl), options);
    // 结果的 sourceId 也归一：否则空源搜出来的条目会带回 sourceId:''，
    // 回填草稿后再一次落到「未知源」的兜底路径上。
    const resolved = resolveLocalModelSourceId(sourceId);
    return adapter.parseSearch(json).map(item => ({ ...item, sourceId: resolved }));
  } catch (error) {
    noteCatalogFailure('search', sourceId, baseUrl, error, resolveRecordFailure(options));
    throw error;
  }
}

export async function listModelFiles(sourceId, repoId, options = {}) {
  const adapter = CATALOG_ADAPTERS[catalogProviderForSource(sourceId)];
  const revision = adapter.revision;
  const baseUrl = catalogBaseUrl(sourceId);
  try {
    const json = await requestJson(adapter.filesRequest(repoId, revision, baseUrl), options);
    return adapter.parseFiles(json, repoId, revision);
  } catch (error) {
    noteCatalogFailure('files', sourceId, baseUrl, error, resolveRecordFailure(options));
    throw error;
  }
}
