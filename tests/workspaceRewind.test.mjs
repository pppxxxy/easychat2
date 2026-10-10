// 工作区回退联动（Z 系采纳 #7）：分叉时刻 → 需恢复的快照；IO 恢复。纯函数 + 假 store。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { planWorkspaceRewind, planWorkspaceRewindForStore, rewindWorkspaceFiles } from '../src/workspace/rewind.js';

test('接线：ChatScreen 分支回退联动工作区（经 useWorkspaceRewind）', () => {
  const screen = readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  assert.ok(screen.includes("import useWorkspaceRewind from './chat/useWorkspaceRewind.js';"));
  assert.ok(screen.includes('rewindWorkspace({ sessionId, forkMessageId: plan.forkMessageId })'));
  const hook = readFileSync(path.resolve('src/chat/useWorkspaceRewind.js'), 'utf8');
  assert.ok(hook.includes('planWorkspaceRewindForStore'), '先规划');
  assert.ok(hook.includes('rewindWorkspaceFiles'), '确认后恢复');
});

const entry = (id, path, at, restorable = true) => ({ id, path, at, restorable, source: 'tool', size: 3 });

test('planWorkspaceRewind：取「分叉后最早一次写」的快照（= 分叉时的状态）', () => {
  const index = [
    entry('e-late', 'a.txt', 400),
    entry('e-early', 'a.txt', 300), // 分叉后最早
    entry('e-before', 'a.txt', 100), // 分叉前，忽略
    entry('e-untouched', 'b.txt', 100), // 分叉前，忽略
  ];
  const plan = planWorkspaceRewind(index, 200);
  assert.equal(plan.restores.length, 1);
  assert.equal(plan.restores[0].path, 'a.txt');
  assert.equal(plan.restores[0].entryId, 'e-early');
});

test('planWorkspaceRewind：分叉后没写过的文件不动；多文件按时间升序', () => {
  const index = [
    entry('x2', 'x.txt', 500),
    entry('x1', 'x.txt', 300),
    entry('y1', 'y.txt', 350),
    entry('z', 'z.txt', 100),
  ];
  const plan = planWorkspaceRewind(index, 200);
  assert.deepEqual(plan.restores.map(r => r.path), ['x.txt', 'y.txt']);
  assert.deepEqual(plan.restores.map(r => r.entryId), ['x1', 'y1']);
});

test('planWorkspaceRewind：无效时刻 → 不恢复', () => {
  assert.deepEqual(planWorkspaceRewind([entry('e', 'a', 300)], 0), { restores: [] });
  assert.deepEqual(planWorkspaceRewind([], 200), { restores: [] });
});

test('planWorkspaceRewind：不可恢复条目如实标记 restorable:false', () => {
  const plan = planWorkspaceRewind([entry('big', 'a.txt', 300, false)], 200);
  assert.equal(plan.restores[0].restorable, false);
});

function makeStore(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async readWorkspaceFile({ path }) {
      if (!files.has(path)) throw new Error(`missing: ${path}`);
      return { content: files.get(path) };
    },
    async writeWorkspaceFile({ path, content }) { files.set(path, content); },
    async deleteFile({ path }) { files.delete(path); },
  };
}

test('rewindWorkspaceFiles：把文件恢复成分叉时刻的内容', async () => {
  const store = makeStore({
    '.easychat/file-history/index.json': JSON.stringify([entry('e1', 'a.txt', 300)]),
    '.easychat/file-history/entries/e1.json': JSON.stringify({ id: 'e1', path: 'a.txt', content: 'OLD', at: 300 }),
    'a.txt': 'NEW',
  });
  const result = await rewindWorkspaceFiles({ store, characterId: 'c1', targetAt: 200 });
  assert.deepEqual(result.restored, ['a.txt']);
  assert.equal(store.files.get('a.txt'), 'OLD');
});

test('rewindWorkspaceFiles：分叉后没写过 → 不动文件', async () => {
  const store = makeStore({
    '.easychat/file-history/index.json': JSON.stringify([entry('e1', 'a.txt', 100)]),
    'a.txt': 'NOW',
  });
  const result = await rewindWorkspaceFiles({ store, characterId: 'c1', targetAt: 200 });
  assert.equal(result.total, 0);
  assert.equal(store.files.get('a.txt'), 'NOW');
});

test('planWorkspaceRewindForStore：只规划不落盘', async () => {
  const store = makeStore({
    '.easychat/file-history/index.json': JSON.stringify([entry('e1', 'a.txt', 300)]),
    'a.txt': 'NEW',
  });
  const plan = await planWorkspaceRewindForStore({ store, characterId: 'c1', targetAt: 200 });
  assert.equal(plan.restores.length, 1);
  assert.equal(store.files.get('a.txt'), 'NEW', '规划阶段不写盘');
});
