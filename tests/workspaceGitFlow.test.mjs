// W7 端到端链路：把「内核 + 工具 + 回合检查点 + 面板数据源」串起来跑一遍。
//
// 为什么要这一条：前面每个模块都有自己的单测，但**它们之间的接缝**没人测过——比如
// 「写工具不再记快照」与「检查点真的提交了」这两件事必须同时成立，否则会出现
// 「快照停了、git 也没提交」这种两头落空的静默数据丢失。真机冒烟之前，这里是最后一道网。
//
// 场景照真实一轮走：开开关 → 建仓库 → 助手写文件（不记快照）→ 回合检查点提交 →
// 问「改了什么」→ 改文件 → 丢弃 → 回看历史面板要的那几个数据。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceGit } from '../src/workspace/git.js';
import { createWorkspaceToolDefinitions } from '../src/workspace/tools.js';
import { runTurnCheckpoint } from '../src/workspace/gitCheckpoint.js';
import { gitGateReason, shouldRecordFileHistory } from '../src/workspace/native.js';
import { createMemoryFileSystem } from './helpers/memoryFileSystem.mjs';

const ROOT = '/doc/workspace/';
const CHARACTER = 'ch1';
const SANDBOX = `${ROOT}${CHARACTER}/`;

// 与真实装配同形：store 与 git 后端都建在同一个 fileSystem 上（应用私有根）。
function setup({ allowLocalGit = true } = {}) {
  const fileSystem = createMemoryFileSystem();
  const settings = { mode: 'write', allowLocalGit };
  const store = {
    async readWorkspaceFile({ path }) {
      return { path, content: await fileSystem.readAsStringAsync(`${SANDBOX}${path}`), truncated: false };
    },
    async writeWorkspaceFile({ path, content }) {
      await fileSystem.makeDirectoryAsync(`${SANDBOX}${path}`.replace(/\/[^/]*$/, ''), { intermediates: true });
      await fileSystem.writeAsStringAsync(`${SANDBOX}${path}`, String(content));
      return { path, length: String(content).length };
    },
    async listWorkspaceFiles() { return []; },
  };
  const runner = {
    open: ({ characterId = CHARACTER } = {}) => createWorkspaceGit({ root: ROOT, characterId, fileSystem }),
    ensureRepo: async ({ characterId = CHARACTER } = {}) => {
      const handle = runner.open({ characterId });
      if (!(await handle.isRepo())) await handle.init();
      return handle;
    },
  };
  const definitions = createWorkspaceToolDefinitions({
    store,
    git: gitGateReason(settings) === '' ? runner : null,
    // 与 native.js 的 registerDefaultWorkspaceTools 同一条判据
    recordFileHistory: shouldRecordFileHistory(settings),
  });
  return { fileSystem, settings, runner, definitions, store };
}

const tool = (definitions, name) => definitions.find(item => item.name === name);
const ctx = { mode: 'write', characterId: CHARACTER };

test('端到端：开开关 → 建仓库 → 写文件 → 检查点提交 → 问改了什么 → 丢弃 → 看历史', async () => {
  const { fileSystem, runner, definitions } = setup();

  // 1. 用户在设置里打开开关 → 建仓库（这一步是设置页的动作）
  assert.equal(gitGateReason({ allowLocalGit: true }), '', '应用内根 + 开关开 → 放行');
  await runner.ensureRepo({ characterId: CHARACTER });

  // 2. 助手写两个文件（写工具；git 开着 → 不记写前快照）
  await tool(definitions, 'write_workspace_file').execute({ path: 'src/app.js', content: 'const v = 1;\n' }, ctx);
  await tool(definitions, 'write_workspace_file').execute({ path: 'README.md', content: '# 项目\n' }, ctx);
  const historyFiles = [...fileSystem.nodes.keys()].filter(key => key.includes('file-history'));
  assert.deepEqual(historyFiles, [], 'git 开着时不落写前快照（同一件事已由检查点接管）');

  // 3. 回合结束 → 检查点提交
  const checkpoint = await runTurnCheckpoint({ git: runner, request: '建个项目骨架', characterId: CHARACTER });
  assert.equal(checkpoint.ok, true, '本轮有改动 → 提交成功');
  assert.deepEqual(await tool(definitions, 'git_status').execute({}, ctx).then(r => r.content), '工作区干净：没有未提交的改动。');

  // 4. 助手问「我改了什么」：干净时说干净
  const log = await tool(definitions, 'git_log').execute({}, ctx);
  assert.match(log.content, /建个项目骨架/, '提交说明就是那一轮的请求');

  // 5. 再改一轮：改 + 新增
  await tool(definitions, 'write_workspace_file').execute({ path: 'src/app.js', content: 'const v = 2;\n' }, ctx);
  await tool(definitions, 'write_workspace_file').execute({ path: 'src/new.js', content: 'export {};\n' }, ctx);

  const status = await tool(definitions, 'git_status').execute({}, ctx);
  assert.match(status.content, / M src\/app\.js/);
  assert.match(status.content, /\?\? src\/new\.js/);

  const diff = await tool(definitions, 'git_diff').execute({ path: 'src/app.js' }, ctx);
  assert.match(diff.content, /-const v = 1;/);
  assert.match(diff.content, /\+const v = 2;/);

  // 6. 助手发现自己改错了 → 丢弃未提交改动（真机上面这一步会先弹确认）
  const discard = await tool(definitions, 'git_discard').execute({ all: true }, ctx);
  assert.equal(discard.isError, undefined);
  assert.equal(await fileSystem.readAsStringAsync(`${SANDBOX}src/app.js`), 'const v = 1;\n', '改的回滚到上次提交');
  await assert.rejects(() => fileSystem.readAsStringAsync(`${SANDBOX}src/new.js`), '新建的被删');
  assert.match((await tool(definitions, 'git_status').execute({}, ctx)).content, /干净/);

  // 7. 历史面板要的三个数据源：提交列表 / 该提交改了哪些文件 / 单文件文本对
  const handle = runner.open({ characterId: CHARACTER });
  const commits = await handle.log();
  assert.equal(commits.length, 1);
  assert.deepEqual(await handle.changedInCommit(commits[0].oid), [
    { path: 'README.md', status: 'added' },
    { path: 'src/app.js', status: 'added' },
  ]);
  assert.deepEqual(
    await handle.diffTextsInCommit(commits[0].oid, 'README.md'),
    { before: '', after: '# 项目\n' },
  );
});

test('端到端：开关关着时工具不注册、快照照记（回退路径没被拆掉）', async () => {
  const { fileSystem, definitions } = setup({ allowLocalGit: false });

  assert.equal(gitGateReason({ allowLocalGit: false }), 'SWITCH_OFF');
  assert.equal(shouldRecordFileHistory({ allowLocalGit: false }), true, 'git 关 → 快照仍是唯一回退手段');
  for (const name of ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_discard']) {
    assert.equal(tool(definitions, name), undefined, `${name} 不进注册表`);
  }

  // 写文件 → 记了快照（写工具把 .easychat/file-history 写进去）
  const store = {
    async readWorkspaceFile() { return { path: 'a.txt', content: 'old', truncated: false }; },
    async writeWorkspaceFile(args) {
      await fileSystem.writeAsStringAsync(`${SANDBOX}${args.path}`, String(args.content));
      return { path: args.path, length: 3 };
    },
  };
  const withSnapshot = createWorkspaceToolDefinitions({ store, recordFileHistory: true })
    .find(item => item.name === 'write_workspace_file');
  await withSnapshot.execute({ path: 'a.txt', content: 'new' }, ctx);
  const snapshotFiles = [...fileSystem.nodes.keys()].filter(key => key.includes('file-history'));
  assert.equal(snapshotFiles.length > 0, true, 'git 关着时快照照记——回退路径完好');
});
