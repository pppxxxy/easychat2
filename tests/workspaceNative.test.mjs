import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_MODES, clearTools, getTool, listToolsForMode } from '../src/agent/tools/registry.js';
import {
  createWorkspaceStore,
  defaultWorkspaceRoot,
  describeWorkspaceRoot,
  getWorkspaceFileSystem,
  registerDefaultWorkspaceTools,
  resolveShellRunner,
  shellGateReason,
} from '../src/workspace/native.js';
import { registerWorkspaceTools, unregisterWorkspaceTools, WORKSPACE_TOOL_NAMES } from '../src/workspace/tools.js';

test.beforeEach(() => {
  clearTools();
});

test('测试环境无 expo-file-system 时安全降级为 null', () => {
  assert.equal(getWorkspaceFileSystem(), null);
  assert.equal(defaultWorkspaceRoot(), 'workspace/');
});

test('registerDefaultWorkspaceTools 仍能登记五个工具（原生就绪后即可用）', () => {
  const names = registerDefaultWorkspaceTools();
  assert.deepEqual(names, [
    'list_workspace_files',
    'read_workspace_file',
    'write_workspace_file',
    'edit_workspace_file',
    'export_workspace_docx',
  ]);
  assert.deepEqual(names, WORKSPACE_TOOL_NAMES);
  assert.equal(listToolsForMode(AGENT_MODES.WRITE).length, 5);
  // 只读模式只放开两个读工具：edit 是写操作，绝不能漏进只读模式
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.READ).map(item => item.function.name),
    ['list_workspace_files', 'read_workspace_file'],
  );
});

test('默认（无设置/应用内根）走后端接口，且不再依赖 legacy 的 root/fileSystem 直传', () => {
  // 默认无设置 → 应用私有根 → legacy 后端；测试环境没有原生 fileSystem，
  // 只断言后端形态与接口齐备（真正的读写由 workspaceStore 的假实现覆盖）。
  const store = createWorkspaceStore(null);
  assert.equal(store.rootKind, 'app');
  for (const method of ['listWorkspaceFiles', 'readWorkspaceFile', 'writeWorkspaceFile', 'writeWorkspaceBinaryFile', 'editWorkspaceFile', 'fileUri', 'deleteFile']) {
    assert.equal(typeof store[method], 'function', `后端必须实现 ${method}`);
  }
});

test('选外部文件夹但原生新 API 不可用时抛错，绝不静默写回应用沙盒', () => {
  const settings = {
    mode: 'write',
    location: { kind: 'saf', uri: 'content://com.android.externalstorage.documents/tree/primary%3ADocs', name: 'Docs' },
    allowCommandExecution: false,
  };
  assert.throws(() => createWorkspaceStore(settings), /Directory\/File 新 API/);
  // 面板据此如实报错（词条 workspace.panel.err.externalUnavailable），而不是显示一堆空文件
  assert.equal(describeWorkspaceRoot(settings).kind, 'saf');
  assert.equal(describeWorkspaceRoot(settings).name, 'Docs');
  assert.equal(describeWorkspaceRoot(null).kind, 'app');
});

// ---- run_shell 的三层门控（第一层：注册与否）----

test('run_shell 默认不注册（开关默认关）', () => {
  const names = registerDefaultWorkspaceTools(null);
  assert.equal(names.includes('run_shell'), false);
  assert.deepEqual(listToolsForMode(AGENT_MODES.WRITE).map(item => item.function.name).includes('run_shell'), false);
});

test('开关开但模式不是可改 / 根是外部文件夹 / 原生模块不可用，都不注册', () => {
  const base = { location: { kind: 'app', uri: '', name: '' }, allowCommandExecution: true };
  const available = { shellAvailable: true };
  // 逐条判定：只有全部通过才返回 ''（可以注册）
  assert.equal(shellGateReason({ ...base, mode: 'write' }, available), '');
  assert.equal(shellGateReason(null, available), 'SWITCH_OFF');
  assert.equal(shellGateReason({ ...base, mode: 'write', allowCommandExecution: false }, available), 'SWITCH_OFF');
  // 只读模式：开关即便为 true 也不成立（归一化也是这个口径）
  assert.equal(shellGateReason({ ...base, mode: 'read' }, available), 'NOT_WRITE_MODE');
  assert.equal(shellGateReason({ ...base, mode: 'ask' }, available), 'NOT_WRITE_MODE');
  // 外部根：无 root 的 sh 碰不到 content://
  assert.equal(shellGateReason({
    ...base,
    mode: 'write',
    location: { kind: 'saf', uri: 'content://tree/primary%3ADocs', name: 'Docs' },
  }, available), 'EXTERNAL_ROOT');
  // 原生模块没装上：即使设置全开也不注册
  assert.equal(shellGateReason({ ...base, mode: 'write' }, { shellAvailable: false }), 'SHELL_NOT_AVAILABLE');
  // 真实环境的 resolveShellRunner：测试环境拿不到原生模块，故一律 null
  assert.equal(resolveShellRunner({ ...base, mode: 'write' }), null);
});

test('registerWorkspaceTools 带 shell 时多出 run_shell，且它需要逐条确认', () => {
  const asked = [];
  const names = registerWorkspaceTools({
    store: createWorkspaceStore(null),
    shell: { run: async args => { asked.push(args); return { content: 'ok', isError: false }; } },
  });
  assert.deepEqual(names, [
    'list_workspace_files',
    'read_workspace_file',
    'write_workspace_file',
    'edit_workspace_file',
    'export_workspace_docx',
    'run_shell',
  ]);
  const shellTool = getTool('run_shell');
  assert.equal(shellTool.readOnly, false, '命令执行是写操作：只读模式不得暴露');
  assert.equal(shellTool.requiresConfirmation, true, '必须逐条确认');
  assert.ok(shellTool.timeoutMs > 15000, '命令执行需要比默认 15s 更长的执行超时');
  // 只读模式不暴露
  assert.equal(listToolsForMode(AGENT_MODES.READ).some(item => item.function.name === 'run_shell'), false);
});

test('unregisterWorkspaceTools 能把 run_shell 一起摘掉（关开关后不留残留）', () => {
  registerWorkspaceTools({
    store: createWorkspaceStore(null),
    shell: { run: async () => ({ content: 'ok', isError: false }) },
  });
  assert.ok(getTool('run_shell'), '先确认注册上了');
  unregisterWorkspaceTools();
  assert.equal(getTool('run_shell'), null, '必须能摘掉，否则门控第一层就漏了');
  assert.deepEqual(listToolsForMode(AGENT_MODES.WRITE), []);
});
