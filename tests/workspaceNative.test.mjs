import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_MODES, clearTools, listToolsForMode } from '../src/agent/tools/registry.js';
import {
  createWorkspaceStore,
  defaultWorkspaceRoot,
  describeWorkspaceRoot,
  getWorkspaceFileSystem,
  registerDefaultWorkspaceTools,
} from '../src/workspace/native.js';
import { WORKSPACE_TOOL_NAMES } from '../src/workspace/tools.js';

test.beforeEach(() => {
  clearTools();
});

test('测试环境无 expo-file-system 时安全降级为 null', () => {
  assert.equal(getWorkspaceFileSystem(), null);
  assert.equal(defaultWorkspaceRoot(), 'workspace/');
});

test('registerDefaultWorkspaceTools 仍能登记四个工具（原生就绪后即可用）', () => {
  const names = registerDefaultWorkspaceTools();
  assert.deepEqual(names, [
    'list_workspace_files',
    'read_workspace_file',
    'write_workspace_file',
    'export_workspace_docx',
  ]);
  assert.deepEqual(names, WORKSPACE_TOOL_NAMES);
  assert.equal(listToolsForMode(AGENT_MODES.WRITE).length, 4);
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
  for (const method of ['listWorkspaceFiles', 'readWorkspaceFile', 'writeWorkspaceFile', 'writeWorkspaceBinaryFile', 'fileUri', 'deleteFile']) {
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
