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

test('ask 模式：不注册、不签名（与旧行为逐字一致）', () => {
  const register = fakeRegister();
  const result = registerWorkspaceAgentTools({ settings: {}, mode: 'ask', register });
  assert.deepEqual(result, { tools: [], signature: '', prevSignature: '', drifted: false });
  assert.equal(register.seen.length, 0, 'ask 模式不碰注册表');
});

test('read 模式：注册后返回只读工具与顺序签名', () => {
  const register = fakeRegister();
  const result = registerWorkspaceAgentTools({ settings: {}, mode: 'read', register });
  assert.deepEqual(result.tools.map(item => item.function.name), ['read_workspace_file', 'search_workspace']);
  assert.equal(result.signature, 'read_workspace_file,search_workspace', '签名按注册表顺序');
  assert.equal(result.drifted, false, '首次没有「上一次」可比');
});

test('顺序漂移：与上一次签名不同才为 true（mode 切换不算漂移）', () => {
  const register = fakeRegister();
  const first = registerWorkspaceAgentTools({ settings: {}, mode: 'read', register });
  const same = registerWorkspaceAgentTools({
    settings: {}, mode: 'read', register, previous: { read: first.signature },
  });
  assert.equal(same.drifted, false, '签名一致不算漂移');
  const changed = registerWorkspaceAgentTools({
    settings: {}, mode: 'read', register, previous: { read: 'something_else' },
  });
  assert.equal(changed.drifted, true);
  assert.equal(changed.prevSignature, 'something_else');
  // 另一种模式有自己的槽位：write 槽为空 → 不算漂移
  const other = registerWorkspaceAgentTools({
    settings: {}, mode: 'write', register, previous: { read: 'something_else' },
  });
  assert.equal(other.drifted, false, '别的 mode 的旧签名不影响本 mode');
});

test('materializer 只在是函数时透传（其余归一成 null）', () => {
  const register = fakeRegister();
  const fn = () => {};
  registerWorkspaceAgentTools({ settings: {}, mode: 'read', register, materializer: fn, readLog: 'log' });
  assert.equal(register.seen[0].extras.materializer, fn);
  assert.equal(register.seen[0].extras.readLog, 'log');
  registerWorkspaceAgentTools({ settings: {}, mode: 'read', register, materializer: 'not-a-function' });
  assert.equal(register.seen[1].extras.materializer, null, '非函数一律 null');
});
