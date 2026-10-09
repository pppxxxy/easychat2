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

// —— C4 传输健壮性 ——
// JSON API 单请求超时；codeload zip 整包下载超时（6MB 级，给足 90s）。
export const API_TIMEOUT_MS = 15000;
export const ZIP_TIMEOUT_MS = 90000;
// 可重试错误（429 / 403 限流 / 5xx / 网络断流）的退避表：1s / 2s / 4s，最多 3 次。
export const GITHUB_RETRY_DELAYS = Object.freeze([1000, 2000, 4000]);
// Retry-After 优先于退避表，但封顶——服务端说等 1 小时也不能把用户吊死。
export const RETRY_AFTER_CAP_MS = 30000;

function fail(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

// 读 Retry-After（秒数形态优先；HTTP 日期形态折算，解析不了当 0 = 用退避表）。
function retryAfterMsFrom(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (raw === null || raw === undefined || raw === '') return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(String(raw));
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

// 纯函数：这次失败要不要重试、等多久（毫秒）；null = 不重试（直接抛给上层）。
// 只有显式标记 retryable 的错误才进重试；Retry-After 优先但封顶。
export function retryDelayFor(error, retryCount, delays = GITHUB_RETRY_DELAYS) {
  if (!error || error.retryable !== true) return null;
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount >= delays.length) return null;
  const backoff = delays[retryCount];
  const after = Number(error.retryAfterMs);
  if (Number.isFinite(after) && after > 0) return Math.min(Math.max(after, backoff), RETRY_AFTER_CAP_MS);
  return backoff;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 单次 fetch + 超时中止：RN 的 fetch 不会自己超时，没有 AbortController 就会挂死
//（网络切换时尤其明显）。中止/断流/超时统一归一成可重试的 NETWORK 错误。
async function fetchOnce(fetchImpl, url, { method = 'GET', token, body, headers, timeoutMs = API_TIMEOUT_MS } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, {
      method,
      headers: { ...buildHeaders(token), ...(headers || {}) },
      ...(body !== undefined ? { body } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    throw fail(
      'NETWORK',
      `GitHub request failed: ${String((error && error.message) || error)}`,
      { retryable: true, cause: error }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const retryAfterMs = retryAfterMsFrom(headers);
  if (status === 401) return fail('AUTH', 'GitHub rejected the token (401)');
  if (status === 403 && remaining === '0') {
    return fail('RATE_LIMIT', 'GitHub rate limit exceeded (403)', { retryable: true, retryAfterMs });
  }
  if (status === 403) return fail('FORBIDDEN', `GitHub refused the request (403)${bodyText ? `: ${bodyText}` : ''}`);
  if (status === 404) return fail('NOT_FOUND', 'Repository or branch not found (404)');
  if (status === 409) return fail('CONFLICT', 'Repository is not empty (409)');
  if (status === 422) return fail('INVALID', `GitHub rejected the input (422)${bodyText ? `: ${bodyText}` : ''}`);
  if (status === 429) return fail('RATE_LIMIT', 'GitHub rate limit exceeded (429)', { retryable: true, retryAfterMs });
  return fail('HTTP', `GitHub request failed (HTTP ${status})`, { retryable: status >= 500 });
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

// JSON API 的统一传输层（C4）：超时 + 可重试错误退避。导出让测试与
// 未来的流式调用复用；公开 API 全部经它。sleepImpl 可注入（测试零等待）。
// E5：accept（自定义 Accept 头）/ parse='text'（diff 等纯文本响应）——默认行为
// 与旧版逐字节一致（无 accept 无 text 时不发额外头、仍走 JSON）。
export async function request(fetchImpl, url, {
  method = 'GET',
  token,
  body,
  accept = '',
  parse = 'json',
  timeoutMs = API_TIMEOUT_MS,
  retryDelays = GITHUB_RETRY_DELAYS,
  sleepImpl = defaultSleep,
} = {}) {
  const jsonBody = body ? JSON.stringify(body) : undefined;
  const baseHeaders = body ? { 'Content-Type': 'application/json' } : {};
  const headers = accept ? { ...baseHeaders, Accept: accept } : (body ? baseHeaders : undefined);
  for (let retryCount = 0; ; retryCount += 1) {
    let response;
    try {
      response = await fetchOnce(fetchImpl, url, { method, token, body: jsonBody, headers, timeoutMs });
    } catch (error) {
      const delay = retryDelayFor(error, retryCount, retryDelays);
      if (delay === null) throw error;
      await sleepImpl(delay);
      continue;
    }
    if (response.ok) {
      const rateLimit = rateLimitFrom(response.headers);
      if (response.status === 204) return { data: null, rateLimit };
      if (parse === 'text') {
        const text = await response.text().catch(() => '');
        return { data: typeof text === 'string' ? text : '', rateLimit };
      }
      const data = await response.json().catch(() => null);
      return { data, rateLimit };
    }
    let bodyText = '';
    try {
      const parsed = await response.json();
      bodyText = parsed && parsed.message ? String(parsed.message) : '';
    } catch (error) {}
    const mapped = mapGithubError(response.status, { headers: response.headers, bodyText });
    const delay = retryDelayFor(mapped, retryCount, retryDelays);
    if (delay === null) throw mapped;
    await sleepImpl(delay);
  }
}

// codeload zip 整包下载（C4）：同样走超时 + 断流整包重试（默认重下 1 次——
// 6MB 秒级，比让用户手动重点便宜）。返回 response（调用方读 content-length /
// arrayBuffer）；HTTP 错误按 mapGithubError 抛。
export async function downloadZip({
  fetchImpl = fetch,
  url,
  token,
  timeoutMs = ZIP_TIMEOUT_MS,
  retries = 1,
  sleepImpl = defaultSleep,
} = {}) {
  for (let retryCount = 0; ; retryCount += 1) {
    let response;
    try {
      response = await fetchOnce(fetchImpl, url, { token, timeoutMs, headers: { Accept: 'application/zip' } });
    } catch (error) {
      if (retryCount >= retries) throw error;
      await sleepImpl(GITHUB_RETRY_DELAYS[0]);
      continue;
    }
    if (!response.ok) {
      let bodyText = '';
      try {
        const parsed = await response.json();
        bodyText = parsed && parsed.message ? String(parsed.message) : '';
      } catch (error) {}
      const mapped = mapGithubError(response.status, { headers: response.headers, bodyText });
      if (mapped.retryable !== true || retryCount >= retries) throw mapped;
      await sleepImpl(GITHUB_RETRY_DELAYS[0]);
      continue;
    }
    return response;
  }
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

// C1 清单先行：一次拿全树（git/trees recursive=1；GitHub 单次约 10 万条上限）。
// truncated=true（超大树）时**如实返回标记**——调用方降级提示，不假装拿全。
// 备注：不做「逐层拉子树」降级——手机端限流风险大且 truncated 是极端场景，
// 诚实提示 + 建议完整拉取更稳（审查待办已登记该取舍）。
export async function listTree({ fetchImpl = fetch, token, owner, repo, ref } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const { data } = await request(fetchImpl, url, { token });
  const tree = Array.isArray(data && data.tree) ? data.tree : [];
  return {
    truncated: Boolean(data && data.truncated === true),
    entries: tree
      .map(item => ({
        path: String((item && item.path) || ''),
        type: String((item && item.type) || ''),
        sha: String((item && item.sha) || ''),
        size: Number(item && item.size) || 0,
      }))
      .filter(item => item.path && (item.type === 'blob' || item.type === 'tree')),
  };
}

// —— E5：Git 历史浏览（纯 API 补全）——

// 提交列表 URL：branch 可选（不传 = 仓库默认分支）。per_page 收敛到 50。
export function buildCommitsUrl({ owner, repo, branch = '', page = 1, perPage = 30 } = {}) {
  const size = Math.min(Math.max(1, Math.floor(Number(perPage)) || 30), 50);
  const pageNo = Math.max(1, Math.floor(Number(page)) || 1);
  const sha = branch ? `&sha=${encodeURIComponent(branch)}` : '';
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${size}&page=${pageNo}${sha}`;
}

// 提交列表：只留 UI 需要的字段（sha/首行 message/作者/日期），GitHub 原始对象不散到各处。
export async function listCommits({ fetchImpl = fetch, token, owner, repo, branch, page = 1, perPage = 30 } = {}) {
  const url = buildCommitsUrl({ owner, repo, branch, page, perPage });
  const { data } = await request(fetchImpl, url, { token });
  return (Array.isArray(data) ? data : [])
    .map(item => {
      const commit = (item && item.commit) || {};
      const author = commit.author || {};
      return {
        sha: String((item && item.sha) || ''),
        message: String(commit.message || '').split('\n')[0],
        author: String(author.name || ''),
        date: String(author.date || ''),
      };
    })
    .filter(item => item.sha);
}

// 单个提交的 diff（纯文本，Accept: vnd.github.diff——GitHub 会直接返回 unified diff）。
export async function getCommitDiff({ fetchImpl = fetch, token, owner, repo, sha } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
  const { data } = await request(fetchImpl, url, { token, accept: 'application/vnd.github.diff', parse: 'text' });
  return typeof data === 'string' ? data : '';
}

// 创建 PR（写操作——调用方负责确认门与 riskGate 分级；这里只发请求并归一返回值）。
export async function createPullRequest({ fetchImpl = fetch, token, owner, repo, title, head, base, body = '' } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const { data } = await request(fetchImpl, url, {
    method: 'POST',
    token,
    body: { title, head, base, ...(body ? { body } : {}) },
  });
  return {
    number: Number(data && data.number) || 0,
    url: String((data && data.html_url) || ''),
    title: String((data && data.title) || ''),
  };
}

// diff 大文本截断（E5）：复用 D2 的「头 3/4 + 尾 1/4」形状——diff 的要点（改了哪些
// 文件的摘要）常在中段后的 hunk 头与尾部，只保头会丢诊断信息。默认 64KB。
export function truncateDiffText(text, limit = 64 * 1024) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= limit) return { text: value, truncated: false };
  const tailSize = Math.floor(limit / 4);
  const headSize = limit - tailSize;
  const omitted = value.length - limit;
  return {
    text: `${value.slice(0, headSize)}\n…（diff 过长，中间省略 ${omitted} 字符；可在 GitHub 网页端看完整差异）…\n${value.slice(-tailSize)}`,
    truncated: true,
  };
}

// —— C3 批量单提交（git data API 五步）——
// getRef → createBlob × N → createTree → createCommit → updateRef。
// 全部走 C4 的统一 request（超时 + 退避）；DELETE/JSON 语义由 GitHub 定，
// 这里只做形状归一与必填校验。

// 分支 ref → 当前 commit sha（空串 = 分支不存在/响应异常）。
export async function getRef({ fetchImpl = fetch, token, owner, repo, branch } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`;
  const { data } = await request(fetchImpl, url, { token });
  return String((data && data.object && data.object.sha) || '');
}

// 创建 blob（base64），返回 sha。
export async function createBlob({ fetchImpl = fetch, token, owner, repo, content, encoding = 'base64' } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`;
  const { data } = await request(fetchImpl, url, {
    method: 'POST',
    token,
    body: { content, encoding },
  });
  return String((data && data.sha) || '');
}

// 创建 tree（tree: [{ path, mode, type, sha|null }]），返回 sha。
export async function createTree({ fetchImpl = fetch, token, owner, repo, tree, baseTree } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`;
  const { data } = await request(fetchImpl, url, {
    method: 'POST',
    token,
    body: { tree, ...(baseTree ? { base_tree: baseTree } : {}) },
  });
  return String((data && data.sha) || '');
}

// 创建 commit（单父提交），返回 sha。
export async function createCommit({ fetchImpl = fetch, token, owner, repo, message, tree, parents } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`;
  const { data } = await request(fetchImpl, url, {
    method: 'POST',
    token,
    body: { message, tree, parents: Array.isArray(parents) ? parents : [] },
  });
  return String((data && data.sha) || '');
}

// 更新分支指向（force 恒为 false：非快进被 GitHub 拒绝——绝不覆盖别人的提交）。
export async function updateRef({ fetchImpl = fetch, token, owner, repo, branch, sha } = {}) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`;
  const { data } = await request(fetchImpl, url, {
    method: 'PATCH',
    token,
    body: { sha, force: false },
  });
  return String((data && data.object && data.object.sha) || '') || String(sha || '');
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
