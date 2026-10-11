// 扩展导入（多 agent 格式兼容）的纯逻辑回归。
//
// 覆盖四段：来源判定 → 格式适配（这是「兼容 Claude Code / Codex / ZCode」的落点）→
// 取文件（注入 fake fetch，零网络）→ 落盘编排。以及 agent 工具的门控属性
// （不装插件、写工具要确认）——这些错了不会报错，只会静默少装或越权装。

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseImportSource, splitPackageSpec, githubBlobToRawUrl, IMPORT_METHODS } from '../src/workspace/import/sources.js';
import {
  detectArtifacts,
  summarizeArtifacts,
  slugify,
  adaptMcpServer,
  isNativePluginManifest,
  isRelevantImportPath,
  parseJsonLoose,
} from '../src/workspace/import/adapt.js';
import {
  flattenNpmFiles,
  fetchNpmPackageFiles,
  fetchGithubRepoFiles,
  searchGithubRepos,
  buildNpmCdnUrl,
} from '../src/workspace/import/fetchFiles.js';
import { installArtifacts, mergeMcpServer } from '../src/workspace/import/install.js';
import { runImport, previewImport, importSourceLabel } from '../src/workspace/import/index.js';
import {
  SEARCH_EXTENSION_REPOS_TOOL_DEFINITION,
  IMPORT_EXTENSION_TOOL_DEFINITION,
  setImportModule,
} from '../src/workspace/toolDefs/importTool.js';

// —— 测试替身 ——

// restApi 的 request() 会读 response.ok / status / headers.get / json / text。
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const route = routes.find(item => item.match(url));
    if (!route) {
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
    }
    const body = typeof route.body === 'function' ? route.body(url, options) : route.body;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}

function memoryStore(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async writeWorkspaceFile({ path, content }) {
      files.set(path, content);
      return { path, length: String(content).length };
    },
    async readWorkspaceFile({ path }) {
      if (!files.has(path)) throw new Error('ENOENT');
      return { content: files.get(path) };
    },
    async listWorkspaceFiles() {
      return [...files.keys()];
    },
    async deleteFile({ path }) {
      files.delete(path);
      return true;
    },
  };
}

const PLUGIN_MANIFEST = {
  id: 'demo-plugin',
  name: 'Demo Plugin',
  description: '演示',
  slots: [{ kind: 'settings.row', id: 'row', label: 'Demo' }],
  tools: [{ name: 'demo_tool', description: '演示工具', handler: 'return 1;' }],
};

const SKILL_MD = ['---', 'name: Code Review', 'description: 审查代码', '---', '', '# 步骤', '1. 读 diff'].join('\n');

// —— 来源判定 ——

test('来源判定：GitHub 的三种写法（owner/repo、仓库 URL、深链）', () => {
  assert.deepEqual(parseImportSource('anthropics/skills'), {
    kind: 'github', owner: 'anthropics', repo: 'skills', ref: '', subpath: '',
  });
  assert.deepEqual(parseImportSource('https://github.com/anthropics/skills'), {
    kind: 'github', owner: 'anthropics', repo: 'skills', ref: '', subpath: '',
  });
  const deep = parseImportSource('https://github.com/o/r/tree/main/packs/review');
  assert.equal(deep.kind, 'github');
  assert.equal(deep.ref, 'main');
  assert.equal(deep.subpath, 'packs/review');
  assert.equal(importSourceLabel(deep), 'o/r@main/packs/review');
});

test('来源判定：npm 的四种写法与 scoped 包名', () => {
  assert.deepEqual(parseImportSource('npm:lodash'), { kind: 'npm', package: 'lodash', version: '' });
  assert.deepEqual(parseImportSource('npm:@scope/pkg@1.2.3'), { kind: 'npm', package: '@scope/pkg', version: '1.2.3' });
  assert.deepEqual(parseImportSource('https://www.npmjs.com/package/foo'), { kind: 'npm', package: 'foo', version: '' });
  assert.deepEqual(parseImportSource('https://registry.npmjs.org/@scope/pkg'), { kind: 'npm', package: '@scope/pkg', version: '' });
  // 裸包名（无斜杠）与 scoped 裸名都当 npm；带斜杠的当 GitHub
  assert.equal(parseImportSource('is-number').kind, 'npm');
  assert.equal(parseImportSource('@scope/pkg').kind, 'npm');
  assert.equal(parseImportSource('owner/repo').kind, 'github');
  assert.deepEqual(splitPackageSpec('@scope/pkg@2.0.0'), { name: '@scope/pkg', version: '2.0.0' });
});

test('来源判定：粘贴 JSON / 粘贴技能正文 / 单文件网址 / 非法输入', () => {
  assert.equal(parseImportSource('{"mcpServers":{}}').kind, 'paste');
  assert.equal(parseImportSource('{"mcpServers":{}}').path, 'pasted.json');
  const skill = parseImportSource('---\nname: x\n---\n正文');
  assert.equal(skill.kind, 'paste');
  assert.equal(skill.path, 'SKILL.md');
  assert.equal(parseImportSource('https://example.com/a.json').kind, 'url');
  assert.deepEqual(parseImportSource(''), { kind: 'invalid', reason: 'empty' });
  assert.deepEqual(parseImportSource('{ 坏 JSON'), { kind: 'invalid', reason: 'badJson' });
  assert.deepEqual(parseImportSource('这是一句普通的话'), { kind: 'invalid', reason: 'unrecognized' });
  // GitHub 单文件链接转 raw（抓整包太重）
  const raw = parseImportSource('https://github.com/o/r/blob/main/skills/a/SKILL.md');
  assert.equal(raw.kind, 'url');
  assert.equal(raw.url, 'https://raw.githubusercontent.com/o/r/main/skills/a/SKILL.md');
  assert.equal(githubBlobToRawUrl('https://example.com/x'), '');
});

// —— 格式适配（兼容性核心）——

test('适配：Claude Code 布局（.claude/skills、commands、agents、.mcp.json）一次全认', () => {
  const files = [
    { path: '.claude/skills/review/SKILL.md', content: SKILL_MD },
    { path: '.claude/commands/polish.md', content: '---\ndescription: 润色\n---\n润色 $ARGUMENTS' },
    { path: '.claude/agents/researcher.md', content: '---\nname: Researcher\ndescription: 查资料\ntools: search_workspace\n---\n' },
    {
      path: '.mcp.json',
      content: JSON.stringify({
        mcpServers: {
          notes: { type: 'http', url: 'https://notes.example/mcp', headers: { Authorization: 'Bearer tok-123', 'X-Extra': 'v' } },
          local: { command: 'npx', args: ['-y', 'some-mcp'] },
        },
      }),
    },
    { path: 'README.md', content: '# 无关文件' },
  ];
  const artifacts = detectArtifacts(files, { sourceLabel: 'demo' });
  assert.equal(artifacts.skills.length, 1);
  assert.equal(artifacts.skills[0].slug, 'review');
  assert.equal(artifacts.skills[0].path, '.easychat/skills/review/SKILL.md');
  assert.equal(artifacts.skills[0].content, SKILL_MD, '技能正文原样搬运');
  assert.equal(artifacts.commands.length, 1);
  assert.equal(artifacts.commands[0].path, '.easychat/commands/polish.md');
  assert.equal(artifacts.agents.length, 1);
  assert.equal(artifacts.agents[0].path, '.easychat/agents/researcher.md');
  // MCP：http 型收下，Bearer 抽成 mcpToken（否则明文进磁盘），stdio 型记账跳过
  assert.equal(artifacts.mcpServers.length, 1);
  assert.equal(artifacts.mcpServers[0].endpoint, 'https://notes.example/mcp');
  assert.equal(artifacts.mcpServers[0].mcpToken, 'tok-123');
  assert.deepEqual(artifacts.mcpServers[0].headers, { 'X-Extra': 'v' });
  assert.deepEqual(artifacts.notes.filter(note => note.reason === 'stdio').map(note => note.name), ['local']);
});

test('适配：opencode / ZCode 的 mcp 段与根级 SKILL.md 命名', () => {
  const files = [
    {
      path: 'opencode.json',
      content: JSON.stringify({ mcp: { files: { type: 'remote', url: 'https://mcp.example/sse', enabled: false } } }),
    },
    { path: 'SKILL.md', content: '---\nname: My Skill\ndescription: d\n---\nbody' },
  ];
  const artifacts = detectArtifacts(files, { sourceLabel: 'my-skill' });
  assert.equal(artifacts.mcpServers.length, 1);
  assert.equal(artifacts.mcpServers[0].enabled, false, 'enabled:false 原样带过来');
  // 根级 SKILL.md：目录名不是 skills，退回 frontmatter 的 name
  assert.equal(artifacts.skills[0].slug, 'my-skill');
  assert.equal(artifacts.skills[0].name, 'My Skill');
});

test('适配：扩展包 / 插件清单 / .claude-plugin 清单三者不混淆', () => {
  const pack = {
    format: 'easychat2-extension-pack',
    version: 1,
    name: 'my-pack',
    files: [{ path: '.easychat/commands/a.md', content: 'x' }],
  };
  const artifacts = detectArtifacts([
    { path: 'pack.json', content: JSON.stringify(pack) },
    { path: 'plugin.json', content: JSON.stringify(PLUGIN_MANIFEST) },
    { path: 'bundle/.claude-plugin/plugin.json', content: JSON.stringify({ name: 'cc-bundle', version: '1.0.0' }) },
    // 有 id + name 但没有 tools/slots：不能当插件（否则任何配置对象都会被误判）
    { path: 'config.json', content: JSON.stringify({ id: 'x', name: 'y', enabled: true }) },
  ], { sourceLabel: 'demo' });
  assert.equal(artifacts.packs.length, 1);
  assert.equal(artifacts.packs[0].name, 'my-pack');
  assert.equal(artifacts.plugins.length, 1);
  assert.equal(artifacts.plugins[0].id, 'demo-plugin');
  const claude = artifacts.notes.find(note => note.reason === 'claudePluginBundle');
  assert.ok(claude, 'Claude Code 插件清单记为身份说明');
  assert.equal(claude.name, 'cc-bundle');
  assert.equal(isNativePluginManifest({ id: 'x', name: 'y' }), false);
});

test('适配：JSONC（带注释与尾逗号）也能读出 mcp 段', () => {
  const jsonc = ['{', '  // 注释', '  "mcp": {', '    "a": { "url": "https://a.example/mcp" },', '  },', '}'].join('\n');
  assert.equal(parseJsonLoose(jsonc).ok, true);
  const artifacts = detectArtifacts([{ path: 'opencode.jsonc', content: jsonc }], { sourceLabel: 'x' });
  assert.equal(artifacts.mcpServers.length, 1);
});

test('适配：文件筛选只放行可能承载扩展的路径', () => {
  for (const path of [
    'SKILL.md',
    '.claude/skills/a/SKILL.md',
    'commands/x.md',
    'pkg/agents/y.md',
    '.mcp.json',
    'opencode.json',
    'plugin.json',
    'a/b/pack.json',
  ]) assert.equal(isRelevantImportPath(path), true, path);
  for (const path of [
    'README.md',
    'src/index.js',
    'package.json',
    'a/b/c/d/deep.json',
    'assets/logo.png',
  ]) assert.equal(isRelevantImportPath(path), false, path);
});

test('适配：slugify 与 MCP 条目的容错', () => {
  assert.equal(slugify('My Skill!'), 'my-skill');
  assert.equal(slugify('  A__B  '), 'a__b');
  assert.equal(slugify(''), '');
  assert.deepEqual(adaptMcpServer('x', { url: 'ftp://a/b' }), { skipped: 'notHttp' });
  assert.deepEqual(adaptMcpServer('x', {}), { skipped: 'noEndpoint' });
  assert.deepEqual(adaptMcpServer('x', { command: 'npx' }), { skipped: 'stdio' });
  // 没有名字时用主机名兜底，避免 id 为空
  assert.equal(adaptMcpServer('', { url: 'https://notes.example/mcp' }).server.id, 'notes-example');
});

// —— 取文件（fake fetch）——

test('npm：jsDelivr 文件树 → 只拉相关文件 → 内容原样', async () => {
  const fetchImpl = fakeFetch([
    { match: url => url.endsWith('/npm/my-pack'), body: { tags: { latest: '1.0.0' }, versions: [{ version: '1.0.0' }] } },
    {
      match: url => url.includes('data.jsdelivr.com') && url.includes('/npm/my-pack@1.0.0'),
      body: {
        files: [
          { type: 'file', name: 'README.md', size: 10 },
          { type: 'file', name: 'package.json', size: 100 },
          { type: 'directory', name: 'skills', files: [{ type: 'directory', name: 'review', files: [{ type: 'file', name: 'SKILL.md', size: 40 }] }] },
        ],
      },
    },
    { match: url => url.includes('cdn.jsdelivr.net/npm/my-pack@1.0.0/skills/review/SKILL.md'), body: SKILL_MD },
  ]);
  const result = await fetchNpmPackageFiles({ fetchImpl, packageName: 'my-pack' });
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(result.files.map(file => file.path), ['skills/review/SKILL.md']);
  assert.equal(result.files[0].content, SKILL_MD);
  assert.equal(result.scanned, 3);
  assert.equal(buildNpmCdnUrl('my-pack', '1.0.0', 'a/b c.md'), 'https://cdn.jsdelivr.net/npm/my-pack@1.0.0/a/b%20c.md');
  // 嵌套目录拍平
  assert.deepEqual(flattenNpmFiles([{ type: 'directory', name: 'a', files: [{ type: 'file', name: 'b.json', size: 1 }] }]), [
    { path: 'a/b.json', size: 1 },
  ]);
});

test('GitHub：树接口过滤 + blob 取原文 + subpath 作用域', async () => {
  const fetchImpl = fakeFetch([
    {
      match: url => url.includes('/git/trees/'),
      body: {
        tree: [
          { path: 'README.md', type: 'blob', sha: 's0', size: 5 },
          { path: 'packs/review/skills/a/SKILL.md', type: 'blob', sha: 's1', size: 40 },
          { path: 'other/SKILL.md', type: 'blob', sha: 's2', size: 40 },
          { path: 'packs', type: 'tree', sha: 't1' },
        ],
      },
    },
    { match: url => url.includes('/git/blobs/'), body: SKILL_MD },
  ]);
  const scoped = await fetchGithubRepoFiles({ fetchImpl, owner: 'o', repo: 'r', subpath: 'packs/review' });
  assert.deepEqual(scoped.files.map(file => file.path), ['skills/a/SKILL.md'], 'subpath 前缀被剥掉');
  assert.equal(scoped.files[0].content, SKILL_MD);
  const all = await fetchGithubRepoFiles({ fetchImpl, owner: 'o', repo: 'r' });
  assert.deepEqual(all.files.map(file => file.path).sort(), ['other/SKILL.md', 'packs/review/skills/a/SKILL.md']);
});

test('GitHub 搜索：归一化字段 + 空关键词不打网络', async () => {
  const fetchImpl = fakeFetch([
    {
      match: url => url.includes('/search/repositories'),
      body: {
        items: [{
          full_name: 'o/r',
          name: 'r',
          description: 'd',
          stargazers_count: 12,
          default_branch: 'main',
          html_url: 'https://github.com/o/r',
          owner: { login: 'o' },
        }],
      },
    },
  ]);
  const repos = await searchGithubRepos({ fetchImpl, query: 'skill' });
  assert.deepEqual(repos, [{ fullName: 'o/r', owner: 'o', repo: 'r', description: 'd', stars: 12, defaultBranch: 'main', url: 'https://github.com/o/r' }]);
  assert.equal((await searchGithubRepos({ fetchImpl, query: '  ' })).length, 0);
  assert.equal(fetchImpl.calls.length, 1, '空关键词不发请求');
});

// —— 落盘 ——

test('落盘：技能/命令/子代理写文件，MCP 一次合并写，插件在 agent 档位下跳过', async () => {
  const store = memoryStore();
  const saved = [];
  const artifacts = detectArtifacts([
    { path: 'skills/a/SKILL.md', content: SKILL_MD },
    { path: 'commands/b.md', content: '---\ndescription: d\n---\nbody' },
    { path: 'agents/c.md', content: '---\nname: C\n---\n' },
    { path: 'plugin.json', content: JSON.stringify(PLUGIN_MANIFEST) },
    { path: '.mcp.json', content: JSON.stringify({ mcpServers: { notes: { url: 'https://notes.example/mcp' } } }) },
  ], { sourceLabel: 'demo' });
  const summary = await installArtifacts({
    store,
    artifacts,
    allowPlugins: false,
    mcp: { load: async () => [{ id: 'old', endpoint: 'https://old/mcp' }], save: async list => saved.push(list) },
  });
  assert.deepEqual(summary.installed, { plugins: 0, packs: 0, skills: 1, commands: 1, agents: 1, mcpServers: 1 });
  assert.deepEqual([...store.files.keys()].sort(), ['.easychat/agents/c.md', '.easychat/commands/b.md', '.easychat/skills/a/SKILL.md']);
  assert.equal(saved.length, 1, 'MCP 只写一次（逐个 save 会互相覆盖）');
  assert.deepEqual(saved[0].map(item => item.id), ['old', 'notes']);
  assert.deepEqual(summary.skipped, [{ kind: 'plugin', name: 'Demo Plugin', reason: 'pluginNeedsUserInstall' }]);
  // 插件文件没被写进 plugins.json
  assert.equal(store.files.has('.easychat/plugins.json'), false);
});

test('落盘：UI 档位（allowPlugins）真的把插件装进 plugins.json', async () => {
  const store = memoryStore();
  const artifacts = detectArtifacts([{ path: 'plugin.json', content: JSON.stringify(PLUGIN_MANIFEST) }], { sourceLabel: 'demo' });
  const summary = await installArtifacts({ store, artifacts, allowPlugins: true });
  assert.equal(summary.installed.plugins, 1);
  const written = JSON.parse(store.files.get('.easychat/plugins.json'));
  assert.deepEqual(written.plugins.map(item => item.id), ['demo-plugin']);
});

test('mergeMcpServer：同 id 覆盖、新 id 追加、无 id 原样返回', () => {
  const list = [{ id: 'a', endpoint: 'https://a' }];
  assert.deepEqual(mergeMcpServer(list, { id: 'a', endpoint: 'https://a2' }), [{ id: 'a', endpoint: 'https://a2' }]);
  assert.equal(mergeMcpServer(list, { id: 'b' }).length, 2);
  assert.deepEqual(mergeMcpServer(list, { endpoint: 'x' }), list);
});

// —— 编排 ——

test('编排：粘贴 MCP 配置一步到位；识别不到资产时报 noArtifacts', async () => {
  const store = memoryStore();
  const saved = [];
  const result = await runImport({
    input: JSON.stringify({ mcpServers: { notes: { url: 'https://notes.example/mcp' } } }),
    store,
    mcp: { load: async () => [], save: async list => saved.push(list) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.installSummary.total, 1);
  assert.equal(saved[0][0].id, 'notes');

  const empty = await runImport({ input: '{"hello":"world"}', store });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'noArtifacts');
});

test('编排：GitHub 端到端（fake fetch）预览 + 落盘', async () => {
  const fetchImpl = fakeFetch([
    {
      match: url => url.includes('/git/trees/'),
      body: { tree: [{ path: '.claude/skills/review/SKILL.md', type: 'blob', sha: 's1', size: 40 }] },
    },
    { match: url => url.includes('/git/blobs/'), body: SKILL_MD },
  ]);
  const preview = await previewImport({ input: 'o/r', fetchImpl });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.summary, { plugins: 0, packs: 0, skills: 1, commands: 0, agents: 0, mcpServers: 0, notes: 0, total: 1 });
  assert.equal(importSourceLabel(preview.source), 'o/r');

  const store = memoryStore();
  const result = await runImport({ input: 'o/r', fetchImpl, store });
  assert.equal(result.ok, true);
  assert.equal(store.files.get('.easychat/skills/review/SKILL.md'), SKILL_MD);
});

test('编排：非法来源与网络失败都返回 ok:false 且带原因（不抛）', async () => {
  const store = memoryStore();
  const bad = await runImport({ input: '   ', store });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'empty');
  const offline = await runImport({ input: 'o/r', store, fetchImpl: fakeFetch([]) });
  assert.equal(offline.ok, false);
  assert.ok(offline.error, '网络失败要有原因');
});

// —— agent 工具 ——

test('工具门控：搜索只读、导入要确认、且不装插件', () => {
  assert.equal(SEARCH_EXTENSION_REPOS_TOOL_DEFINITION.readOnly, true);
  assert.equal(SEARCH_EXTENSION_REPOS_TOOL_DEFINITION.requiresConfirmation, undefined);
  assert.equal(IMPORT_EXTENSION_TOOL_DEFINITION.readOnly, false);
  assert.equal(IMPORT_EXTENSION_TOOL_DEFINITION.requiresConfirmation, true);
  assert.deepEqual(IMPORT_EXTENSION_TOOL_DEFINITION.parameters.required, ['source']);
});

test('工具执行：注入导入模块后能搜能装，且透传 allowPlugins:false', async () => {
  const calls = [];
  setImportModule({
    findRepos: async ({ query }) => (query === 'none' ? [] : [{ fullName: 'o/r', stars: 3, description: 'd' }]),
    runImport: async options => {
      calls.push(options);
      return {
        ok: true,
        label: options.input,
        installSummary: { total: 1, installed: { skills: 1 }, skipped: [], errors: [] },
        install: { skipped: [], errors: [] },
        artifacts: { notes: [] },
      };
    },
  });
  try {
    const store = memoryStore();
    const search = await SEARCH_EXTENSION_REPOS_TOOL_DEFINITION.execute({ store }, { query: 'skill' });
    assert.match(search.content, /o\/r/);
    const none = await SEARCH_EXTENSION_REPOS_TOOL_DEFINITION.execute({ store }, { query: 'none' });
    assert.equal(none.isError, undefined);

    const imported = await IMPORT_EXTENSION_TOOL_DEFINITION.execute({ store }, { source: 'o/r' }, { characterId: 'c1' });
    assert.equal(imported.isError, undefined);
    assert.match(imported.content, /已导入 1 项/);
    assert.equal(calls[0].allowPlugins, false, 'agent 侧永不装插件');
    assert.equal(calls[0].characterId, 'c1');

    const missing = await IMPORT_EXTENSION_TOOL_DEFINITION.execute({ store }, {});
    assert.equal(missing.isError, true);
  } finally {
    setImportModule(null);
  }
});

test('GitHub：单个文件取失败只跳过并计数，不拖垮整次导入', async () => {
  // 真机常见：不带 token 时 GitHub 限流，部分 blob 取不到。此时必须「装到能装的、
  // 如实报少了几个」，而不是整次导入失败——否则一个限流就把用户的 20 个技能全废掉。
  const fetchImpl = fakeFetch([
    {
      match: url => url.includes('/git/trees/'),
      body: {
        tree: [
          { path: 'skills/a/SKILL.md', type: 'blob', sha: 'ok1', size: 40 },
          { path: 'skills/b/SKILL.md', type: 'blob', sha: 'bad', size: 40 },
          { path: 'commands/c.md', type: 'blob', sha: 'ok2', size: 20 },
        ],
      },
    },
    { match: url => url.includes('/git/blobs/ok1'), body: SKILL_MD },
    { match: url => url.includes('/git/blobs/ok2'), body: '---\ndescription: d\n---\nbody' },
    // bad 没有路由 → 404 → 走 request 的 NOT_FOUND
  ]);
  const result = await fetchGithubRepoFiles({ fetchImpl, owner: 'o', repo: 'r' });
  assert.equal(result.failed, 1, '取失败的文件被计数');
  assert.deepEqual(result.files.map(file => file.path).sort(), ['commands/c.md', 'skills/a/SKILL.md']);
  const artifacts = detectArtifacts(result.files, { sourceLabel: 'o/r' });
  assert.equal(artifacts.skills.length, 1);
  assert.equal(artifacts.commands.length, 1);
});

test('工具执行：限流导致少装时，报告里如实写出「没取到几个文件」', async () => {
  setImportModule({
    findRepos: async () => [],
    runImport: async () => ({
      ok: true,
      label: 'o/r',
      meta: { failed: 3 },
      installSummary: { total: 1, installed: { skills: 1 }, skipped: [], errors: [] },
      install: { skipped: [], errors: [] },
      artifacts: { notes: [] },
    }),
  });
  try {
    const result = await IMPORT_EXTENSION_TOOL_DEFINITION.execute({ store: memoryStore() }, { source: 'o/r' });
    assert.match(result.content, /3 个文件没取到/);
  } finally {
    setImportModule(null);
  }
});

test('适配元数据自洽：方法表带 i18n key、计数摘要与 hasArtifacts 一致', () => {
  for (const method of IMPORT_METHODS) {
    assert.ok(method.labelKey.startsWith('workspace.import.'));
    assert.ok(method.placeholderKey.startsWith('workspace.import.'));
  }
  assert.equal(summarizeArtifacts(null).total, 0);
  assert.equal(summarizeArtifacts({ skills: [1], mcpServers: [1, 2] }).total, 3);
});
