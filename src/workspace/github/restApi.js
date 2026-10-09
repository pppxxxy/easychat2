// GitHub REST 直连（纯函数 + 注入 fetch，Node 直测；v3 六键工作台的后端）。
//
// 为什么直连 REST 而不是只走 MCP：MCP 的工具集是「给 agent 用的」，分级过滤后
// 删除类工具被永久排除；而用户手动管理仓库（建/改名/删）必须在界面上真实可用。
// 两者共用同一份 token（storage/githubMcp.js），不建第二套凭据。
//
// 删除红线（用户裁决，最高优先级）：本模块把红线做成**结构性守卫**，不是靠调用方自觉——
// deleteRepo 必须收到与 `owner/repo` 完全一致的 confirm 才可能发出请求；调用方（UI）
// 还要额外要求用户手动输入仓库名。任何一层缺失都删不掉。
//
// 错误统一成带 code 的 Error，界面按 code 取 i18n 文案（本模块不引 i18n）。

export const GITHUB_API_BASE = 'https://api.github.com';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function buildHeaders(token = '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const value = String(token || '').trim();
  if (value) headers.Authorization = `Bearer ${value}`;
  return headers;
}

// 状态码 → 可诊断的错误码。403 要区分「权限/scope 不足」与「rate limit」：
// GitHub 在 rate limit 时会给 x-ratelimit-remaining: 0。
export function mapGithubError(status, { headers, bodyText } = {}) {
  const remaining = headers && typeof headers.get === 'function' ? headers.get('x-ratelimit-remaining') : null;
  if (status === 401) return fail('AUTH', 'GitHub rejected the token (401)');
  if (status === 403 && remaining === '0') return fail('RATE_LIMIT', 'GitHub rate limit exceeded (403)');
  if (status === 403) return fail('FORBIDDEN', `GitHub refused the request (403)${bodyText ? `: ${bodyText}` : ''}`);
  if (status === 404) return fail('NOT_FOUND', 'Repository or branch not found (404)');
  if (status === 409) return fail('CONFLICT', 'Repository is not empty (409)');
  if (status === 422) return fail('INVALID', `GitHub rejected the input (422)${bodyText ? `: ${bodyText}` : ''}`);
  if (status === 429) return fail('RATE_LIMIT', 'GitHub rate limit exceeded (429)');
  return fail('HTTP', `GitHub request failed (HTTP ${status})`);
}

export function rateLimitFrom(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(remaining)) return null;
  return {
    remaining,
    resetAt: Number.isFinite(reset) ? reset * 1000 : 0,
  };
}

async function request(fetchImpl, url, { method = 'GET', token, body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...buildHeaders(token),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    let bodyText = '';
    try {
      const parsed = await response.json();
      bodyText = parsed && parsed.message ? String(parsed.message) : '';
    } catch (error) {}
    throw mapGithubError(response.status, { headers: response.headers, bodyText });
  }
  const rateLimit = rateLimitFrom(response.headers);
  if (response.status === 204) return { data: null, rateLimit };
  const data = await response.json().catch(() => null);
  return { data, rateLimit };
}

// 仓库条目归一：界面只认这几个字段，不把 GitHub 原始对象散到各处。
export function normalizeRepo(item) {
  const source = item && typeof item === 'object' ? item : {};
  const fullName = String(source.full_name || '');
  const [owner, repo] = fullName.split('/');
  return {
    id: source.id || fullName,
    owner: owner || '',
    repo: repo || String(source.name || ''),
    fullName,
    defaultBranch: String(source.default_branch || 'main'),
    isPrivate: source.private === true,
    language: String(source.language || ''),
    pushedAt: source.pushed_at ? String(source.pushed_at).slice(0, 10) : '',
  };
}

export function buildReposUrl({ page = 1, perPage = 50, affiliation = 'owner,collaborator' } = {}) {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePer = Math.min(100, Math.max(1, Number(perPage) || 50));
  return `${GITHUB_API_BASE}/user/repos?sort=pushed&per_page=${safePer}&visibility=all&affiliation=${encodeURIComponent(affiliation)}&page=${safePage}`;
}

export async function listRepos({ fetchImpl = fetch, token, page = 1, perPage = 50 } = {}) {
  const { data, rateLimit } = await request(fetchImpl, buildReposUrl({ page, perPage }), { token });
  const list = Array.isArray(data) ? data.map(normalizeRepo) : [];
  return { repos: list, hasMore: list.length >= perPage, rateLimit };
}

export async function getRepo({ fetchImpl = fetch, token, owner, repo } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const { data } = await request(fetchImpl, url, { token });
  return normalizeRepo(data);
}

export async function listBranches({ fetchImpl = fetch, token, owner, repo, page } = {}) {
  // page（B1）：分支超过一页（100 个）时 UI 会翻到第 2 页。只认 >=2 的整数——
  // 默认请求不带 page 参数（URL 与旧版逐字节一致，已有测试钉着它）。
  const pageQuery = Number.isInteger(page) && page > 1 ? `&page=${page}` : '';
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100${pageQuery}`;
  const { data } = await request(fetchImpl, url, { token });
  return Array.isArray(data) ? data.map(item => String(item && item.name || '')).filter(Boolean) : [];
}

// 建仓库：成功后即成为「当前仓库」（由调用方落状态）。
export async function createRepo({ fetchImpl = fetch, token, name, description = '', isPrivate = true, autoInit = false } = {}) {
  const repoName = String(name || '').trim();
  if (!repoName) throw fail('INVALID_NAME', 'Repository name is required');
  const { data } = await request(fetchImpl, `${GITHUB_API_BASE}/user/repos`, {
    method: 'POST',
    token,
    body: {
      name: repoName,
      ...(String(description || '').trim() ? { description: String(description).trim() } : {}),
      private: isPrivate === true,
      auto_init: autoInit === true,
    },
  });
  return normalizeRepo(data);
}

export async function renameRepo({ fetchImpl = fetch, token, owner, repo, newName } = {}) {
  const next = String(newName || '').trim();
  if (!next) throw fail('INVALID_NAME', 'New repository name is required');
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const { data } = await request(fetchImpl, url, { method: 'PATCH', token, body: { name: next } });
  return normalizeRepo(data);
}

// 删除仓库——**红线**。confirm 必须与 owner/repo 逐字相同，否则连请求都不发。
// 调用方（⑥ 仓库管理滑层）另外要求用户手动输入完整仓库名，这是第二层。
export async function deleteRepo({ fetchImpl = fetch, token, owner, repo, confirm } = {}) {
  const fullName = `${owner}/${repo}`;
  if (String(confirm || '') !== fullName) {
    throw fail('DELETE_CONFIRM_REQUIRED', `Deleting ${fullName} requires confirm="${fullName}"`);
  }
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  await request(fetchImpl, url, { method: 'DELETE', token });
  return { deleted: true, fullName };
}

// token 的 scope 列表（PAT 在 x-oauth-scopes 头里返回；OAuth App token 同）。
export async function fetchTokenScopes({ fetchImpl = fetch, token } = {}) {
  const response = await fetchImpl(`${GITHUB_API_BASE}/user`, { headers: buildHeaders(token) });
  if (!response.ok) throw mapGithubError(response.status, { headers: response.headers });
  const raw = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('x-oauth-scopes')
    : '';
  return String(raw || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function canDeleteRepo(scopes) {
  return (Array.isArray(scopes) ? scopes : []).includes('delete_repo');
}

export function repoWebUrl(owner, repo) {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
