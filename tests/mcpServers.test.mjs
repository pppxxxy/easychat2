// 通用 MCP 多服务器测试（spec: 2026-10-09-agent-extensibility T1-c）。
//
// 覆盖三块：
//  ① 存储域 mcpServers.js：归一化 / slug / upsert / remove / GitHub 旧设置映射与幂等迁移；
//  ② riskGate 分域：github 白名单不变、第三方默认 CONFIRM、overrides 调级、
//     FORBIDDEN 跨服务器全局硬禁（override 也解不开）；
//  ③ mcpTools 命名空间注册：github_ 兼容前缀 / <id>__ 隔离 / 执行层双保险 / headers 透传。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { clearTools, getTool, listRegisteredTools } from '../src/agent/tools/registry.js';
import { createMcpSession, DEFAULT_GITHUB_MCP_ENDPOINT } from '../src/mcp/client.js';
import { MCP_TOOL_TIERS, classifyMcpTool } from '../src/mcp/riskGate.js';
import {
  callMcpTool,
  mcpToolPrefix,
  registerAllMcpTools,
  registerMcpServerTools,
  unregisterAllMcpTools,
} from '../src/workspace/mcpTools.js';

// ---- mcpServers.js 加载：它经 io.js 拖 AsyncStorage，用内存版替身（同 securityStorage 范式）----
const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const mcpServersPath = path.resolve('src/storage/settings/mcpServers.js');
const transformed = babel.transformSync(fs.readFileSync(mcpServersPath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: mcpServersPath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const storage = new Map();
const ioStub = {
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
  readJsonWithSecrets: async (key, fallback) => {
    const raw = storage.get(key);
    return raw ? JSON.parse(raw) : fallback;
  },
  setJsonWithSecrets: async (key, payload) => {
    storage.set(key, JSON.stringify(payload));
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/io.js') && parent && String(parent.filename || '').includes('mcpServers')) {
    return ioStub;
  }
  if (request.endsWith('/mcp/client.js') || request === '../../mcp/client.js') {
    return { __esModule: true, DEFAULT_GITHUB_MCP_ENDPOINT };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadMcpServersModule() {
  storage.clear();
  const runtimeModule = new Module(mcpServersPath);
  runtimeModule.filename = mcpServersPath;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(mcpServersPath));
  runtimeModule._compile(transformed, mcpServersPath);
  return runtimeModule.exports;
}

test('存储域：归一化去重、slug 生成、upsert/remove 纯函数', () => {
  const mod = loadMcpServersModule();
  assert.equal(mod.makeMcpServerId('My Notes!'), 'my-notes');
  const normalized = mod.normalizeMcpServers([
    { id: 'a', name: 'A' },
    { id: 'a', name: 'dup' },
    { id: '', name: 'no-id' },
    null,
    { id: 'b', endpoint: 'https://b/mcp', mcpToken: 'tok', enabled: true },
  ]);
  assert.deepEqual(normalized.map(item => item.id), ['a', 'b']);
  assert.equal(normalized[0].authMethod, 'token');
  assert.equal(normalized[1].enabled, true);
  assert.deepEqual(normalized[0].headers, {});

  const list = mod.upsertMcpServer(normalized, { id: 'a', name: 'A2', tierOverrides: { t: 'readonly' } });
  assert.equal(list.find(item => item.id === 'a').name, 'A2');
  assert.deepEqual(list.find(item => item.id === 'a').tierOverrides, { t: 'readonly' });
  const [rest, removed] = mod.removeMcpServer(list, 'b');
  assert.equal(removed, true);
  assert.deepEqual(rest.map(item => item.id), ['a']);
  assert.equal(mod.removeMcpServer(rest, 'nope')[1], false);
});

test('GitHub 旧设置 → 内置记录（纯函数）+ 幂等迁移', async () => {
  const mod = loadMcpServersModule();
  assert.equal(mod.serverFromGithubSettings(null), null);
  assert.equal(mod.serverFromGithubSettings({ githubToken: '' }), null, '没凭据不迁');
  const server = mod.serverFromGithubSettings({
    enabled: true,
    authMethod: 'pat',
    endpoint: 'https://mcp.example/mcp/',
    githubToken: 'tok',
    toolCatalog: [{ name: 'get_me', description: 'me' }],
  });
  assert.equal(server.id, 'github');
  assert.equal(server.mcpToken, 'tok', '凭据映射进 mcpToken（已登记 SECRET_FIELDS）');
  assert.equal(server.authMethod, 'token');
  assert.equal(server.toolCatalog.length, 1);

  const first = await mod.migrateGithubServer({
    getGithubSettings: async () => ({ enabled: true, githubToken: 'tok', endpoint: 'https://x/mcp' }),
  });
  assert.equal(first.migrated, true);
  assert.equal((await mod.getMcpServers()).length, 1);
  const second = await mod.migrateGithubServer({
    getGithubSettings: async () => ({ enabled: true, githubToken: 'tok' }),
  });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'ALREADY_MIGRATED', '重复迁移不得产生第二条记录');
  assert.equal((await mod.getMcpServers()).length, 1);
  const noCreds = await mod.migrateGithubServer({ getGithubSettings: async () => ({}) });
  assert.equal(noCreds.reason, 'NO_CREDENTIALS');
});

test('riskGate 分域：github 白名单不变；第三方默认 CONFIRM 且 overrides 可调级', () => {
  // github（默认分支）：一次调用与传 serverId='github' 等价
  assert.equal(classifyMcpTool('get_file_contents'), MCP_TOOL_TIERS.READONLY);
  assert.equal(classifyMcpTool('some_brand_new_tool'), MCP_TOOL_TIERS.DENIED);
  assert.equal(classifyMcpTool('some_brand_new_tool', { serverId: 'github' }), MCP_TOOL_TIERS.DENIED);
  // 第三方：工具集未知 → 默认 CONFIRM（注册但每次确认）
  assert.equal(classifyMcpTool('some_brand_new_tool', { serverId: 'filesystem' }), MCP_TOOL_TIERS.CONFIRM);
  // overrides 调级
  assert.equal(
    classifyMcpTool('read_text_file', { serverId: 'filesystem', tierOverrides: { read_text_file: 'readonly' } }),
    MCP_TOOL_TIERS.READONLY
  );
  assert.equal(
    classifyMcpTool('write_file', { serverId: 'filesystem', tierOverrides: { write_file: 'denied' } }),
    MCP_TOOL_TIERS.DENIED
  );
  // 非法 override 值忽略（回落默认 CONFIRM）
  assert.equal(
    classifyMcpTool('whatever', { serverId: 'x', tierOverrides: { whatever: 'banana' } }),
    MCP_TOOL_TIERS.CONFIRM
  );
});

test('FORBIDDEN 跨服务器全局硬禁：override 也解不开', () => {
  for (const name of ['delete_file', 'remove_item', 'force_push', 'admin_reset']) {
    assert.equal(classifyMcpTool(name, { serverId: 'filesystem' }), MCP_TOOL_TIERS.DENIED, name);
    assert.equal(
      classifyMcpTool(name, { serverId: 'filesystem', tierOverrides: { [name]: 'readonly' } }),
      MCP_TOOL_TIERS.DENIED,
      `${name} 的 override 不得绕过硬禁`
    );
  }
});

test('命名空间注册：github_ 兼容前缀 / <id>__ 隔离 / 禁类不注册 / 第三方默认确认', () => {
  clearTools();
  assert.equal(mcpToolPrefix({ id: 'github' }), 'github_');
  assert.equal(mcpToolPrefix({ id: 'my-notes' }), 'my-notes__');
  assert.equal(mcpToolPrefix(null), '');

  const registered = registerMcpServerTools({
    id: 'my-notes',
    name: 'My Notes',
    endpoint: 'https://notes.example/mcp',
    mcpToken: 'tok',
    enabled: true,
    toolCatalog: [
      { name: 'search_notes', description: 'search' },
      { name: 'delete_note', description: 'must never register' },
    ],
  }, { sessionFactory: () => ({ callTool: async () => ({}), close() {} }) });

  assert.deepEqual(registered, ['my-notes__search_notes']);
  const tool = getTool('my-notes__search_notes');
  assert.equal(tool.requiresConfirmation, true, '第三方工具默认逐条确认');
  assert.equal(tool.readOnly, false);
  assert.equal(getTool('my-notes__delete_note'), null, '禁类不得注册');
  unregisterAllMcpTools();
  assert.equal(listRegisteredTools().length, 0);
});

test('多服务器：registerAll 只挂启用的；unregisterAll 清含 github 前缀与命名空间', () => {
  clearTools();
  const hooks = { sessionFactory: () => ({ callTool: async () => ({}), close() {} }) };
  const names = registerAllMcpTools([
    { id: 'github', name: 'GitHub', endpoint: 'https://g/mcp', mcpToken: 't', enabled: true, toolCatalog: [{ name: 'get_me' }] },
    { id: 'off-demo', name: 'Off', endpoint: 'https://o/mcp', mcpToken: 't', enabled: false, toolCatalog: [{ name: 'x' }] },
    { id: 'demo', name: 'Demo', endpoint: 'https://d/mcp', mcpToken: 't', enabled: true, toolCatalog: [{ name: 'search' }] },
  ], hooks);
  assert.deepEqual(names, ['github_get_me', 'demo__search']);
  assert.ok(getTool('github_get_me') && getTool('demo__search'));
  const removed = unregisterAllMcpTools();
  assert.equal(removed, 2);
  assert.equal(listRegisteredTools().length, 0);
});

test('执行层双保险：第三方被禁工具绕过注册表也进不去（会话零触达）', async () => {
  clearTools();
  let called = 0;
  const result = await callMcpTool(
    { id: 'demo', name: 'Demo' },
    'delete_note',
    {},
    { sessionFactory: () => ({ callTool: async () => { called += 1; return {}; }, close() {} }) }
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /安全策略禁止/);
  assert.equal(called, 0, '被禁调用绝不触达会话');
});

test('会话工厂泛化：自定义 headers 与 token 一起送出（第三方 X-Api-Key 场景）', async () => {
  const seen = [];
  const fakeFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push({ url, headers: options.headers, method: body.method });
    if (body.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }),
      };
    }
    return { ok: true, status: 202, headers: { get: () => '' }, text: async () => '' };
  };
  const session = createMcpSession({
    endpoint: 'https://notes.example/mcp',
    token: 'tok',
    headers: { 'X-Api-Key': 'k1' },
    fetchImpl: fakeFetch,
  });
  await session.ping();
  assert.equal(seen[0].headers['X-Api-Key'], 'k1', '自定义头必须送出');
  assert.equal(seen[0].headers.Authorization, 'Bearer tok', '标准 Authorization 不被自定义头挤掉');
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
  session.close();
});
