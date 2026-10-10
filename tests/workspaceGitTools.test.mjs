// W7：本地 git 的只读三件套（git_status / git_diff / git_log）+ 门控 + 注册表接线。
//
// 三条纪律在这里钉住：
// 1. **只读工具不产生副作用**——仓库由用户在设置里打开开关时建（ensureRepo），
//    工具自己绝不 init（否则 readOnly 这个标记就失去意义，注册表的模式门控也靠它）；
// 2. 门控只在「开关开 + 应用私有根」时放行（SAF 的 content:// 撑不起 .git）；
// 3. 门控不过 = 工具**不进注册表**（第一层），不是进了再报错。

import test from 'node:test';
import assert from 'node:assert/strict';

import { GIT_TOOL_DEFINITIONS, formatGitLog, formatGitStatus } from '../src/workspace/toolDefs/gitTools.js';
import { createWorkspaceToolDefinitions, GIT_TOOL_NAMES } from '../src/workspace/tools.js';
import { createWorkspaceGit } from '../src/workspace/git.js';
import { createMemoryFileSystem } from './helpers/memoryFileSystem.mjs';

const ROOT = '/doc/workspace/';
const CHARACTER = 'ch1';

// 与 native.js 的 resolveGitRunner 同形状：open({ characterId }) → 内核句柄。
function makeGitRunner(fileSystem, { characterId = CHARACTER } = {}) {
  const open = ({ characterId: id = characterId } = {}) => createWorkspaceGit({ root: ROOT, characterId: id, fileSystem });
  return {
    open,
    ensureRepo: async ({ characterId: id = characterId } = {}) => {
      const handle = open({ characterId: id });
      if (!(await handle.isRepo())) await handle.init();
      return handle;
    },
  };
}

const byName = definitions => new Map(definitions.map(item => [item.name, item]));

test('formatGitStatus：干净 / 各类改动记号（与 git status --short 同款）', () => {
  assert.equal(formatGitStatus([]), '工作区干净：没有未提交的改动。');
  const text = formatGitStatus([
    { path: 'src/a.js', status: 'modified' },
    { path: 'new.md', status: 'untracked' },
    { path: 'added.js', status: 'added' },
    { path: 'gone.txt', status: 'deleted' },
  ]);
  assert.match(text, /未提交的改动（4 个文件）/);
  assert.match(text, / M src\/a\.js/);
  assert.match(text, /\?\? new\.md/);
  assert.match(text, /A  added\.js/);
  assert.match(text, / D gone\.txt/);
});

test('formatGitLog：空历史如实说，有条目则短 sha + 说明', () => {
  assert.match(formatGitLog([]), /还没有任何提交/);
  const text = formatGitLog([{ oid: 'abcdef1234567890', message: '加了登录' }]);
  assert.match(text, /abcdef1 加了登录/);
});

test('门控：开关关 / 外部根 不放行（纯判定，可直测）', async () => {
  const { gitGateReason } = await import('../src/workspace/native.js');
  assert.equal(gitGateReason({}), 'SWITCH_OFF');
  assert.equal(gitGateReason({ allowLocalGit: true, location: { kind: 'saf', uri: 'content://t', name: 'x' } }), 'EXTERNAL_ROOT');
  assert.equal(gitGateReason({ allowLocalGit: true }), '', '开了且应用内根 → 放行');
  // 与工作模式无关：read 模式下也放行（只读工具在只读模式正好有用）。
  assert.equal(gitGateReason({ allowLocalGit: true, mode: 'read' }), '');
});

test('注册表：给了 git runner 才多出三个只读工具；不给则完全不出现', () => {
  const store = { listWorkspaceFiles: async () => [] };
  const without = createWorkspaceToolDefinitions({ store });
  assert.equal(without.some(item => GIT_TOOL_NAMES.includes(item.name)), false, '没 runner → 一个都不注册');
  assert.equal(without.length, 12, '基础清单不受影响（git 是条件加）');

  const withGit = byName(createWorkspaceToolDefinitions({ store, git: makeGitRunner(createMemoryFileSystem()) }));
  for (const name of GIT_TOOL_NAMES) {
    const definition = withGit.get(name);
    assert.ok(definition, `${name} 已注册`);
    assert.equal(definition.readOnly, true, `${name} 是只读工具`);
  }
  assert.equal(withGit.get('git_status').timeoutMs, 30000, 'status 显式 30s（真机 Hermes 比 Node 慢）');
  assert.equal(withGit.get('git_diff').timeoutMs, 30000, 'diff 同样显式');
  assert.equal(withGit.get('git_log').timeoutMs, undefined, 'log 不带声明 → 用注册表默认超时');
});

test('git_status：仓库未就绪时如实回话，且**不会顺手建仓库**（只读无副作用）', async () => {
  const fileSystem = createMemoryFileSystem();
  const definitions = byName(createWorkspaceToolDefinitions({
    store: { listWorkspaceFiles: async () => [] },
    git: makeGitRunner(fileSystem),
  }));
  const ctx = { characterId: CHARACTER };
  const result = await definitions.get('git_status').execute({}, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content, /还没有 git 仓库/);
  // 关键：只读工具没有在沙盒里造出 .git
  const gitFiles = [...fileSystem.nodes.keys()].filter(key => key.includes('/.git'));
  assert.deepEqual(gitFiles, [], '只读工具不得初始化仓库');
});

test('git_status / git_diff / git_log：仓库就绪后给出真实内容', async () => {
  const fileSystem = createMemoryFileSystem();
  const runner = makeGitRunner(fileSystem);
  const definitions = byName(createWorkspaceToolDefinitions({
    store: { listWorkspaceFiles: async () => [] },
    git: runner,
  }));
  const ctx = { characterId: CHARACTER };

  // 用户开开关 → 建仓库（这一步是设置页的动作，不是工具的动作）
  const handle = await runner.ensureRepo({ characterId: CHARACTER });
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/note.md`, '第一行\n');
  await handle.commitAll('初始提交');

  // 改一个文件 → status 报 modified；diff 给出 + 行；log 有那条提交
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/note.md`, '第一行\n第二行\n');
  const status = await definitions.get('git_status').execute({}, ctx);
  assert.match(status.content, / M note\.md/);

  const diff = await definitions.get('git_diff').execute({ path: 'note.md' }, ctx);
  assert.match(diff.content, /--- note\.md/);
  assert.match(diff.content, /\+第二行/);

  const log = await definitions.get('git_log').execute({ limit: 5 }, ctx);
  assert.match(log.content, /初始提交/);

  // 缺 path 的工具参数校验
  const missing = await definitions.get('git_diff').execute({}, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content, /请提供 path/);
});

test('git 工具在没注入 runner 时如实报「未启用」（不抛错）', async () => {
  const definition = byName(GIT_TOOL_DEFINITIONS.map(item => item)) .get('git_status');
  const result = await definition.execute({}, { characterId: CHARACTER });
  assert.equal(result.isError, true);
  assert.match(result.content, /未启用/);
});
