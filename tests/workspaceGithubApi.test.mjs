// GitHub REST 层（六键工作台后端）纯函数测试：注入 fetch，Node 直测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildHeaders,
  buildReposUrl,
  canDeleteRepo,
  createRepo,
  deleteRepo,
  fetchTokenScopes,
  listBranches,
  listRepos,
  mapGithubError,
  normalizeRepo,
  rateLimitFrom,
  renameRepo,
  repoWebUrl,
} from '../src/workspace/github/restApi.js';

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
