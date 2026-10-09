// run_python / run_shell 的注册接缝回归（2026-10-09 事故复盘）。
//
// 事故形态：native 侧 create*Runner 返回**裸 async 函数**，而 tools.js 的注册门是
// typeof shell.run === 'function'（只认 { run } 对象）——裸函数被无声丢弃，两个执行
// 工具在任何开关/权限/安装状态下都进不了工具表；模型于是如实报告「只有 6 个文件工具」。
// 手动运行与终端面板不走这条路，所以表现为「手动成功、agent 不行」。
//
// 旧测试为什么没拦住：workspaceNative.test.mjs 的假桩恰好是 { run: async } 形态
// （符合错误契约），与 create*Runner 的真实返回从未在同一个测试里碰过面。
// 本文件补的就是这条接缝：真 runner → registerWorkspaceTools → 在列 + 能执行。
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_MODES, clearTools, getTool, listToolsForMode } from '../src/agent/tools/registry.js';
import { createWorkspaceStore } from '../src/workspace/native.js';
import { createPythonRunner } from '../src/workspace/python.js';
import { createShellRunner } from '../src/workspace/shell.js';
import { registerWorkspaceTools } from '../src/workspace/tools.js';

test.beforeEach(() => {
  clearTools();
});

const fakeNative = {
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  kill: () => {},
  runScript: async () => JSON.stringify({ stdout: '', stderr: '', exitCode: 0 }),
};

test('前提：真实 runner 是裸 async 函数，且上面没有 .run（旧形状检查的死因）', () => {
  const shellRunner = createShellRunner({ sandboxRoot: '/tmp/ws', native: fakeNative });
  const pythonRunner = createPythonRunner({ sandboxRoot: '/tmp/ws', native: fakeNative });
  assert.equal(typeof shellRunner, 'function', 'createShellRunner 返回裸函数');
  assert.equal(typeof pythonRunner, 'function', 'createPythonRunner 返回裸函数');
  assert.equal(shellRunner.run, undefined, '裸函数上 .run 是 undefined——旧代码就死在这');
  assert.equal(pythonRunner.run, undefined);
});

test('接缝回归：真实 runner（裸函数）接入后，两个执行工具必须在注册表并进入写模式清单', () => {
  const names = registerWorkspaceTools({
    store: createWorkspaceStore(null),
    shell: createShellRunner({ sandboxRoot: '/tmp/ws', native: fakeNative }),
    python: createPythonRunner({ sandboxRoot: '/tmp/ws', native: fakeNative }),
  });
  assert.ok(names.includes('run_shell'), '裸函数 runner 必须被接纳（run_shell）');
  assert.ok(names.includes('run_python'), '裸函数 runner 必须被接纳（run_python）');
  assert.ok(getTool('run_shell') && getTool('run_python'), '注册表里查得到');
  const writeNames = listToolsForMode(AGENT_MODES.WRITE).map(item => item.function.name);
  assert.ok(writeNames.includes('run_shell') && writeNames.includes('run_python'),
    '写模式下发给模型的清单里必须有它们（模型看不到 = 不会用）');
});

test('接缝回归（第二处断裂）：执行路径真的能调到 runner——options 必须带上 shell/python', async () => {
  let shellArgs = null;
  let pythonArgs = null;
  // 用裸函数形态直接接入：修复前 options 里没有 shell/python，
  // 即便注册通过，execute 也会 TypeError: Cannot read properties of undefined。
  const shellRunner = async args => { shellArgs = args; return { content: 'shell-ok', isError: false }; };
  const pythonRunner = async args => { pythonArgs = args; return { content: 'py-ok', isError: false }; };
  registerWorkspaceTools({
    store: createWorkspaceStore(null),
    shell: shellRunner,
    python: pythonRunner,
  });

  const shellResult = await getTool('run_shell').execute({ command: 'echo hi' }, { characterId: 'c1' });
  assert.equal(shellResult.content, 'shell-ok', 'run_shell 真的走到了 runner');
  assert.equal(shellArgs.command, 'echo hi');
  assert.equal(shellArgs.characterId, 'c1', '角色上下文透传（决定工作目录）');

  const pyResult = await getTool('run_python').execute({ code: 'print(1)' }, { characterId: 'c2' });
  assert.equal(pyResult.content, 'py-ok', 'run_python 真的走到了 runner');
  assert.equal(pythonArgs.code, 'print(1)');
  assert.equal(pythonArgs.characterId, 'c2');
});

test('兼容两种形态：{ run } 对象仍被接纳（历史调用路径不回退）', async () => {
  const names = registerWorkspaceTools({
    store: createWorkspaceStore(null),
    shell: { run: async () => ({ content: 'ok', isError: false }) },
    python: { run: async () => ({ content: 'ok', isError: false }) },
  });
  assert.ok(names.includes('run_shell') && names.includes('run_python'));
});

test('门控不回退：不传 / 坏形态都不注册', () => {
  const bare = registerWorkspaceTools({ store: createWorkspaceStore(null) });
  assert.ok(!bare.includes('run_shell'), '不传 shell 时不注册');
  assert.ok(!bare.includes('run_python'), '不传 python 时不注册');

  clearTools();
  const broken = registerWorkspaceTools({
    store: createWorkspaceStore(null),
    shell: { noRun: true },
    python: 'nope',
  });
  assert.ok(!broken.includes('run_shell') && !broken.includes('run_python'),
    '对象无 .run / 字符串等坏形态一律拒绝，不静默当可用');
});
