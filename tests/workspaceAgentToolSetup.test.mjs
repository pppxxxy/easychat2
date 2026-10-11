// W7：工作区 agent 的工具装配（src/workspace/agentToolSetup.js）。
//
// 从 ChatPanel 外提的那段：注册工具 + 冻结顺序签名。以前「顺序漂移 = 前缀缓存全 miss」
// 这条纪律只能靠源码字符串断言，现在它是可直测的返回值。

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerWorkspaceAgentTools } from '../src/workspace/agentToolSetup.js';
import { registerTool, unregisterTool } from '../src/agent/tools/registry.js';

const TOOL_NAMES = ['read_workspace_file', 'search_workspace', 'write_workspace_file'];

function fakeRegister() {
  const seen = [];
  const execute = async () => ({ content: '' });
  const register = (settings, extras) => {
    seen.push({ settings, extras });
    for (const name of TOOL_NAMES) unregisterTool(name);
    registerTool({ name: 'read_workspace_file', description: '', parameters: {}, readOnly: true, execute });
    registerTool({ name: 'search_workspace', description: '', parameters: {}, readOnly: true, execute });
    registerTool({ name: 'write_workspace_file', description: '', parameters: {}, readOnly: false, execute });
    return TOOL_NAMES;
  };
  register.seen = seen;
  return register;
}

test('ask 模式：不注册、不签名（与旧行为逐字一致）', async () => {
  const register = fakeRegister();
  const result = await registerWorkspaceAgentTools({ settings: {}, mode: 'ask', register, registerMcp: null });
  assert.deepEqual(result, { tools: [], signature: '', prevSignature: '', drifted: false });
  assert.equal(register.seen.length, 0, 'ask 模式不碰注册表');
});

test('read 模式：注册后返回只读工具与顺序签名', async () => {
  const register = fakeRegister();
  const result = await registerWorkspaceAgentTools({ settings: {}, mode: 'read', register, registerMcp: null });
  assert.deepEqual(result.tools.map(item => item.function.name), ['read_workspace_file', 'search_workspace']);
  assert.equal(result.signature, 'read_workspace_file,search_workspace', '签名按注册表顺序');
  assert.equal(result.drifted, false, '首次没有「上一次」可比');
});

test('顺序漂移：与上一次签名不同才为 true（mode 切换不算漂移）', async () => {
  const register = fakeRegister();
  const first = await registerWorkspaceAgentTools({ settings: {}, mode: 'read', register, registerMcp: null });
  const same = await registerWorkspaceAgentTools({
    settings: {}, mode: 'read', register, registerMcp: null, previous: { read: first.signature },
  });
  assert.equal(same.drifted, false, '签名一致不算漂移');
  const changed = await registerWorkspaceAgentTools({
    settings: {}, mode: 'read', register, registerMcp: null, previous: { read: 'something_else' },
  });
  assert.equal(changed.drifted, true);
  assert.equal(changed.prevSignature, 'something_else');
  // 另一种模式有自己的槽位：write 槽为空 → 不算漂移
  const other = await registerWorkspaceAgentTools({
    settings: {}, mode: 'write', register, registerMcp: null, previous: { read: 'something_else' },
  });
  assert.equal(other.drifted, false, '别的 mode 的旧签名不影响本 mode');
});

test('materializer 只在是函数时透传（其余归一成 null）', async () => {
  const register = fakeRegister();
  const fn = () => {};
  await registerWorkspaceAgentTools({ settings: {}, mode: 'read', register, registerMcp: null, materializer: fn, readLog: 'log' });
  assert.equal(register.seen[0].extras.materializer, fn);
  assert.equal(register.seen[0].extras.readLog, 'log');
  await registerWorkspaceAgentTools({ settings: {}, mode: 'read', register, registerMcp: null, materializer: 'not-a-function' });
  assert.equal(register.seen[1].extras.materializer, null, '非函数一律 null');
});

test('MCP：注册顺序在列工具之前（GitHub 工具进得了清单），失败不拖垮文件工具', async () => {
  const register = fakeRegister();
  const calls = [];
  const registerMcp = async () => { calls.push('mcp'); };
  const result = await registerWorkspaceAgentTools({ settings: {}, mode: 'read', register, registerMcp });
  assert.deepEqual(calls, ['mcp'], '挂了 MCP');
  assert.deepEqual(result.tools.map(item => item.function.name), ['read_workspace_file', 'search_workspace']);

  // MCP 抛错：文件工具照常返回（MCP 是增强，不是依赖）
  const failing = await registerWorkspaceAgentTools({
    settings: {}, mode: 'read', register, registerMcp: async () => { throw new Error('MCP 挂了'); },
  });
  assert.equal(failing.tools.length, 2, 'MCP 失败不影响文件工具');

  // ask 模式：什么都不挂（与旧行为一致）
  const askCalls = [];
  await registerWorkspaceAgentTools({ settings: {}, mode: 'ask', register, registerMcp: async () => { askCalls.push(1); } });
  assert.deepEqual(askCalls, [], 'ask 模式不挂 MCP');
});

test('2026-10-11 裁决：工作区 agent 拿到 GitHub MCP 工具，且风险分级照旧生效', async () => {
  const { registerGithubMcpTools, unregisterGithubMcpTools } = await import('../src/workspace/mcpTools.js');
  const { listToolsForMode, getTool } = await import('../src/agent/tools/registry.js');
  // 连接时落盘的目录快照（含三类：只读 / 需确认 / 硬禁止）
  const settings = {
    enabled: true,
    authMethod: 'pat',
    githubToken: 'fake-token',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    toolCatalog: [
      { name: 'get_file_contents', description: '读文件', parameters: { type: 'object', properties: {} } },
      { name: 'create_or_update_file', description: '提交', parameters: { type: 'object', properties: {} } },
      { name: 'delete_repository', description: '删仓库', parameters: { type: 'object', properties: {} } },
    ],
  };
  try {
    const registered = registerGithubMcpTools(settings);
    assert.deepEqual(registered.sort(), ['github_create_or_update_file', 'github_get_file_contents'], '硬禁止类不注册');

    // read 模式只放行只读类；写入类要 write 模式 + 逐条确认
    const readTools = listToolsForMode('read').map(item => item.function.name);
    assert.ok(readTools.includes('github_get_file_contents'), '只读 GitHub 工具在 read 模式可用');
    assert.equal(readTools.includes('github_create_or_update_file'), false, '写入类 read 模式不出现');
    const writeTools = listToolsForMode('write').map(item => item.function.name);
    assert.ok(writeTools.includes('github_create_or_update_file'), 'write 模式可用');
    assert.equal(getTool('github_create_or_update_file').requiresConfirmation, true, '写入类逐条确认');
    assert.equal(getTool('github_get_file_contents').readOnly, true, '只读类标只读');
    assert.equal(getTool('github_delete_repository'), null, '硬禁止类根本不在注册表里');
  } finally {
    unregisterGithubMcpTools();
  }
});
