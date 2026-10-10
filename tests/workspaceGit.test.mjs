// W7：本地 git 内核（src/workspace/git.js）——status / commitAll / diffModel / checkout。
//
// 内核存在的理由：Android 上没有 git 二进制，agent 无法把「我改了什么」变成可回滚的历史。
// 这里钉住内核对外承诺的四件事，以及两条边界：空变更不产生空提交、删除走 remove 而不是 add。

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyStatusRow, createWorkspaceGit, GIT_DEFAULT_AUTHOR } from '../src/workspace/git.js';
import { createMemoryFileSystem } from './helpers/memoryFileSystem.mjs';

const ROOT = '/doc/workspace/';
const CHARACTER = 'ch1';

function setup() {
  const fileSystem = createMemoryFileSystem();
  const workspaceGit = createWorkspaceGit({ root: ROOT, characterId: CHARACTER, fileSystem });
  return { fileSystem, workspaceGit };
}

test('classifyStatusRow：三元组 → 可读状态（含 untracked / added / deleted / modified）', () => {
  assert.equal(classifyStatusRow(['a.js', 1, 1, 1]).status, 'unmodified');
  assert.equal(classifyStatusRow(['a.js', 0, 2, 0]).status, 'untracked');
  assert.equal(classifyStatusRow(['a.js', 0, 2, 2]).status, 'added');
  assert.equal(classifyStatusRow(['a.js', 1, 2, 1]).status, 'modified');
  assert.equal(classifyStatusRow(['a.js', 1, 0, 1]).status, 'deleted');
  assert.equal(classifyStatusRow(['a.js', 1, 0, 0]).status, 'deleted', '已暂存的删除也算 deleted');
});

test('内核：init → 写入 → changedFiles 报 untracked → commitAll → 干净', async () => {
  const { fileSystem, workspaceGit } = setup();
  assert.equal(await workspaceGit.isRepo(), false, '未 init 时不是仓库');
  await workspaceGit.init();
  assert.equal(await workspaceGit.isRepo(), true);

  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/README.md`, '# hi\n');
  const before = await workspaceGit.changedFiles();
  assert.deepEqual(before.map(row => [row.path, row.status]), [['README.md', 'untracked']]);

  const oid = await workspaceGit.commitAll('第一次提交');
  assert.match(oid, /^[0-9a-f]{40}$/);
  assert.deepEqual(await workspaceGit.changedFiles(), [], '提交后工作区干净');

  const entries = await workspaceGit.log();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, '第一次提交', '消息已 trim（git 会补换行）');
  assert.equal(entries[0].author.name, GIT_DEFAULT_AUTHOR.name);
});

test('内核：diffModel 给出「旧 blob vs 当前文件」的行模型（复用 lineDiff，不另写算法）', async () => {
  const { fileSystem, workspaceGit } = setup();
  await workspaceGit.init();
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/note.md`, '第一行\n');
  await workspaceGit.commitAll('c1');

  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/note.md`, '第一行\n第二行\n');
  const model = await workspaceGit.diffModel('note.md');
  const text = JSON.stringify(model);
  assert.match(text, /第二行/, '新增行出现在 diff 模型里');
  assert.match(text, /第一行/, '旧行也在（上下文或未改）');

  // 未提交过的新文件：旧侧为空，不抛错
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/new.md`, 'brand new\n');
  const fresh = await workspaceGit.diffModel('new.md');
  assert.match(JSON.stringify(fresh), /brand new/);
});

test('内核：删除文件 → status 报 deleted → commitAll 走 remove（不是 add）', async () => {
  const { fileSystem, workspaceGit } = setup();
  await workspaceGit.init();
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/gone.txt`, 'bye\n');
  await workspaceGit.commitAll('c1');

  await fileSystem.deleteAsync(`${ROOT}${CHARACTER}/gone.txt`);
  const changed = await workspaceGit.changedFiles();
  assert.deepEqual(changed.map(row => [row.path, row.status]), [['gone.txt', 'deleted']]);

  await workspaceGit.commitAll('删除 gone.txt');
  assert.deepEqual(await workspaceGit.changedFiles(), [], '删除已入库，工作区干净');
  assert.equal((await workspaceGit.log()).length, 2);
});

test('内核：空变更不产生空提交（返回 null）', async () => {
  const { workspaceGit } = setup();
  await workspaceGit.init();
  assert.equal(await workspaceGit.commitAll('什么都没改'), null);
  assert.equal((await workspaceGit.log()).length, 0);
});

test('内核：checkoutAll 丢弃工作区改动回到 HEAD（回合回滚）', async () => {
  const { fileSystem, workspaceGit } = setup();
  await workspaceGit.init();
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/x.txt`, 'keep\n');
  await workspaceGit.commitAll('c1');
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/x.txt`, 'wrecked\n');

  await workspaceGit.checkoutAll();
  const restored = await fileSystem.readAsStringAsync(`${ROOT}${CHARACTER}/x.txt`);
  assert.equal(restored, 'keep\n');
  assert.deepEqual(await workspaceGit.changedFiles(), []);
});
