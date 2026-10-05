// MCP 风险分级 + agent 注册桥 + 审批文案测试。
// 白名单分级是本功能的安全核心：删除/强推/管理类**无条件拒绝**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MCP_TOOL_TIERS,
  classifyMcpTool,
  filterMcpToolsForRegistration,
} from '../src/mcp/riskGate.js';
import {
  callGithubMcpTool,
  mcpGateReason,
  registerGithubMcpTools,
  unregisterGithubMcpTools,
} from '../src/workspace/mcpTools.js';
import { clearTools, getTool, listRegisteredTools, runTool } from '../src/agent/tools/registry.js';
import { describeToolApproval } from '../src/chat/toolApproval.js';

test('classifyMcpTool：白名单三级 + 硬禁形态 + 默认拒绝', () => {
  assert.equal(classifyMcpTool('get_file_contents'), MCP_TOOL_TIERS.READONLY);
  assert.equal(classifyMcpTool('list_branches'), MCP_TOOL_TIERS.READONLY);
  assert.equal(classifyMcpTool('get_me'), MCP_TOOL_TIERS.READONLY);
  assert.equal(classifyMcpTool('create_or_update_file'), MCP_TOOL_TIERS.CONFIRM);
  assert.equal(classifyMcpTool('push_files'), MCP_TOOL_TIERS.CONFIRM);
  assert.equal(classifyMcpTool('create_branch'), MCP_TOOL_TIERS.CONFIRM);
  // 用户裁决：删除分支等高危操作无条件禁止。
  assert.equal(classifyMcpTool('delete_branch'), MCP_TOOL_TIERS.DENIED);
  assert.equal(classifyMcpTool('delete_file'), MCP_TOOL_TIERS.DENIED);
  assert.equal(classifyMcpTool('delete_repository'), MCP_TOOL_TIERS.DENIED);
  // 形态安全网：即使未来白名单手滑收了带 delete/force 的名字也拦得住。
  assert.equal(classifyMcpTool('force_push'), MCP_TOOL_TIERS.DENIED);
  assert.equal(classifyMcpTool('admin_list_orgs'), MCP_TOOL_TIERS.DENIED);
  // 未知工具默认拒绝（白名单制，不因服务端扩工具而漏）。
  assert.equal(classifyMcpTool('some_brand_new_tool'), MCP_TOOL_TIERS.DENIED);
  assert.equal(classifyMcpTool(''), MCP_TOOL_TIERS.DENIED);
});

test('filterMcpToolsForRegistration：过滤输出 allowed/denied 两侧', () => {
  const { allowed, deniedNames } = filterMcpToolsForRegistration([
    { name: 'get_file_contents', description: 'read', inputSchema: { type: 'object', properties: {} } },
    { name: 'delete_branch', description: 'nope' },
    { name: 'push_files', description: 'push' },
    { name: '' },
    null,
  ]);
  assert.deepEqual(allowed.map(item => item.name), ['get_file_contents', 'push_files']);
  assert.deepEqual(allowed.map(item => item.tier), ['readonly', 'confirm']);
  assert.deepEqual(deniedNames, ['delete_branch']);
});

test('mcpGateReason：开关/目录两种拒绝原因', () => {
  assert.equal(mcpGateReason({ enabled: true, toolCatalog: [{}] }), '');
  assert.equal(mcpGateReason({ enabled: false, toolCatalog: [{}] }), 'SWITCH_OFF');
  assert.equal(mcpGateReason({ enabled: true, toolCatalog: [] }), 'NO_CATALOG');
  assert.equal(mcpGateReason(null), 'SWITCH_OFF');
});

const SETTINGS = {
  enabled: true,
  authMethod: 'pat',
  endpoint: 'https://mcp.example/mcp/',
  githubToken: 'tok',
  toolCatalog: [
    { name: 'get_file_contents', description: 'read a file', parameters: { type: 'object', properties: {} } },
    { name: 'create_or_update_file', description: 'write a file', parameters: { type: 'object', properties: {} } },
    { name: 'delete_branch', description: 'must never register' },
  ],
};

test('registerGithubMcpTools：只读/确认分级进注册表，禁类不注册，执行走双保险', async () => {
  clearTools();
  const calls = [];
  const registered = registerGithubMcpTools(SETTINGS, {
    sessionFactory: () => ({
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: `did:${name}` }], isError: false };
      },
      close() {},
    }),
  });
  assert.deepEqual(registered, ['github_get_file_contents', 'github_create_or_update_file']);
  const readOnly = getTool('github_get_file_contents');
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.requiresConfirmation, false);
  const confirm = getTool('github_create_or_update_file');
  assert.equal(confirm.requiresConfirmation, true, '写入类必须逐次确认');
  assert.equal(getTool('github_delete_branch'), null, '禁类工具不得出现在注册表');

  // 执行层双保险：绕过注册表直接调被禁工具也进不去。
  const denied = await callGithubMcpTool(SETTINGS, 'delete_branch', {});
  assert.equal(denied.isError, true);
  assert.match(denied.content, /安全策略禁止/);
  assert.equal(calls.length, 0, '被禁调用绝不触达会话');

  // 经注册表跑通一次只读调用。
  const result = await runTool({ name: 'github_get_file_contents', arguments: { path: 'a.md' } }, { mode: 'write' });
  assert.equal(result.isError, false);
  assert.equal(result.content, 'did:get_file_contents');
  assert.deepEqual(calls[0].args, { path: 'a.md' });

  unregisterGithubMcpTools();
  assert.equal(listRegisteredTools().length, 0, '摘除必须清干净');
});

test('confirm 工具：无审批钩子即拒绝，用户拒绝不执行', async () => {
  clearTools();
  let executed = 0;
  registerGithubMcpTools(SETTINGS, {
    sessionFactory: () => ({
      callTool: async name => {
        executed += 1;
        return { content: [{ type: 'text', text: `did:${name}` }], isError: false };
      },
      close() {},
    }),
  });
  // 无 confirm：registry 的「问不到 = 不执行」。
  const refused = await runTool({ name: 'github_create_or_update_file', arguments: {} }, { mode: 'write' });
  assert.equal(refused.isError, true);
  assert.match(refused.content, /需要用户确认/);
  assert.equal(executed, 0);
  // 有 confirm 且拒绝：仍不执行。
  const denied = await runTool(
    { name: 'github_create_or_update_file', arguments: {} },
    { mode: 'write', confirm: async () => false }
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /用户拒绝/);
  assert.equal(executed, 0);
  unregisterGithubMcpTools();
});

test('ensureGithubMcpToolsRegistered：读设置决定注册/摘除', async () => {
  clearTools();
  const mcpTools = await import('../src/workspace/mcpTools.js');
  registerGithubMcpTools(SETTINGS, { sessionFactory: () => ({ callTool: async () => ({}), close() {} }) });
  assert.ok(listRegisteredTools().length > 0);
  const registered = await mcpTools.ensureGithubMcpToolsRegistered({
    getSettings: async () => ({ enabled: false, toolCatalog: [] }),
  });
  assert.deepEqual(registered, [], '未连接时必须全部摘除');
  assert.equal(listRegisteredTools().length, 0);
});

test('审批文案：无命令字段时亮出参数摘要（不盲签）', () => {
  const translate = (key, params) => (key === 'chat.tool.approval.bodyArgs' ? `ARGS:${params.args}` : key);
  const copy = describeToolApproval({
    name: 'github_create_or_update_file',
    args: { path: 'docs/a.md', content: 'hello' },
    t: translate,
  });
  assert.match(copy.body, /ARGS:/);
  assert.match(copy.body, /docs\/a\.md/);
  const bodyTranslate = (key, params) => (key === 'chat.tool.approval.body' ? `CMD:${params.command}` : key);
  const shellCopy = describeToolApproval({ name: 'run_shell', args: { command: 'ls -la' }, t: bodyTranslate });
  assert.match(shellCopy.body, /CMD:ls -la/);
  const emptyCopy = describeToolApproval({ name: 'x', args: {}, t: key => key });
  assert.equal(emptyCopy.body, 'chat.tool.approval.bodyEmpty');
});

test('形态安全网：模式必须真实存在，且两张白名单里不得混入禁类形态的名字', () => {
  const source = fs.readFileSync(path.resolve('src/mcp/riskGate.js'), 'utf8');
  assert.ok(
    source.includes("const FORBIDDEN_NAME_PATTERN = /(^|_)(delete|remove|force|admin)(_|$)/i;"),
    '禁类形态模式不可被移除/放宽'
  );
  for (const setLine of source.split('\n').filter(line => line.includes('.add(') || line.includes("',"))) {
    const names = [...setLine.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
    for (const name of names) {
      assert.doesNotMatch(
        name,
        /(^|_)(delete|remove|force|admin)(_|$)/i,
        `白名单不得收录禁类形态的名字：${name}`
      );
    }
  }
});

test('接线源码断言：useChatSend 挂载 ensureGithubMcpToolsRegistered；硬禁文案钉死', () => {
  const send = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  // 锚在行首：注释掉的同名调用（// await ...）不算挂载（注入验证抓过这个盲区）。
  assert.match(
    send,
    /^\s*await ensureGithubMcpToolsRegistered\(\);/m,
    'agent 回合必须先挂载/摘除 MCP 工具再列工具表'
  );
  const tools = fs.readFileSync(path.resolve('src/workspace/mcpTools.js'), 'utf8');
  assert.ok(tools.includes('classifyMcpTool(mcpName) === MCP_TOOL_TIERS.DENIED'), '执行层双保险必须存在');
  assert.ok(tools.includes('安全策略禁止此操作'), '硬禁提示必须明确不可解锁');
});
