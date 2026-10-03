import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_MODES, clearTools, listToolsForMode } from '../src/agent/tools/registry.js';
import {
  defaultWorkspaceRoot,
  getWorkspaceFileSystem,
  registerDefaultWorkspaceTools,
} from '../src/workspace/native.js';

test.beforeEach(() => {
  clearTools();
});

test('测试环境无 expo-file-system 时安全降级为 null', () => {
  assert.equal(getWorkspaceFileSystem(), null);
  assert.equal(defaultWorkspaceRoot(), 'workspace/');
});

test('registerDefaultWorkspaceTools 仍能登记三个工具（原生就绪后即可用）', () => {
  const names = registerDefaultWorkspaceTools();
  assert.deepEqual(names, ['list_workspace_files', 'read_workspace_file', 'write_workspace_file']);
  assert.equal(listToolsForMode(AGENT_MODES.WRITE).length, 3);
});