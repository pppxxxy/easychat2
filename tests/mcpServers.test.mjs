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
import { createMcpSession, DEFAULT_GITHUB_MCP_ENDPOINT, MCP_PROTOCOL_VERSION } from '../src/mcp/client.js';
import {
  MCP_TOOL_TIERS,
  classifyMcpTool,
  filterMcpToolsForRegistration,
} from '../src/mcp/riskGate.js';
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
  // mcpServers.js 还静态引 riskGate（纯 JS）：babel 转 CJS 后 require 会把 ESM 当 CJS 解析，
  // 这里按真实模块转交（测试文件顶部已 import 真身）。
  if (request.endsWith('/riskGate.js') || request === '../../mcp/riskGate.js') {
    return { __esModule: true, MCP_TOOL_TIERS, classifyMcpTool, filterMcpToolsForRegistration };
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

test('parseHeadersText：每行「名称: 值」，容错空行与坏行', () => {
  const mod = loadMcpServersModule();
  assert.deepEqual(mod.parseHeadersText('X-Api-Key: k1\n\nBadLine\nX-Env:  prod  \n: noName'), {
    'X-Api-Key': 'k1',
    'X-Env': 'prod',
  });
  assert.deepEqual(mod.parseHeadersText(''), {});
  assert.deepEqual(mod.parseHeadersText(null), {});
});

test('applyConnectResult：目录按服务器分域过滤（第三方默认确认，禁类进 denied）', () => {
  const mod = loadMcpServersModule();
  const updated = mod.applyConnectResult(
    { id: 'notes', name: 'Notes', endpoint: 'https://n/mcp', mcpToken: 't' },
    [
      { name: 'search_notes', description: 's' },
      { name: 'delete_note', description: 'x' },
      { name: 'force_sync', description: 'x' },
    ]
  );
  assert.equal(updated.enabled, true, '连接成功即启用');
  assert.ok(updated.connectedAt > 0);
  assert.deepEqual(updated.toolCatalog.map(item => item.name), ['search_notes']);
  assert.equal(updated.toolCatalog[0].tier, 'confirm', '第三方工具默认确认');
  assert.deepEqual(updated.deniedNames, ['delete_note', 'force_sync'], '禁类进 denied 供 UI 展示');
  assert.equal(mod.applyConnectResult(null, []), null);
});

test('设置页接线：卡片 / sectionProps / 搜索索引 / i18n 中英齐', () => {
  const screen = fs.readFileSync(path.resolve('src/SettingsScreen.js'), 'utf8');
  assert.ok(screen.includes('McpServersSection'), '卡片组件已引入');
  assert.ok(screen.includes("flashSection === 'mcpservers'"), '卡片 id 与搜索/深链一致');
  assert.ok(screen.includes("'github', 'mcpservers'"), 'SECTION_RENDER_ORDER 已含 mcpservers');
  for (const field of ['mcpServers', 'onAddMcpServer', 'onTestMcpServer', 'onToggleMcpServer', 'onRemoveMcpServer']) {
    assert.ok(screen.includes(field), `sectionProps 缺 ${field}`);
  }
  const section = fs.readFileSync(path.resolve('src/settings/sections/McpServersSection.js'), 'utf8');
  assert.ok(section.includes("t('settings.mcp.add.action')"), '添加入口');
  assert.ok(section.includes("t('settings.mcp.riskHint')"), '安全边界明示');
  const search = fs.readFileSync(path.resolve('src/settings/searchIndex.js'), 'utf8');
  assert.ok(search.includes("mcpservers: 'MCP 服务器'"), 'section 标签');
  assert.ok(search.includes("sectionId: 'mcpservers'"), '搜索项');
  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/settings.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/settings.js'), 'utf8');
  for (const key of ['settings.mcp.title', 'settings.mcp.riskHint', 'settings.mcp.add.action', 'settings.mcp.err.endpoint']) {
    assert.ok(zh.includes(`'${key}'`), `中文缺键 ${key}`);
    assert.ok(en.includes(`'${key}'`), `英文缺键 ${key}`);
  }
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

// ---- 2026-10-09 审查报告三个 MCP bug 的回归测试 ----

// BUG-2（P2）：保留字 id。分级是**按 serverId 分域**的，第三方拿到 'github'
// 就等于偷换成内置白名单语义（叫 search_code 的工具会被判只读、免确认放行）。
test('保留字 id：第三方不得占用内置 github 命名空间（BUG-2）', () => {
  const mod = loadMcpServersModule();
  assert.deepEqual([...mod.RESERVED_MCP_SERVER_IDS], ['github']);

  // 建库：命名 GitHub / github 都必须落到第三方命名空间
  assert.equal(mod.makeMcpServerId('My Notes!'), 'my-notes', '非保留字不受影响（行为不回退）');
  assert.notEqual(mod.makeMcpServerId('GitHub'), 'github');
  assert.match(mod.makeMcpServerId('GitHub'), /^github-[a-z0-9]+$/);
  assert.notEqual(mod.makeMcpServerId('github'), 'github');
  assert.notEqual(mod.makeMcpServerId('GH ithub'), 'github');

  // 读盘/写入兜底：存储里的 id='github'（手改或旧数据）被拉回第三方命名空间
  const once = mod.normalizeMcpServers([{ id: 'github', name: 'My GitHub', endpoint: 'https://x/mcp' }]);
  assert.equal(once.length, 1);
  assert.notEqual(once[0].id, 'github', '列表里的记录不得保留内置 id');
  // 尾缀必须**固定**：normalize 每次读盘都跑，随机 id 会让前缀每次都变、已注册工具成幽灵
  assert.equal(mod.normalizeMcpServers(once)[0].id, once[0].id);
  const upserted = mod.upsertMcpServer([], { id: 'github', name: 'X', endpoint: 'https://x/mcp' });
  assert.notEqual(upserted[0].id, 'github', '写入路径同样改寫');

  // 分级仍按第三方默认 CONFIRM——这正是本 bug 的核心危害点
  assert.equal(classifyMcpTool('search_code', { serverId: once[0].id }), MCP_TOOL_TIERS.CONFIRM);
  assert.equal(classifyMcpTool('get_file_contents', { serverId: once[0].id }), MCP_TOOL_TIERS.CONFIRM);

  // 内置 GitHub 记录本身必须保住 id='github'
  const builtin = mod.serverFromGithubSettings({ githubToken: 'tok', endpoint: 'https://mcp.example/mcp' });
  assert.equal(builtin.id, 'github', '内置记录被改写 = 白名单语义与 github_ 前缀全废');
  assert.equal(classifyMcpTool('get_file_contents', { serverId: builtin.id }), MCP_TOOL_TIERS.READONLY);
  // 而且它**经列表路径也不能被改写**：迁移（migrateGithubServer）会把内置记录写进服务器列表，
  // 那里若按「保留字一律改写」一刀切，会打断 ALREADY_MIGRATED 判定、并把内置 GitHub
  // 降级成第三方（前缀与分级全变）——所以判据是 builtin 标记，不是「在不在列表里」。
  const inList = mod.normalizeMcpServers([builtin]);
  assert.equal(inList[0].id, 'github', '带 builtin 标记的记录在列表里也必须保留 id');
  assert.equal(inList[0].builtin, true, 'builtin 标记要能跨读写存活');
  // 没有标记的记录即便 id 撞车，也拿不到内置语义
  assert.equal(mod.normalizeMcpServers([{ id: 'github', name: 'Fake', endpoint: 'https://x/mcp' }])[0].builtin, false);
});

// BUG-2 同类硬化：空 serverId 不得拿到白名单语义，应落到第三方默认（多问一次，不少问一次）。
test('分级硬化：空 serverId 落到第三方默认 CONFIRM，不再走内置白名单', () => {
  assert.equal(classifyMcpTool('search_code', { serverId: '' }), MCP_TOOL_TIERS.CONFIRM);
  assert.equal(classifyMcpTool('search_code', { serverId: null }), MCP_TOOL_TIERS.CONFIRM);
  assert.equal(classifyMcpTool('search_code', { serverId: 'github' }), MCP_TOOL_TIERS.READONLY, '内置语义不变');
  assert.equal(classifyMcpTool('search_code'), MCP_TOOL_TIERS.READONLY, '不传第二参仍回内置分支（向后兼容）');
  assert.equal(classifyMcpTool('delete_file', { serverId: '' }), MCP_TOOL_TIERS.DENIED, '硬禁与 serverId 无关');
});

// BUG-1（P1）：无 token 的第三方服务器。client 层是「有 token 才加 Authorization」，
// 空 token 合法（本地自建 / 无鉴权服务器就靠这条通路）；会话闸门却曾要求 token 非空 →
// 「连接测试通过、工具注册成功、每次调用都报未连接」，文案还把人指去重连（重连修不好）。
//
// 注意：**必须不传 sessionFactory**——那个桩在 token 检查之前就 return 了（见
// acquireServerSession 第一行），用它写的测试根本盖不到这个 bug。这里起真实 http 桩，
// 走完整闸门 + 真实握手。
test('无 token 的服务器也能调用（BUG-1 回归，走真实闸门与握手）', async () => {
  const http = await import('node:http');
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}');
    seen.push({ method: parsed.method, auth: req.headers.authorization || '' });
    if (parsed.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-local' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: parsed.id,
        result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'local' } },
      }));
    } else if (parsed.method === 'notifications/initialized') {
      res.writeHead(202); res.end();
    } else if (parsed.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: parsed.id,
        result: { content: [{ type: 'text', text: 'tokenless-ok' }] },
      }));
    } else {
      res.writeHead(400); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
    const result = await callMcpTool(
      { id: 'local-nocred', name: 'Local Server', endpoint, mcpToken: '' },
      'search_notes',
      {},
      {},
    );
    assert.equal(result.isError, false, `无 token 也必须能调用，实际：${result.content}`);
    assert.match(result.content, /tokenless-ok/);
    assert.equal(seen[0].method, 'initialize', '确实走到了会话握手');
    assert.equal(seen[0].auth, '', '无 token 时不加 Authorization 头（client 层既有行为）');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// BUG-3（P3）：错误码表必须覆盖 client 实际会抛的每个 code，否则英文原文漏进模型上下文。
test('错误码表：MCP_TIMEOUT / MCP_NO_FETCH 有中文口径（BUG-3）', async () => {
  const throwWith = code => ({
    sessionFactory: () => ({
      callTool: async () => { const error = new Error('MCP request timed out after 30s.'); error.code = code; throw error; },
      close() {},
    }),
  });
  const timeout = await callMcpTool(
    { id: 'demo-timeout', name: 'Demo', endpoint: 'https://d/mcp', mcpToken: 't' },
    'search_notes', {}, throwWith('MCP_TIMEOUT'),
  );
  assert.equal(timeout.isError, true);
  assert.equal(/timed out|MCP request/.test(timeout.content), false, '英文原文不得进模型上下文');
  assert.match(timeout.content, /超时/);

  const noFetch = await callMcpTool(
    { id: 'demo-nofetch', name: 'Demo', endpoint: 'https://d/mcp', mcpToken: 't' },
    'search_notes', {}, throwWith('MCP_NO_FETCH'),
  );
  assert.equal(/unavailable in this environment/.test(noFetch.content), false);
  assert.match(noFetch.content, /网络请求能力/);
});

// 结构守卫：下次给 client 补新 code 时，忘映射会在这里红（而不是等英文漏进模型上下文）。
test('结构守卫：client.js 会抛的每个 code 都在错误码表里有中文口径', () => {
  const client = fs.readFileSync(path.resolve('src/mcp/client.js'), 'utf8');
  const tools = fs.readFileSync(path.resolve('src/workspace/mcpTools.js'), 'utf8');
  const thrown = [...client.matchAll(/fail\('([A-Z_]+)'/g)].map(m => m[1]);
  assert.ok(thrown.length >= 4, '至少要解析出 client 的错误码');
  const missing = [...new Set(thrown)].filter(code => !tools.includes(`${code}:`));
  assert.deepEqual(missing, [], `这些 code 缺中文口径，英文原文会漏进模型上下文：${missing.join(', ')}`);
});
