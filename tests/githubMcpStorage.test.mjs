// GitHub MCP 存储域测试（babel + Module._load 桩，参照 workspaceSettings 的骨架）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/storage/githubMcp.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  createMutationQueue: () => {
    let single = Promise.resolve();
    return {
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
    };
  },
  // 令牌保护在真实环境走 secretStore；这里透传 JSON，密钥字段名由专门测试钉住。
  setJsonWithSecrets: async (key, payload) => {
    await AsyncStorage.setItem(key, JSON.stringify(payload));
    return payload;
  },
  readJsonWithSecrets: async (key, fallback) => {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const base = String(request).split('/').pop();
  if (base === 'async-storage') return AsyncStorage;
  if (base === 'io.js') return ioStub;
  return originalLoad.call(this, request, parent, isMain);
};

const filename = path.resolve('src/storage/githubMcp.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
const githubMcp = runtimeModule.exports;

test('normalizeGithubMcpSettings：默认值与目录归一化', () => {
  assert.equal(githubMcp.normalizeGithubMcpSettings(null).enabled, false);
  assert.equal(githubMcp.normalizeGithubMcpSettings(null).endpoint, 'https://api.githubcopilot.com/mcp/');
  assert.equal(githubMcp.normalizeGithubMcpSettings(null).authMethod, 'pat');
  assert.deepEqual(githubMcp.normalizeGithubMcpSettings(null).toolCatalog, []);
  const normalized = githubMcp.normalizeGithubMcpSettings({
    enabled: true,
    authMethod: 'oauth',
    toolCatalog: [
      { name: 'get_file_contents', description: 'd', tier: 'readonly' },
      { name: 'weird', tier: 'nonsense' },
      null,
    ],
    deniedNames: ['delete_branch'],
    connectedAt: 123,
  });
  assert.equal(normalized.toolCatalog.length, 2, '非法条目丢弃');
  assert.equal(normalized.toolCatalog[1].tier, 'readonly', '未知 tier 收敛为只读');
  assert.deepEqual(normalized.deniedNames, ['delete_branch']);
  assert.equal(normalized.connectedAt, 123);
});

test('密钥字段名必须登记在 secretStore 的 SECRET_FIELDS（自动进安全存储的契约）', async () => {
  const source = fs.readFileSync(path.resolve('src/storage/secretStore.js'), 'utf8');
  for (const field of ['githubToken', 'githubAccessToken', 'githubRefreshToken']) {
    assert.ok(source.includes(`'${field}'`), `SECRET_FIELDS 必须包含 ${field}`);
  }
});

// 桩 fetch：按 MCP Streamable HTTP 应答（json + 会话头）。
function stubFetch({ tools }) {
  return async (url, options = {}) => {
    const body = JSON.parse(options.body);
    const headers = new Map(Object.entries(options.headers || {}));
    const lower = new Map([...headers.entries()].map(([k, v]) => [String(k).toLowerCase(), v]));
    if (body.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        headers: { get: name => (String(name).toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }),
      };
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
    }
    if (body.method === 'tools/list') {
      if (lower.get('authorization') !== 'Bearer good-token') {
        return { ok: false, status: 401, headers: { get: () => null }, text: async () => 'bad' };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } }),
      };
    }
    throw new Error(`unexpected method ${body.method}`);
  };
}

const TOOLS = [
  { name: 'get_file_contents', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'create_or_update_file', description: 'write', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_branch', description: 'danger' },
  { name: 'some_unknown_future_tool', description: 'unknown' },
];

test('connectGithubMcpWithToken：握手 + 风险过滤落盘 + 凭据写入', async () => {
  store.clear();
  const summary = await githubMcp.connectGithubMcpWithToken({
    token: 'good-token',
    authMethod: 'pat',
    fetchImpl: stubFetch({ tools: TOOLS }),
  });
  assert.equal(summary.allowedCount, 2, '只读+确认两类入库');
  assert.equal(summary.confirmCount, 1);
  assert.equal(summary.deniedCount, 2, '删除分支与未知工具都不入库');
  assert.equal(summary.totalCount, 4);
  const settings = await githubMcp.getGithubMcpSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.authMethod, 'pat');
  assert.equal(settings.githubToken, 'good-token');
  assert.deepEqual(settings.toolCatalog.map(item => item.name), ['get_file_contents', 'create_or_update_file']);
  assert.deepEqual(settings.deniedNames.sort(), ['delete_branch', 'some_unknown_future_tool']);
  assert.ok(settings.connectedAt > 0);
});

test('connectGithubMcpWithToken：401 直接失败且不落启用状态', async () => {
  store.clear();
  await assert.rejects(
    () => githubMcp.connectGithubMcpWithToken({ token: 'wrong', fetchImpl: stubFetch({ tools: TOOLS }) }),
    error => error.code === 'MCP_AUTH_FAILED'
  );
  const settings = await githubMcp.getGithubMcpSettings();
  assert.equal(settings.enabled, false, '失败的连接不得置 enabled');
});

test('connectGithubMcpWithToken：入参校验（空令牌 / 非 https）', async () => {
  await assert.rejects(
    () => githubMcp.connectGithubMcpWithToken({ token: '  ', fetchImpl: stubFetch({ tools: [] }) }),
    error => error.code === 'GITHUB_TOKEN_EMPTY'
  );
  await assert.rejects(
    () => githubMcp.connectGithubMcpWithToken({ token: 't', endpoint: 'http://api.example/mcp/', fetchImpl: stubFetch({ tools: [] }) }),
    error => error.code === 'GITHUB_ENDPOINT_HTTPS'
  );
});

test('patchGithubMcpSettings 局部更新不清其他字段；clear 清空凭据', async () => {
  store.clear();
  await githubMcp.connectGithubMcpWithToken({ token: 'good-token', authMethod: 'pat', fetchImpl: stubFetch({ tools: TOOLS }) });
  const patched = await githubMcp.patchGithubMcpSettings({ accountLogin: 'octocat' });
  assert.equal(patched.accountLogin, 'octocat');
  assert.equal(patched.githubToken, 'good-token', '补丁合并不能丢令牌');
  assert.equal(patched.toolCatalog.length, 2, '补丁合并不能丢目录');
  const cleared = await githubMcp.clearGithubMcpCredentials();
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.githubToken, '');
  assert.deepEqual(cleared.toolCatalog, []);
});

test('refreshGithubMcpToolCatalog：未连接报错，已连接刷新目录', async () => {
  store.clear();
  await assert.rejects(
    () => githubMcp.refreshGithubMcpToolCatalog({ fetchImpl: stubFetch({ tools: TOOLS }) }),
    error => error.code === 'GITHUB_NOT_CONNECTED'
  );
  await githubMcp.connectGithubMcpWithToken({ token: 'good-token', authMethod: 'pat', fetchImpl: stubFetch({ tools: TOOLS }) });
  const refreshed = await githubMcp.refreshGithubMcpToolCatalog({ fetchImpl: stubFetch({ tools: TOOLS }) });
  assert.equal(refreshed.allowedCount, 2);
});
