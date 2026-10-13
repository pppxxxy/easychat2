// 内置 MCP Server：协议层、访问策略、文档资源、桥接（全部纯函数，Node 直跑）。
//
// 这个文件覆盖本功能的安全面：**档位表必须覆盖所有真实工具**（新增工具忘了表态就红）、
// 写/执行档必须先给预览再带 confirm、未开启的档位一律拒绝、控制字段不得透传给工具。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { MCP_PROTOCOL_VERSION } from '../src/mcp/client.js';
import {
  MCP_ENDPOINT_PATH,
  MCP_ERROR_CODES,
  createMcpServer,
  createSessionId,
} from '../src/mcp/server.js';
import {
  MCP_ACCESS_TIERS,
  MCP_CONTROL_FIELDS,
  MCP_DEFAULT_TIERS,
  MCP_TOOL_TIERS,
  buildPreview,
  describeToolCatalog,
  isExposableTool,
  listExposedTools,
  normalizeMcpTiers,
  planToolCall,
  tierForTool,
  tierNeedsConfirm,
} from '../src/mcp/serverPolicy.js';
import {
  MCP_DOC_URIS,
  buildMcpResourceList,
  buildMcpResourceText,
} from '../src/mcp/serverDocs.js';
import {
  MCP_SERVER_EVENT_REQUEST,
  attachMcpServer,
  buildMcpConnectionText,
  buildMcpServerUrl,
  createMcpBridge,
  parseMcpServerRequest,
} from '../src/mcp/serverBridge.js';

const require = createRequire(import.meta.url);

const ALL_TIERS = { read: true, write: true, exec: true };
const READ_ONLY = { read: true, write: false, exec: false };

// ---------- 档位表的不变量：真实工具一个都不能漏 ----------

// 真实工具名从 toolDefs 直接枚举（不是手抄清单）：新增工具忘了在 serverPolicy 表态，
// 这里立刻红——「不表态 = tools/list 里没有它」，比事后发现「暴露了一个没分档的工具」安全得多。
function collectRealToolNames() {
  const dir = path.resolve('src/workspace/toolDefs');
  const names = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const mod = require(path.join(dir, file));
    for (const value of Object.values(mod)) {
      const candidates = Array.isArray(value) ? value : [value];
      for (const item of candidates) {
        if (item && typeof item === 'object' && typeof item.name === 'string') names.push(item.name);
      }
    }
  }
  return [...new Set(names)].sort();
}

const REAL_TOOL_NAMES = collectRealToolNames();

test('档位表覆盖全部真实工具：新增工具必须在 serverPolicy 里表态', () => {
  assert.ok(REAL_TOOL_NAMES.length >= 25, `应枚举到真实工具，实际 ${REAL_TOOL_NAMES.length} 个`);
  const unclassified = REAL_TOOL_NAMES.filter(name => tierForTool(name) === 'unknown');
  assert.deepEqual(unclassified, [],
    `以下工具没有分档，不会被 MCP 暴露——请在 serverPolicy.js 的 READ/WRITE/EXEC/HIDDEN 里表态：\n${unclassified.join(', ')}`);
});

test('档位表：只读档不含任何写/执行类工具，执行档覆盖最危险的几个', () => {
  // 反向不变量：不能把写工具误分到只读档（那等于默认开启写入）。
  for (const name of ['write_workspace_file', 'edit_workspace_file', 'git_commit', 'install_extension_pack', 'run_shell', 'run_python']) {
    assert.notEqual(tierForTool(name), 'read', `${name} 不得落在只读档`);
  }
  for (const name of ['run_shell', 'run_python', 'run_subagent', 'run_team', 'run_workflow', 'install_extension_pack']) {
    assert.equal(tierForTool(name), 'exec', `${name} 必须落在执行档（能间接执行或装可执行扩展）`);
  }
  // 注册表把 run_subagent/run_team/run_workflow 声明成 readOnly（read 模式下也放行），
  // 对外暴露时必须按后果重新分档——这条就是防止有人「顺手照抄 readOnly」。
  assert.equal(tierForTool('ask_user'), 'hidden', '需要当场问用户的工具不暴露');
  assert.equal(tierForTool('confirm_flow'), 'hidden', '多题确认同样需要当场有人答题（AS2）');
});

test('档位默认值：只开只读', () => {
  assert.deepEqual(normalizeMcpTiers(null), MCP_DEFAULT_TIERS);
  assert.deepEqual(normalizeMcpTiers({}), { read: true, write: false, exec: false });
  assert.deepEqual(normalizeMcpTiers({ write: true, exec: 'yes' }), { read: true, write: true, exec: false });
  assert.deepEqual(MCP_DEFAULT_TIERS, { read: true, write: false, exec: false });
  assert.deepEqual(MCP_ACCESS_TIERS, ['read', 'write', 'exec']);
  assert.equal(tierNeedsConfirm('read'), false);
  assert.equal(tierNeedsConfirm('write'), true);
  assert.equal(tierNeedsConfirm('exec'), true);
});

test('暴露过滤：聊天内工具、转发来的第三方 MCP 工具、未分档工具都不进清单', () => {
  assert.equal(isExposableTool({ name: 'read_workspace_file' }), true);
  assert.equal(isExposableTool({ name: 'search_workspace', chatTool: true }), false, '聊天内工具不进');
  assert.equal(isExposableTool({ name: 'github_search_code' }), false, '内置 GitHub 工具不进');
  assert.equal(isExposableTool({ name: 'notes__search' }), false, '第三方 MCP 工具不进');
  assert.equal(isExposableTool({ name: 'ask_user' }), false, '需要问用户的工具不进');
  assert.equal(isExposableTool({ name: 'confirm_flow' }), false, '多题确认不进（AS2）');
  assert.equal(isExposableTool({ name: 'made_up_tool' }), false, '未分档工具不进');

  const definitions = [
    { name: 'read_workspace_file', description: 'r' },
    { name: 'write_workspace_file', description: 'w' },
    { name: 'run_shell', description: 'x' },
  ];
  assert.deepEqual(listExposedTools(definitions, READ_ONLY).map(i => i.definition.name), ['read_workspace_file']);
  assert.deepEqual(listExposedTools(definitions, ALL_TIERS).map(i => i.tier), ['read', 'write', 'exec']);
  assert.deepEqual(describeToolCatalog(definitions).map(i => `${i.name}:${i.tier}`),
    ['read_workspace_file:read', 'write_workspace_file:write', 'run_shell:exec']);
});

test('planToolCall：档位未开 → 拒绝，且说明去哪儿开', () => {
  const definition = { name: 'write_workspace_file', description: '写文件' };
  const denied = planToolCall({ name: 'write_workspace_file', definition, args: { path: 'a' }, tiers: READ_ONLY });
  assert.equal(denied.kind, 'denied');
  assert.equal(denied.tier, 'write');
  assert.match(denied.message, /未开启/);
  assert.match(denied.message, /设置/);
  // 只读档也能被关掉
  const readOff = planToolCall({ name: 'read_workspace_file', definition: { name: 'read_workspace_file' }, args: {}, tiers: { read: false } });
  assert.equal(readOff.kind, 'denied');
});

test('planToolCall：只读档直接执行，控制字段被剥离', () => {
  const plan = planToolCall({
    name: 'read_workspace_file',
    definition: { name: 'read_workspace_file', description: 'r' },
    args: { path: 'a.md', confirm: true, preview: true, character_id: 'c1' },
    tiers: READ_ONLY,
  });
  assert.equal(plan.kind, 'execute');
  assert.deepEqual(plan.args, { path: 'a.md' });
  assert.equal(plan.controls.character_id, 'c1');
  // 控制字段名就是契约：增删要同步这里与文档
  assert.deepEqual(MCP_CONTROL_FIELDS, ['confirm', 'preview', 'character_id']);
});

test('planToolCall：写入/执行档第一次只给预览，confirm 后才执行', () => {
  const definition = { name: 'write_workspace_file', description: '把内容写进工作区文件' };
  const preview = planToolCall({ name: 'write_workspace_file', definition, args: { path: 'a.md', content: 'hi' }, tiers: ALL_TIERS });
  assert.equal(preview.kind, 'preview');
  assert.equal(preview.tier, 'write');
  assert.match(preview.message, /未执行/);
  assert.match(preview.message, /confirm: true/);
  assert.match(preview.message, /a\.md/, '预览要带上完整参数');

  const confirmed = planToolCall({ name: 'write_workspace_file', definition, args: { path: 'a.md', content: 'hi', confirm: true }, tiers: ALL_TIERS });
  assert.equal(confirmed.kind, 'execute');
  assert.deepEqual(confirmed.args, { path: 'a.md', content: 'hi' }, 'confirm 不得透传给工具');

  // preview:true 即使带了 confirm 也只预览（显式只要预览优先）
  const forcedPreview = planToolCall({ name: 'write_workspace_file', definition, args: { confirm: true, preview: true }, tiers: ALL_TIERS });
  assert.equal(forcedPreview.kind, 'preview');
  // 执行档同理
  const execPlan = planToolCall({ name: 'run_shell', definition: { name: 'run_shell', description: '跑命令' }, args: { command: 'ls' }, tiers: ALL_TIERS });
  assert.equal(execPlan.kind, 'preview');
  assert.equal(execPlan.tier, 'exec');
});

test('planToolCall：未分档 / 隐藏 / 未知工具一律拒绝', () => {
  assert.equal(planToolCall({ name: 'nope', definition: null, args: {}, tiers: ALL_TIERS }).kind, 'denied');
  assert.equal(planToolCall({ name: 'ask_user', definition: { name: 'ask_user' }, args: {}, tiers: ALL_TIERS }).kind, 'denied');
  assert.match(planToolCall({ name: 'ask_user', definition: { name: 'ask_user' }, args: {}, tiers: ALL_TIERS }).message, /不通过 MCP 暴露/);
  // 坏参数（数组/字符串）按空对象处理，不炸
  assert.deepEqual(planToolCall({ name: 'read_workspace_file', definition: { name: 'read_workspace_file' }, args: 'oops', tiers: READ_ONLY }).args, {});
  assert.equal(buildPreview({ name: 'x', tier: 'write', args: { a: 1 } }).includes('"a":1'), true);
});

// ---------- 协议层 ----------

function makeServer(overrides = {}) {
  const calls = [];
  const server = createMcpServer({
    random: () => 0.5,
    now: () => 1700000000000,
    listTools: async () => [{ name: 'read_workspace_file', description: 'r', inputSchema: { type: 'object' } }],
    callTool: async ({ name, args }) => {
      calls.push({ name, args });
      return { content: `ok:${name}`, isError: false };
    },
    listResources: () => [{ uri: 'easychat://docs/tools', name: 'tools' }],
    readResource: async ({ uri }) => (uri === 'easychat://docs/tools' ? { text: '# docs' } : null),
    ...overrides,
  });
  return { server, calls };
}

const post = (body, extra = {}) => ({ method: 'POST', sessionId: '', headers: { accept: 'application/json' }, body, ...extra });

test('协议：initialize 下发会话 id 与能力，之后带会话 id 才认', async () => {
  const { server } = makeServer();
  const res = await server.handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: 'x' } } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(res.body.result.serverInfo.name, 'easychat2');
  assert.equal(res.body.result.capabilities.tools.listChanged, false);
  assert.deepEqual(res.body.result.capabilities.resources, { subscribe: false, listChanged: false });
  assert.equal(res.body.result.instructions, undefined, '没传 instructions 就不塞这个字段');
  const sid = res.headers['Mcp-Session-Id'];
  assert.ok(sid && sid.length === 32, '会话 id 是 32 位十六进制');

  // 认得的会话：正常应答
  const ok = await server.handle(post({ jsonrpc: '2.0', id: 2, method: 'ping' }, { sessionId: sid }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.result, {});
  // 不认得的会话：404（客户端据此重新 initialize，规范如此）
  const stale = await server.handle(post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { sessionId: 'deadbeef' }));
  assert.equal(stale.status, 404);
  // 不带会话 id 一律宽容放行（很多客户端不实现会话）
  const noSession = await server.handle(post({ jsonrpc: '2.0', id: 4, method: 'ping' }));
  assert.equal(noSession.status, 200);
});

test('协议：通知返回 202 且无响应体；未实现方法 -32601；非法请求 400', async () => {
  const { server } = makeServer();
  const note = await server.handle(post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.status, 202);
  assert.equal(note.body, null);

  const unknown = await server.handle(post({ jsonrpc: '2.0', id: 9, method: 'tools/execute' }));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.error.code, MCP_ERROR_CODES.METHOD_NOT_FOUND);

  const broken = await server.handle({ method: 'POST', headers: {}, body: '{ not json' });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.error.code, MCP_ERROR_CODES.PARSE_ERROR);
});

test('协议：GET 405（不提供 SSE 推送）、DELETE 结束会话、Accept 不含 json 406', async () => {
  const { server } = makeServer();
  const get = await server.handle({ method: 'GET', headers: {}, body: null });
  assert.equal(get.status, 405);
  assert.equal(get.headers.Allow, 'POST, DELETE');

  const sid = (await server.handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize' }))).headers['Mcp-Session-Id'];
  const del = await server.handle({ method: 'DELETE', sessionId: sid, headers: {}, body: null });
  assert.equal(del.status, 200);
  assert.equal(del.body.removed, true);
  assert.equal(server.sessions.has(sid), false, '会话被清掉');
  // 再带这个 id 就是 404
  assert.equal((await server.handle(post({ jsonrpc: '2.0', id: 5, method: 'ping' }, { sessionId: sid }))).status, 404);

  const badAccept = await server.handle(post({ jsonrpc: '2.0', id: 6, method: 'ping' }, { headers: { accept: 'text/html' } }));
  assert.equal(badAccept.status, 406);
});

test('协议：tools/list 与 tools/call 的形状（content[].text / isError）', async () => {
  const { server, calls } = makeServer();
  const list = await server.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['read_workspace_file']);

  const call = await server.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_workspace_file', arguments: { path: 'a' } } }));
  assert.deepEqual(call.body.result.content, [{ type: 'text', text: 'ok:read_workspace_file' }]);
  assert.equal(call.body.result.isError, false);
  assert.deepEqual(calls, [{ name: 'read_workspace_file', args: { path: 'a' } }]);

  // 缺 name → JSON-RPC 参数错误（协议错误与工具失败必须分得开）
  const missing = await server.handle(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} }));
  assert.equal(missing.body.error.code, MCP_ERROR_CODES.INVALID_PARAMS);

  // 工具自己报错 → result.isError=true，不是 JSON-RPC error
  const failing = makeServer({ callTool: async () => ({ content: '炸了', isError: true }) }).server;
  const failed = await failing.handle(post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x' } }));
  assert.equal(failed.body.result.isError, true);
  assert.equal(failed.body.result.content[0].text, '炸了');
  assert.equal(failed.body.error, undefined);

  // 工具抛异常 → 兜成 INTERNAL_ERROR 的 JSON-RPC 错误
  const throwing = makeServer({ callTool: async () => { throw new Error('boom'); } }).server;
  const threw = await throwing.handle(post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x' } }));
  assert.equal(threw.body.error.code, MCP_ERROR_CODES.INTERNAL_ERROR);
});

test('协议：resources/list、resources/read、templates、prompts', async () => {
  const { server } = makeServer();
  const list = await server.handle(post({ jsonrpc: '2.0', id: 1, method: 'resources/list' }));
  assert.deepEqual(list.body.result.resources.map(r => r.uri), ['easychat://docs/tools']);
  const read = await server.handle(post({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'easychat://docs/tools' } }));
  assert.equal(read.body.result.contents[0].text, '# docs');
  assert.equal(read.body.result.contents[0].mimeType, 'text/plain');
  const missing = await server.handle(post({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'easychat://nope' } }));
  assert.equal(missing.body.error.code, MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
  assert.deepEqual((await server.handle(post({ jsonrpc: '2.0', id: 4, method: 'resources/templates/list' }))).body.result.resourceTemplates, []);
  assert.deepEqual((await server.handle(post({ jsonrpc: '2.0', id: 5, method: 'prompts/list' }))).body.result.prompts, []);
});

test('协议：会话 id 由注入的随机源决定（可测）', async () => {
  assert.equal(createSessionId(() => 0), '00000000000000000000000000000000');
  assert.equal(createSessionId(() => 0.5).length, 32);
  assert.notEqual(createSessionId(), createSessionId());
});

// ---------- 文档资源 ----------

test('文档资源：清单随档位变化，正文包含当前档位与调用约定', () => {
  const catalog = describeToolCatalog([
    { name: 'read_workspace_file', description: '读文件\n第二行' },
    { name: 'write_workspace_file', description: '写文件' },
    { name: 'run_shell', description: '跑命令' },
  ]);
  const resources = buildMcpResourceList({ catalog, tiers: READ_ONLY });
  assert.deepEqual(resources.map(r => r.uri), [
    MCP_DOC_URIS.TOOLS, MCP_DOC_URIS.WRITE_SAFETY, MCP_DOC_URIS.ACCESS, MCP_DOC_URIS.WORKSPACE,
  ]);
  assert.match(resources[0].description, /只读 1 \/ 写入 1 \/ 执行 1/);

  const tools = buildMcpResourceText({ uri: MCP_DOC_URIS.TOOLS, catalog, tiers: READ_ONLY });
  assert.match(tools, /只读.*已开启/s);
  assert.match(tools, /write.*未开启/s);
  assert.match(tools, /confirm: true/);
  assert.match(tools, /read_workspace_file.*读文件/s);
  assert.ok(!tools.includes('第二行'), '工具描述只取首行');

  const safety = buildMcpResourceText({ uri: MCP_DOC_URIS.WRITE_SAFETY, catalog, tiers: READ_ONLY });
  assert.match(safety, /isError: true/);
  assert.match(safety, /结果未知/, '超时语义要写清（别盲目重跑写操作）');
  assert.match(safety, /before_tool/, '钩子 deny 仍生效要写清');

  const access = buildMcpResourceText({ uri: MCP_DOC_URIS.ACCESS, catalog, tiers: ALL_TIERS });
  assert.match(access, /write（写入）：已开启/);

  const workspace = buildMcpResourceText({
    uri: MCP_DOC_URIS.WORKSPACE,
    catalog,
    tiers: READ_ONLY,
    workspace: { kind: 'app', root: 'easychat2-workspace' },
  });
  assert.match(workspace, /easychat2-workspace/);
  assert.match(workspace, /character_id/);
  // 拿不到根描述时给「由设置决定」的措辞，而不是编一个路径
  assert.match(buildMcpResourceText({ uri: MCP_DOC_URIS.WORKSPACE, catalog, tiers: READ_ONLY }), /由 App 的工作区设置决定/);
  assert.equal(buildMcpResourceText({ uri: 'easychat://nope', catalog, tiers: READ_ONLY }), null);
});

// ---------- 桥接 ----------

test('桥接：事件契约解析（JSON 字符串 / 对象 / 坏输入）', () => {
  const fromString = parseMcpServerRequest(JSON.stringify({
    requestId: 'r1',
    method: 'post',
    headers: { accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  }));
  assert.equal(fromString.requestId, 'r1');
  assert.equal(fromString.method, 'POST');
  assert.equal(fromString.path, MCP_ENDPOINT_PATH);
  assert.equal(fromString.body.method, 'ping');
  assert.equal(fromString.sessionId, '');

  const withSession = parseMcpServerRequest({ requestId: 'r2', body: {}, headers: { 'mcp-session-id': 'abc' } });
  assert.equal(withSession.sessionId, 'abc');
  assert.deepEqual(withSession.body, {}, '已经是对象就直接用（原生永远发字符串，这是给 JS 调用方的宽容）');
  // 原生对 GET/DELETE 发空串 → 解析失败 → null（协议层按「无请求体」处理）
  assert.equal(parseMcpServerRequest({ requestId: 'r3', method: 'GET', body: '' }).body, null);

  assert.equal(parseMcpServerRequest('not-json'), null);
  assert.equal(parseMcpServerRequest({ body: {} }), null, '缺 requestId 直接丢');
  assert.equal(parseMcpServerRequest(null), null);
});

test('桥接：端到端（列工具 / 只读执行 / 写入预览→确认 / 执行档未开）', async () => {
  const definitions = [
    { name: 'read_workspace_file', description: '读', parameters: { type: 'object', properties: {} } },
    { name: 'write_workspace_file', description: '写', parameters: { type: 'object', properties: {} } },
    { name: 'run_shell', description: '跑', parameters: { type: 'object', properties: {} } },
  ];
  const executed = [];
  let tiers = READ_ONLY;
  const bridge = createMcpBridge({
    readSettings: async () => ({ tiers }),
    listDefinitions: () => definitions,
    executeTool: async ({ name, args, tier }) => {
      executed.push({ name, args, tier });
      return { content: `${name} done`, isError: false };
    },
    workspaceInfo: async () => ({ kind: 'app', root: 'ws' }),
    random: () => 0.25,
  });

  // 握手：instructions 必须指路到文档资源（agent 靠它知道去哪读当前事实）
  const init = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} } });
  assert.match(init.body.result.instructions, /easychat:\/\/docs\/tools/);
  assert.ok(init.headers['Mcp-Session-Id'], 'initialize 下发会话 id');

  const list = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: { accept: 'application/json' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['read_workspace_file'], '只读档只列只读工具');
  assert.deepEqual(list.body.result.tools[0].inputSchema, { type: 'object', properties: {} });
  assert.equal(list.body.result.tools[0]._meta.tier, 'read');

  const read = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_workspace_file', arguments: { path: 'a' } } } });
  assert.equal(read.body.result.isError, false);
  assert.deepEqual(executed, [{ name: 'read_workspace_file', args: { path: 'a' }, tier: 'read' }]);

  // 写入档未开 → 拒绝（不是预览）
  const denied = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_workspace_file', arguments: { path: 'a', content: 'x' } } } });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /未开启/);
  assert.equal(executed.length, 1);

  // 打开写入档：第一次预览（不执行），带 confirm 才执行
  tiers = { read: true, write: true, exec: false };
  const preview = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_workspace_file', arguments: { path: 'a', content: 'x' } } } });
  assert.equal(preview.body.result.isError, true);
  assert.equal(preview.body.result.structuredContent.preview, true);
  assert.match(preview.body.result.content[0].text, /未执行/);
  assert.equal(executed.length, 1, '预览阶段绝不执行');

  const confirmed = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'write_workspace_file', arguments: { path: 'a', content: 'x', confirm: true, character_id: 'c9' } } } });
  assert.equal(confirmed.body.result.isError, false);
  assert.deepEqual(executed[1], { name: 'write_workspace_file', args: { path: 'a', content: 'x' }, tier: 'write' });

  // 执行档未开：run_shell 连预览都没有
  const execDenied = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_shell', arguments: { command: 'ls', confirm: true } } } });
  assert.match(execDenied.body.result.content[0].text, /未开启/);

  // 资源：文档里能看到当前档位
  const docs = await bridge.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: MCP_DOC_URIS.WORKSPACE } } });
  assert.match(docs.body.result.contents[0].text, /ws/);

  // 非 /mcp 路径 404
  assert.equal((await bridge.handleEvent({ method: 'POST', path: '/v1/models', headers: {}, body: {} })).status, 404);
  // 执行器抛异常 → 工具级失败，不是协议错误
  const broken = createMcpBridge({
    readSettings: async () => ({ tiers: ALL_TIERS }),
    listDefinitions: () => definitions,
    executeTool: async () => { throw new Error('workspace down'); },
  });
  const failed = await broken.handleEvent({ method: 'POST', path: MCP_ENDPOINT_PATH, headers: {}, body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'read_workspace_file', arguments: {} } } });
  assert.equal(failed.body.result.isError, true);
  assert.match(failed.body.result.content[0].text, /workspace down/);
});

test('桥接：attach 串行处理并把结果回写（坏事件不回写）', async () => {
  const replied = [];
  let listener = null;
  const bridge = createMcpBridge({
    readSettings: async () => ({ tiers: READ_ONLY }),
    listDefinitions: () => [],
  });
  const detach = attachMcpServer({
    bridge,
    addListener: cb => { listener = cb; return () => { listener = null; }; },
    respond: async (requestId, outcome) => { replied.push({ requestId, status: outcome.status }); },
  });
  assert.equal(typeof listener, 'function');
  listener(JSON.stringify({ requestId: 'r1', method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
  listener('not-json');
  listener({ requestId: 'r2', method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'ping' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(replied.map(r => r.requestId), ['r1', 'r2'], '坏事件被丢弃，好事件都回写');
  assert.ok(replied.every(r => r.status === 200));
  assert.equal(MCP_SERVER_EVENT_REQUEST, 'McpServer:onRequest');
  detach();
  assert.equal(listener, null, 'detach 摘掉监听');
});

test('桥接：地址与「完整连接配置」文本', () => {
  assert.equal(buildMcpServerUrl({ scope: 'loopback', port: 8737 }), 'http://127.0.0.1:8737/mcp');
  assert.equal(buildMcpServerUrl({ scope: 'lan', port: 8737, lanIp: '192.168.1.5' }), 'http://192.168.1.5:8737/mcp');
  assert.equal(buildMcpServerUrl({ scope: 'lan', port: 8737, lanIp: '' }), 'http://<本机局域网 IP>:8737/mcp');
  assert.equal(buildMcpServerUrl({ scope: 'lan', port: 8737, lanIp: '0.0.0.0' }), 'http://<本机局域网 IP>:8737/mcp', '通配地址不能当对外地址展示');
  const text = buildMcpConnectionText({ url: 'http://127.0.0.1:8737/mcp', token: 'abc123', version: '1.0.0' });
  assert.equal(text, [
    'easychat2 MCP Server: 1.0.0',
    'Preferred access: direct HTTP JSON-RPC',
    'Server URL: http://127.0.0.1:8737/mcp',
    'Authorization: Bearer abc123',
  ].join('\n'));
});

test('档位表与文档自洽：每个分档的工具都能在 docs 里查到档位', () => {
  const tiers = Object.entries(MCP_TOOL_TIERS);
  assert.ok(tiers.length >= REAL_TOOL_NAMES.length, '分档条目不得少于真实工具数（允许含尚未在 main 上的占位工具）');
  for (const [name, tier] of tiers) {
    assert.ok(['read', 'write', 'exec', 'hidden'].includes(tier), `${name} 的档位非法：${tier}`);
  }
});
