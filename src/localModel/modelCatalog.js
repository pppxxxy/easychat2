// 本地模型目录：HuggingFace 与魔搭社区（ModelScope）的仓库搜索与文件解析。
// 解析函数全部是纯函数（便于单测）；网络函数只负责拼请求并调用可注入的 fetch。
// 约定：只收录含 `.gguf` 的仓库，文件列表只保留 `.gguf` 与配套 mmproj。

import { LOCAL_MODEL_DOWNLOAD_SOURCES } from './modelState.js';

// 目录提供方：hf-mirror 复用 HuggingFace 的搜索/文件接口，仅下载主机不同。
export const CATALOG_PROVIDERS = [
  { id: 'huggingface', name: 'Hugging Face', revision: 'main' },
  { id: 'modelscope', name: '魔搭社区', revision: 'master' },
];

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
  return SOURCE_PROVIDER[String(sourceId || '')] || 'huggingface';
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
  const id = String(sourceId || '');
  const source = LOCAL_MODEL_DOWNLOAD_SOURCES.find(item => item.id === id);
  const prefixInfo = SOURCE_DOWNLOAD[id] || SOURCE_DOWNLOAD.huggingface;
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
    searchRequest: query => ({
      url: `https://huggingface.co/api/models?search=${encodeURIComponent(String(query || ''))}&filter=gguf&sort=downloads&direction=-1&limit=30`,
      init: { method: 'GET' },
    }),
    filesRequest: (repoId, revision) => ({
      url: `https://huggingface.co/api/models/${encodeRepoPath(repoId)}/tree/${encodeURIComponent(revision || 'main')}?recursive=true`,
      init: { method: 'GET' },
    }),
    parseSearch: parseHuggingFaceSearch,
    parseFiles: parseHuggingFaceTree,
  },
  modelscope: {
    provider: 'modelscope',
    revision: 'master',
    searchRequest: query => ({
      url: 'https://modelscope.cn/api/v1/dolphin/models',
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
    filesRequest: (repoId, revision) => ({
      url: `https://modelscope.cn/api/v1/models/${encodeRepoPath(repoId)}/repo/files?Revision=${encodeURIComponent(revision || 'master')}`,
      init: { method: 'GET' },
    }),
    parseSearch: parseModelScopeSearch,
    parseFiles: parseModelScopeFiles,
  },
};

function resolveFetch(options) {
  if (options && typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (typeof fetch === 'function') return fetch;
  throw new Error('当前环境不支持网络请求');
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

export async function searchModels(sourceId, query, options = {}) {
  const adapter = CATALOG_ADAPTERS[catalogProviderForSource(sourceId)];
  const json = await requestJson(adapter.searchRequest(query), options);
  return adapter.parseSearch(json).map(item => ({ ...item, sourceId: String(sourceId || '') }));
}

export async function listModelFiles(sourceId, repoId, options = {}) {
  const adapter = CATALOG_ADAPTERS[catalogProviderForSource(sourceId)];
  const revision = adapter.revision;
  const json = await requestJson(adapter.filesRequest(repoId, revision), options);
  return adapter.parseFiles(json, repoId, revision);
}
