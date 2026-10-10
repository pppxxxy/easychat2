// W7：回合检查点（src/workspace/gitCheckpoint.js）——每轮结束把改动落成本地提交。
//
// 钉住三条纪律：不阻塞不失败回合（异常吞掉并如实回报）、不产生空提交、不替用户开仓库。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKPOINT_FALLBACK_MESSAGE,
  buildCheckpointMessage,
  runTurnCheckpoint,
} from '../src/workspace/gitCheckpoint.js';
import { createWorkspaceGit } from '../src/workspace/git.js';
import { createMemoryFileSystem } from './helpers/memoryFileSystem.mjs';

const ROOT = '/doc/workspace/';
const CHARACTER = 'ch1';

function setup() {
  const fileSystem = createMemoryFileSystem();
  const runner = {
    open: ({ characterId = CHARACTER } = {}) => createWorkspaceGit({ root: ROOT, characterId, fileSystem }),
    ensureRepo: async ({ characterId = CHARACTER } = {}) => {
      const handle = runner.open({ characterId });
      if (!(await handle.isRepo())) await handle.init();
      return handle;
    },
  };
  return { fileSystem, runner };
}

test('buildCheckpointMessage：折叠空白 + 截断 + 空请求回落', () => {
  assert.equal(buildCheckpointMessage('  修一下   登录  '), '修一下 登录');
  assert.equal(buildCheckpointMessage('多行\n请求\t也折叠'), '多行 请求 也折叠');
  assert.equal(buildCheckpointMessage(''), CHECKPOINT_FALLBACK_MESSAGE);
  assert.equal(buildCheckpointMessage(null), CHECKPOINT_FALLBACK_MESSAGE);
  assert.equal(buildCheckpointMessage('   '), CHECKPOINT_FALLBACK_MESSAGE);
  const long = buildCheckpointMessage('x'.repeat(200), { max: 10 });
  assert.equal(long, `${'x'.repeat(10)}…`, '超长截断带省略号');
});

test('runTurnCheckpoint：没有 runner（开关关 / 外部根）→ 直接跳过', async () => {
  assert.deepEqual(await runTurnCheckpoint({ git: null, request: 'x' }), { ok: false, skipped: 'no-git' });
  assert.deepEqual(await runTurnCheckpoint({}), { ok: false, skipped: 'no-git' });
});

test('runTurnCheckpoint：仓库还没建 → 跳过（不替用户开仓库）', async () => {
  const { fileSystem, runner } = setup();
  const result = await runTurnCheckpoint({ git: runner, request: '随便', characterId: CHARACTER });
  assert.deepEqual(result, { ok: false, skipped: 'no-repo' });
  assert.deepEqual([...fileSystem.nodes.keys()].filter(key => key.includes('/.git')), [], '不得顺手建仓库');
});

test('runTurnCheckpoint：本轮没改动 → 不产生空提交', async () => {
  const { runner } = setup();
  await runner.ensureRepo({ characterId: CHARACTER });
  const result = await runTurnCheckpoint({ git: runner, request: '什么都没改', characterId: CHARACTER });
  assert.deepEqual(result, { ok: false, skipped: 'no-change' });
});

test('runTurnCheckpoint：有改动 → 提交，说明就是那一轮的请求', async () => {
  const { fileSystem, runner } = setup();
  const handle = await runner.ensureRepo({ characterId: CHARACTER });
  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/a.txt`, 'v1\n');
  await handle.commitAll('初始');

  await fileSystem.writeAsStringAsync(`${ROOT}${CHARACTER}/a.txt`, 'v2\n');
  const result = await runTurnCheckpoint({ git: runner, request: '把 a.txt 改成 v2', characterId: CHARACTER });
  assert.equal(result.ok, true);
  assert.match(result.oid, /^[0-9a-f]{40}$/);

  const log = await handle.log();
  assert.equal(log[0].message, '把 a.txt 改成 v2', '新提交在最前');
  assert.deepEqual(await handle.changedFiles(), [], '提交后工作区干净');

  // 再跑一次：没有新改动 → 空提交
  const again = await runTurnCheckpoint({ git: runner, request: '把 a.txt 改成 v2', characterId: CHARACTER });
  assert.equal(again.skipped, 'no-change');
});

test('runTurnCheckpoint：提交抛错被吞掉并如实回报（绝不让回合失败）', async () => {
  const result = await runTurnCheckpoint({
    git: { open: () => ({ isRepo: async () => true, commitAll: async () => { throw new Error('磁盘满了'); } }) },
    request: 'x',
    characterId: CHARACTER,
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'failed');
  assert.match(result.error, /磁盘满了/);
});
