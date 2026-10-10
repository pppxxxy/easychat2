// GitHub REST 层（六键工作台后端）纯函数测试：注入 fetch，Node 直测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildCommitsUrl,
  buildHeaders,
  buildReposUrl,
  canDeleteRepo,
  createPullRequest,
  createRepo,
  deleteRepo,
  dispatchWorkflow,
  downloadRunLogs,
  downloadZip,
  fetchTokenScopes,
  getCommitDiff,
  getWorkflowRun,
  GITHUB_RETRY_DELAYS,
  listBranches,
  listCommits,
  listRepos,
  listTree,
  listWorkflowRuns,
  mapGithubError,
  mergeRunLogZip,
  normalizeRepo,
  normalizeWorkflowRun,
  rateLimitFrom,
  renameRepo,
  repoWebUrl,
  request,
  RETRY_AFTER_CAP_MS,
  retryDelayFor,
  truncateDiffText,
} from '../src/workspace/github/restApi.js';
import { strToU8, zipSync } from 'fflate';

function makeResponse(status, data, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => (map.has(String(key).toLowerCase()) ? map.get(String(key).toLowerCase()) : null) },
    json: async () => data,
  };
}

test('normalizeRepo / buildReposUrl / buildHeaders', () => {
  const repo = normalizeRepo({
    id: 7,
    full_name: 'pppxxxy/easychat2',
    default_branch: 'main',
    private: true,
    language: 'JavaScript',
    pushed_at: '2026-10-07T12:00:00Z',
  });
  assert.deepEqual(repo, {
    id: 7,
    owner: 'pppxxxy',
    repo: 'easychat2',
    fullName: 'pppxxxy/easychat2',
    defaultBranch: 'main',
    isPrivate: true,
    language: 'JavaScript',
    pushedAt: '2026-10-07',
  });
  assert.match(buildReposUrl({ page: 2 }), /\/user\/repos\?.*page=2$/);
  assert.match(buildReposUrl({ perPage: 999 }), /per_page=100/, 'per_page 收敛到 100');
  assert.ok(buildHeaders('t').Authorization === 'Bearer t');
  assert.equal(buildHeaders('').Authorization, undefined);
  assert.equal(repoWebUrl('a', 'b'), 'https://github.com/a/b');
});

test('B1 listBranches：默认一页；page>=2 才带分页参数（缺省 URL 逐字节不变）', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    return makeResponse(200, [{ name: 'main' }, { name: 'develop' }, { name: '' }]);
  };
  const names = await listBranches({ fetchImpl, token: 't', owner: 'a', repo: 'b' });
  assert.deepEqual(names, ['main', 'develop'], '空名字条目被过滤');
  assert.equal(calls[0], 'https://api.github.com/repos/a/b/branches?per_page=100');

  await listBranches({ fetchImpl, token: 't', owner: 'a', repo: 'b', page: 2 });
  assert.equal(calls[1], 'https://api.github.com/repos/a/b/branches?per_page=100&page=2');
  await listBranches({ fetchImpl, token: 't', owner: 'a', repo: 'b', page: 1 });
  assert.equal(calls[2], 'https://api.github.com/repos/a/b/branches?per_page=100', 'page=1 等同缺省');
});

test('C1 listTree：recursive 一次拿全树；truncated 如实标记；非 blob/tree 过滤', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    return makeResponse(200, {
      truncated: false,
      tree: [
        { path: 'src', type: 'tree', sha: 't1' },
        { path: 'src/a.js', type: 'blob', sha: 'b1', size: 10 },
        { path: 'README.md', type: 'blob', sha: 'b2', size: 5 },
        { path: 'sub', type: 'commit', sha: 'c1' },
        { path: '', type: 'blob', sha: 'x' },
      ],
    });
  };
  const result = await listTree({ fetchImpl, token: 't', owner: 'a', repo: 'b', ref: 'main' });
  assert.equal(calls[0], 'https://api.github.com/repos/a/b/git/trees/main?recursive=1');
  assert.deepEqual(result.entries, [
    { path: 'src', type: 'tree', sha: 't1', size: 0 },
    { path: 'src/a.js', type: 'blob', sha: 'b1', size: 10 },
    { path: 'README.md', type: 'blob', sha: 'b2', size: 5 },
  ], '非 blob/tree 与空路径被过滤');
  assert.equal(result.truncated, false);

  const big = await listTree({
    fetchImpl: async () => makeResponse(200, { truncated: true, tree: [] }),
    ref: 'main',
  });
  assert.equal(big.truncated, true, '超大树如实标记，不假装拿全');
  assert.deepEqual(big.entries, []);
});

test('C4 retryDelayFor：只有 retryable 才退避；Retry-After 优先且封顶；最多 3 次', () => {
  assert.equal(retryDelayFor({ code: 'AUTH' }, 0), null, '不可重试 = 直接抛');
  assert.equal(retryDelayFor({ retryable: true }, -1), null);
  const rate = { retryable: true, retryAfterMs: 0 };
  assert.equal(retryDelayFor(rate, 0), GITHUB_RETRY_DELAYS[0]);
  assert.equal(retryDelayFor(rate, 1), GITHUB_RETRY_DELAYS[1]);
  assert.equal(retryDelayFor(rate, 2), GITHUB_RETRY_DELAYS[2]);
  assert.equal(retryDelayFor(rate, 3), null, '最多 3 次重试（1s/2s/4s）');
  // Retry-After 优先于退避表，但封顶（服务端说等 1 小时也不吊死）
  assert.equal(retryDelayFor({ retryable: true, retryAfterMs: 5000 }, 0), 5000);
  assert.equal(retryDelayFor({ retryable: true, retryAfterMs: 9e9 }, 0), RETRY_AFTER_CAP_MS);
  assert.equal(retryDelayFor({ retryable: true, retryAfterMs: 1 }, 0), GITHUB_RETRY_DELAYS[0], '比退避表还短时取退避表');
});

test('C4 request：429 带 Retry-After 退避后成功；不可重试错误一次即抛', async () => {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async () => {
    calls.push(Date.now());
    if (calls.length === 1) return makeResponse(429, { message: 'rate' }, { 'retry-after': '2' });
    return makeResponse(200, { ok: true });
  };
  const result = await request(fetchImpl, 'https://api.github.com/x', {
    token: 't',
    sleepImpl: async ms => { sleeps.push(ms); },
  });
  assert.equal(calls.length, 2, '退避后重发一次');
  assert.deepEqual(sleeps, [2000], '按 Retry-After 等待（2s）');
  assert.deepEqual(result.data, { ok: true });

  // 401 不可重试：只请求一次
  let authCalls = 0;
  await assert.rejects(
    request(async () => { authCalls += 1; return makeResponse(401, { message: 'bad' }); }, 'https://api.github.com/x', {
      sleepImpl: async () => {},
    }),
    error => error.code === 'AUTH'
  );
  assert.equal(authCalls, 1, '不可重试错误不重发');

  // 5xx 重试到上限后抛最后一个错误（退避表耗尽）
  let httpCalls = 0;
  await assert.rejects(
    request(async () => { httpCalls += 1; return makeResponse(500, { message: 'boom' }); }, 'https://api.github.com/x', {
      sleepImpl: async () => {},
    }),
    error => error.code === 'HTTP' && error.retryable === true
  );
  assert.equal(httpCalls, 1 + GITHUB_RETRY_DELAYS.length, '1 次首请求 + 3 次重试');
});

test('C4 超时：挂起的 fetch 被 AbortController 中止（不挂死、归一为 NETWORK）', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }
  });
  const startedAt = Date.now();
  await assert.rejects(
    request(fetchImpl, 'https://api.github.com/x', {
      timeoutMs: 30,
      retryDelays: [],
      sleepImpl: async () => {},
    }),
    error => error.code === 'NETWORK' && error.retryable === true
  );
  assert.ok(Date.now() - startedAt < 2000, '超时被中止而不是挂死');
});

test('C4 downloadZip：断流整包重试 1 次；HTTP 错误按 mapGithubError 抛', async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('socket reset');
    return makeResponse(200, null, { 'content-length': '10' });
  };
  const response = await downloadZip({
    fetchImpl: flaky,
    url: 'https://codeload.example/z',
    sleepImpl: async () => {},
  });
  assert.equal(attempts, 2, '断流后整包重下 1 次');
  assert.equal(response.status, 200);

  // 404 不可重试：一次即抛 NOT_FOUND
  let notFoundCalls = 0;
  await assert.rejects(
    downloadZip({
      fetchImpl: async () => { notFoundCalls += 1; return makeResponse(404, { message: 'no' }); },
      url: 'https://codeload.example/z',
      sleepImpl: async () => {},
    }),
    error => error.code === 'NOT_FOUND'
  );
  assert.equal(notFoundCalls, 1);

  // 断流两次（超过 retries=1）：第二次仍抛出
  let flaky2 = 0;
  await assert.rejects(
    downloadZip({
      fetchImpl: async () => { flaky2 += 1; throw new Error('reset again'); },
      url: 'https://codeload.example/z',
      sleepImpl: async () => {},
    }),
    error => error.code === 'NETWORK'
  );
  assert.equal(flaky2, 2, '重试 1 次后仍失败即抛');
});

test('mapGithubError：401/403(限额 vs 权限)/404/409/422/429', () => {
  assert.equal(mapGithubError(401).code, 'AUTH');
  assert.equal(mapGithubError(403, { headers: { get: () => '0' } }).code, 'RATE_LIMIT', 'remaining=0 是限额');
  assert.equal(mapGithubError(403, { headers: { get: () => '42' } }).code, 'FORBIDDEN', '否则是权限/scope');
  assert.equal(mapGithubError(404).code, 'NOT_FOUND');
  assert.equal(mapGithubError(409).code, 'CONFLICT');
  assert.equal(mapGithubError(422, { bodyText: 'name already exists' }).code, 'INVALID');
  assert.equal(mapGithubError(429).code, 'RATE_LIMIT');
  assert.equal(mapGithubError(500).code, 'HTTP');
});

test('rateLimitFrom：解析剩余配额与重置时间', () => {
  const headers = { get: key => (key === 'x-ratelimit-remaining' ? '12' : (key === 'x-ratelimit-reset' ? '1700000000' : null)) };
  assert.deepEqual(rateLimitFrom(headers), { remaining: 12, resetAt: 1700000000000 });
  assert.equal(rateLimitFrom(null), null);
});

test('listRepos：归一 + hasMore；错误码透传', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return makeResponse(200, [
      { id: 1, full_name: 'a/one', default_branch: 'main' },
      { id: 2, full_name: 'b/two', default_branch: 'dev' },
    ], { 'x-ratelimit-remaining': '59' });
  };
  const result = await listRepos({ fetchImpl, token: 't', page: 1, perPage: 2 });
  assert.equal(result.repos.length, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.rateLimit.remaining, 59);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer t');

  const failing = async () => makeResponse(401, { message: 'Bad credentials' });
  await assert.rejects(listRepos({ fetchImpl: failing, token: 'bad' }), error => error.code === 'AUTH');
});

test('createRepo：POST 正确 body；空名直接拒绝', async () => {
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return makeResponse(201, { id: 9, full_name: 'me/newrepo', default_branch: 'main' });
  };
  const repo = await createRepo({ fetchImpl, token: 't', name: 'newrepo', description: ' d ', isPrivate: true, autoInit: true });
  assert.equal(repo.fullName, 'me/newrepo');
  assert.equal(seen.url, 'https://api.github.com/user/repos');
  assert.equal(seen.options.method, 'POST');
  assert.deepEqual(JSON.parse(seen.options.body), { name: 'newrepo', description: 'd', private: true, auto_init: true });

  await assert.rejects(createRepo({ fetchImpl, token: 't', name: '   ' }), error => error.code === 'INVALID_NAME');
});

test('renameRepo：PATCH body.name', async () => {
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return makeResponse(200, { id: 1, full_name: 'me/renamed', default_branch: 'main' });
  };
  const repo = await renameRepo({ fetchImpl, token: 't', owner: 'me', repo: 'old', newName: 'renamed' });
  assert.equal(repo.repo, 'renamed');
  assert.equal(seen.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(seen.options.body), { name: 'renamed' });
});

test('deleteRepo：confirm 不匹配则连请求都不发（红线守卫）', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return makeResponse(204, null); };

  await assert.rejects(
    deleteRepo({ fetchImpl, token: 't', owner: 'me', repo: 'gone' }),
    error => error.code === 'DELETE_CONFIRM_REQUIRED'
  );
  await assert.rejects(
    deleteRepo({ fetchImpl, token: 't', owner: 'me', repo: 'gone', confirm: 'me/other' }),
    error => error.code === 'DELETE_CONFIRM_REQUIRED'
  );
  assert.equal(called, 0, '不匹配时绝不发出删除请求');

  const result = await deleteRepo({ fetchImpl, token: 't', owner: 'me', repo: 'gone', confirm: 'me/gone' });
  assert.deepEqual(result, { deleted: true, fullName: 'me/gone' });
  assert.equal(called, 1);
});

test('fetchTokenScopes / canDeleteRepo：读 x-oauth-scopes', async () => {
  const fetchImpl = async () => makeResponse(200, { login: 'me' }, { 'x-oauth-scopes': 'repo, delete_repo, workflow' });
  const scopes = await fetchTokenScopes({ fetchImpl, token: 't' });
  assert.deepEqual(scopes, ['repo', 'delete_repo', 'workflow']);
  assert.equal(canDeleteRepo(scopes), true);

  const noDelete = async () => makeResponse(200, { login: 'me' }, { 'x-oauth-scopes': 'repo' });
  assert.equal(canDeleteRepo(await fetchTokenScopes({ fetchImpl: noDelete, token: 't' })), false);
  assert.equal(canDeleteRepo([]), false);
});

// ---- 面板接线（源码断言；RN 组件在 Node 里渲染不了） ----

const PANEL_SRC = fs.readFileSync(path.resolve('src/workspace/screen/GithubPanel.js'), 'utf8');

test('GithubPanel：四键工具条 + 仓库列表 + 当前仓库树 + 搜索（Stage 3a）', () => {
  assert.ok(PANEL_SRC.includes('workspace.github.toolbar.repos'), '① 仓库列表键');
  assert.ok(PANEL_SRC.includes('workspace.github.toolbar.importLocal'), '② 导入本地文件键');
  assert.ok(PANEL_SRC.includes('workspace.github.toolbar.newEntry'), '③ 新建键');
  assert.ok(PANEL_SRC.includes('workspace.github.toolbar.refresh'), '④ 刷新键');
  assert.ok(PANEL_SRC.includes('listRepos('), '仓库列表走 REST');
  assert.ok(PANEL_SRC.includes('directoryChildren(') && PANEL_SRC.includes('breadcrumbsOf('), '当前仓库树逐层下钻');
  assert.ok(PANEL_SRC.includes('workspace.github.search.placeholder'), '搜索框');
  assert.ok(PANEL_SRC.includes('DocumentPicker'), '导入本地文件用系统选择器');
  assert.ok(PANEL_SRC.includes('createWorkspaceDirectory(') && PANEL_SRC.includes('writeWorkspaceFile('), '新建文件/文件夹落盘');
  assert.ok(PANEL_SRC.includes('refreshLocal') && PANEL_SRC.includes('loadRepos(1)'), '④ 刷新：重扫本地树 + 重拉列表');
  assert.ok(!/<Modal/.test(PANEL_SRC), '面板内不再有 Modal（二级层都是面板内的层）');
  assert.ok(PANEL_SRC.includes('workspace.github.push.summary'), '底部推送条显示待同步增删');
});

test('GithubPanel：⑤⑥ + 删除三层守卫（Stage 3b）', () => {
  assert.ok(PANEL_SRC.includes('workspace.github.toolbar.createRepo'), '⑤ 新建仓库键');
  assert.ok(PANEL_SRC.includes('workspace.github.toolbar.manage'), '⑥ 仓库管理键');
  assert.ok(PANEL_SRC.includes('createRepo('), '建仓库走 REST');
  assert.ok(PANEL_SRC.includes('renameRepo('), '重命名走 REST');
  assert.ok(PANEL_SRC.includes('deleteRepo('), '删除走 REST');
  // 红线三层，缺一不可：
  // ① UI：必须手动输入完整仓库名（按钮的禁用条件就是它）
  assert.ok(
    /disabled=\{deleteConfirm\.trim\(\) !== `\$\{current\.owner\}\/\$\{current\.repo\}`\}/.test(PANEL_SRC),
    '① 手动输完整仓库名才可点删除'
  );
  // ② 权限：token 必须带 delete_repo scope，没有就只显示引导
  assert.ok(PANEL_SRC.includes('canDeleteRepo(scopes)'), '② token scope 检查');
  assert.ok(PANEL_SRC.includes('workspace.github.manage.deleteNoScope'), '② 无 scope 时的明确引导');
  // ③ 后端：restApi.deleteRepo 的 confirm 逐字守卫（单测已证「不匹配不发请求」）
  assert.ok(
    /deleteRepo\(\{ token, owner: current\.owner, repo: current\.repo, confirm: fullName \}\)/.test(PANEL_SRC),
    '③ 后端 confirm 守卫'
  );
  assert.ok(PANEL_SRC.includes('repoWebUrl('), '复制仓库链接');
  // 面板不删本地文件（远端删除不会连带删本地副本）。
  assert.ok(!PANEL_SRC.includes('deleteFile('), '不自动删本地副本');
});

test('GithubPanel：快照 diff + 一键交接给助手推送', () => {
  assert.ok(PANEL_SRC.includes('diffRepoSnapshot('), '待同步由快照 diff 算出（不是假数字）');
  assert.ok(PANEL_SRC.includes('getRepoSnapshot(') && PANEL_SRC.includes('setRepoSnapshot('), '基线读写存储域');
  assert.ok(PANEL_SRC.includes('localRepoPaths('), '拉取成功后用实际清单刷新基线');
  assert.ok(PANEL_SRC.includes('workspace.github.push.none'), '无待同步时如实显示');
  assert.ok(PANEL_SRC.includes('workspace.github.push.contentNote'), '如实标注「内容改动判定不了」');
  assert.ok(PANEL_SRC.includes('workspace.github.push.handoff') && PANEL_SRC.includes('onHandoff('),
    '一键交接把指令交给对话面板');
  assert.ok(PANEL_SRC.includes('workspace.github.push.instructionHead'), '交接指令含仓库与分支');
  assert.ok(PANEL_SRC.includes('workspace.github.push.markSynced'), '推送成功后手动确认新基线');
  // 本面板不直连推送：写远端一律经助手 + 逐条确认（面板里不得出现 MCP 推送调用）。
  assert.ok(!PANEL_SRC.includes('push_files'), '面板不直接调 GitHub 推送');
});

test('E5 listCommits / getCommitDiff / createPullRequest：URL、归一、文本响应、Accept', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    if (url.includes('/commits?')) {
      return makeResponse(200, [
        {
          sha: 'abc123',
          commit: {
            message: 'feat: 首页改版\n\n详细说明只取首行',
            author: { name: 'ppp', date: '2026-10-10T08:00:00Z' },
          },
        },
        { sha: 'def456', commit: { message: 'fix: 崩溃', author: { name: 'ppp', date: '2026-10-09T08:00:00Z' } } },
        { sha: '' },
      ]);
    }
    if (url.includes('/commits/abc123')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b',
      };
    }
    if (url.endsWith('/pulls')) {
      return makeResponse(201, { number: 42, html_url: 'https://github.com/o/r/pull/42', title: 'D 系上主' });
    }
    return makeResponse(404, {});
  };

  // 提交列表：URL 形态（分支/翻页）+ 归一（message 只取首行、空 sha 剔除）
  assert.match(
    buildCommitsUrl({ owner: 'o', repo: 'r', branch: 'main', page: 2 }),
    /\/repos\/o\/r\/commits\?per_page=30&page=2&sha=main$/
  );
  const commits = await listCommits({ fetchImpl, token: 't', owner: 'o', repo: 'r', branch: 'main', page: 2 });
  assert.match(calls[0].url, /per_page=30&page=2&sha=main$/);
  assert.equal(commits.length, 2, '空 sha 条目被剔除');
  assert.deepEqual(commits[0], {
    sha: 'abc123',
    message: 'feat: 首页改版',
    author: 'ppp',
    date: '2026-10-10T08:00:00Z',
  });

  // diff：Accept 换 diff 媒体类型 + 走 text()（不是 json()）
  const diff = await getCommitDiff({ fetchImpl, token: 't', owner: 'o', repo: 'r', sha: 'abc123' });
  assert.match(diff, /^diff --git/);
  assert.equal(calls[1].headers.Accept, 'application/vnd.github.diff', '媒体类型精确');

  // PR：POST + body 字段（写操作——确认门在 UI 层，restApi 只发请求）
  const pr = await createPullRequest({
    fetchImpl,
    token: 't',
    owner: 'o',
    repo: 'r',
    title: 'D 系上主',
    head: 'c1009c23',
    base: 'main',
  });
  assert.equal(calls[2].method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].body), { title: 'D 系上主', head: 'c1009c23', base: 'main' });
  assert.deepEqual(pr, { number: 42, url: 'https://github.com/o/r/pull/42', title: 'D 系上主' });
});

test('E5 truncateDiffText：头 3/4 + 尾 1/4 长度守恒、小 diff 原样、坏输入安全', () => {
  assert.deepEqual(truncateDiffText('short'), { text: 'short', truncated: false });
  const source = `${'h'.repeat(15)}${'t'.repeat(5)}`;
  const big = truncateDiffText(source, 10);
  assert.equal(big.truncated, true);
  assert.ok(big.text.startsWith('h'.repeat(8)), '头 8 = limit 的 3/4');
  assert.ok(big.text.endsWith('t'.repeat(2)), '尾 2 = limit 的 1/4');
  assert.match(big.text, /中间省略 10 字符/, '省略量标明');
  assert.match(big.text, /GitHub 网页端/, '给出看完整差异的通路');
  assert.equal(truncateDiffText(null).text, '');
  assert.equal(truncateDiffText(undefined).truncated, false);
});

test('H1 Actions 云构建：dispatch/list/get 的 URL 与归一', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith('/dispatches')) return { ok: true, status: 204, headers: { get: () => null }, json: async () => null };
    if (url.includes('/runs?')) {
      return makeResponse(200, {
        workflow_runs: [
          {
            id: 11,
            name: 'CI',
            display_title: 'feat: x',
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            head_sha: 'abcdef1234567890',
            created_at: '2026-10-10T08:00:00Z',
            event: 'workflow_dispatch',
            html_url: 'https://github.com/o/r/actions/runs/11',
          },
          { id: 0 },
        ],
      });
    }
    if (url.includes('/actions/runs/11')) {
      return makeResponse(200, { id: 11, status: 'in_progress', head_branch: 'main' });
    }
    return makeResponse(404, {});
  };

  // dispatch：POST + ref/inputs（204 成功拿不到 run id）
  assert.deepEqual(
    await dispatchWorkflow({ fetchImpl, token: 't', owner: 'o', repo: 'r', workflow: 'ci.yml', ref: 'main', inputs: { target: 'app' } }),
    { ok: true }
  );
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/actions\/workflows\/ci\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(calls[0].body), { ref: 'main', inputs: { target: 'app' } });

  // list：不带 workflow 走全仓库 runs；归一（sha 截断、空条目剔除）
  const runs = await listWorkflowRuns({ fetchImpl, token: 't', owner: 'o', repo: 'r', branch: 'main', page: 2 });
  assert.match(calls[1].url, /\/actions\/runs\?per_page=20&page=2&branch=main$/);
  assert.equal(runs.length, 1, 'id=0 的条目剔除');
  assert.equal(runs[0].sha, 'abcdef1');
  assert.equal(runs[0].conclusion, 'failure');

  // list：带 workflow 走 workflow 范围
  await listWorkflowRuns({ fetchImpl, token: 't', owner: 'o', repo: 'r', workflow: 'ci.yml' });
  assert.match(calls[2].url, /\/actions\/workflows\/ci\.yml\/runs\?/);

  // get：单 run 状态轮询
  const run = await getWorkflowRun({ fetchImpl, token: 't', owner: 'o', repo: 'r', runId: 11 });
  assert.equal(run.status, 'in_progress');
  assert.equal(run.branch, 'main');
});

test('H1 日志 zip：按 job 合并 / 非 zip 兜底 / downloadRunLogs 端到端与截断', async () => {
  // mergeRunLogZip：GitHub logs 是 zip（<job>/1_step.txt 形态）——按 job 分组合并
  const zip = zipSync({
    'test/1_setup.txt': strToU8('setup line'),
    'test/2_run.txt': strToU8('test failed: expect 1 got 2'),
    'build/1_build.txt': strToU8('build ok'),
  });
  const merged = mergeRunLogZip(zip);
  assert.deepEqual(merged.jobs.map(item => item.name), ['build', 'test'], 'job 按名字排序');
  assert.ok(merged.text.includes('### build'), '合并文本带 job 头');
  assert.ok(merged.text.includes('test failed: expect 1 got 2'), '诊断内容在');
  // 非 zip（端点行为变化）→ 纯文本兜底，不丢信息
  const plain = mergeRunLogZip(strToU8('plain log text'));
  assert.equal(plain.jobs.length, 0);
  assert.equal(plain.text, 'plain log text');

  // downloadRunLogs：fetch（含 302 跟随——fetch 默认行为，mock 直接返回最终响应）
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
  });
  const result = await downloadRunLogs({ fetchImpl, token: 't', owner: 'o', repo: 'r', runId: 11 });
  assert.ok(result.text.includes('build ok'));
  assert.equal(result.truncated, false);
  // 大日志：头尾截断（复用 D2 形状）
  const bigFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => {
      const bigZip = zipSync({ 'job/1.txt': strToU8('x'.repeat(200)) });
      return bigZip.buffer.slice(bigZip.byteOffset, bigZip.byteOffset + bigZip.byteLength);
    },
  });
  const big = await downloadRunLogs({ fetchImpl: bigFetch, token: 't', owner: 'o', repo: 'r', runId: 11, limit: 50 });
  assert.equal(big.truncated, true);
  assert.match(big.text, /中间省略/, '截断标注');

  // normalizeWorkflowRun：坏输入安全
  assert.equal(normalizeWorkflowRun(null).id, 0);
  assert.equal(normalizeWorkflowRun({ id: '5', status: 'queued' }).id, 5);
});
