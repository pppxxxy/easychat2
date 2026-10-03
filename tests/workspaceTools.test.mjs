import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MODES,
  clearTools,
  listToolsForMode,
  runTool,
} from '../src/agent/tools/registry.js';
import {
  WORKSPACE_TOOL_NAMES,
  registerWorkspaceTools,
  unregisterWorkspaceTools,
} from '../src/workspace/tools.js';

function createMemoryFs() {
  const entries = new Map();
  const api = {
    documentDirectory: '/doc/',
    async getInfoAsync(uri) {
      const key = entries.has(uri) ? uri : (entries.has(`${uri}/`) ? `${uri}/` : null);
      if (!key) return { exists: false };
      return { exists: true, isDirectory: entries.get(key).type === 'dir' };
    },
    async makeDirectoryAsync(uri) {
      entries.set(uri.endsWith('/') ? uri : `${uri}/`, { type: 'dir' });
    },
    async readDirectoryAsync(uri) {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      const names = new Set();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).replace(/\/$/, '');
        if (!rest) continue;
        names.add(rest.split('/')[0]);
      }
      if (names.size === 0) throw new Error('ENOENT');
      return [...names];
    },
    async readAsStringAsync(uri) {
      const entry = entries.get(uri);
      if (!entry || entry.type !== 'file') throw new Error('ENOENT');
      return entry.content;
    },
    async writeAsStringAsync(uri, text) {
      entries.set(uri, { type: 'file', content: String(text) });
    },
  };
  return api;
}

const root = '/doc/workspace/';
let fileSystem;

test.beforeEach(() => {
  clearTools();
  fileSystem = createMemoryFs();
});

test('registerWorkspaceTools 按模式暴露工具', () => {
  registerWorkspaceTools({ root, fileSystem });
  assert.deepEqual(WORKSPACE_TOOL_NAMES, ['list_workspace_files', 'read_workspace_file', 'write_workspace_file']);
  assert.deepEqual(listToolsForMode(AGENT_MODES.ASK), []);
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.READ).map(item => item.function.name),
    ['list_workspace_files', 'read_workspace_file'],
  );
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.WRITE).map(item => item.function.name),
    ['list_workspace_files', 'read_workspace_file', 'write_workspace_file'],
  );
});

test('工作区工具经 runTool 读写（以 ctx.characterId 分沙盒）', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const written = await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"notes/a.md","content":"你好"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(written.isError, false);
  assert.match(written.content, /已写入 notes\/a.md/);

  const read = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"notes/a.md"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(read.content, '你好');

  const list = await runTool(
    { name: 'list_workspace_files', arguments: '{}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(list.content, 'notes/\nnotes/a.md');

  // 另一个角色是独立沙盒
  const other = await runTool(
    { name: 'list_workspace_files', arguments: '{}' },
    { mode: AGENT_MODES.READ, characterId: 'c2' },
  );
  assert.equal(other.content, '（工作区为空）');
});

test('只读模式下写工具被门控，非法扩展名以错误结果返回', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const denied = await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"b.md","content":"x"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /当前模式不允许/);

  const badPath = await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"a.png","content":"x"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(badPath.isError, true);
  assert.match(badPath.content, /只支持纯文本与 Markdown/);
});

test('unregisterWorkspaceTools 清理注册', () => {
  registerWorkspaceTools({ root, fileSystem });
  unregisterWorkspaceTools();
  assert.deepEqual(listToolsForMode(AGENT_MODES.WRITE), []);
});