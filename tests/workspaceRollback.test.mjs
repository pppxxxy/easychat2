// H3 回滚基线测试：纯函数（构造 / 解析 / 挑选 / 轮换 / 可恢复性）+ IO（fake store 往返与恢复）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRollbackSnapshot,
  buildRollbackPayload,
  listRollbackSnapshots,
  parseRollbackSnapshot,
  pickRollbackSnapshots,
  readLatestRollbackSnapshot,
  ROLLBACK_DIR,
  ROLLBACK_KEEP,
  rollbackRestorableEntries,
  rollbackRotationDeletes,
  rollbackSnapshotPath,
  writeRollbackSnapshot,
} from '../src/workspace/rollbackBaseline.js';

test('H3 快照构造/解析：自包含（owner/repo/branch/commit）+ 坏输入安全', () => {
  const payload = buildRollbackPayload({
    owner: 'o',
    repo: 'r',
    branch: 'main',
    commit: 'abc123',
    at: 1700000000000,
    rollback: {
      entries: [
        { path: 'a.txt', sha: 'sha-a', content: 'old-a' },
        { path: 'b.txt', sha: 'sha-b', content: null, reason: 'too-large' },
        { path: '' },
      ],
      skippedCount: 2,
    },
  });
  assert.equal(payload.at, 1700000000000);
  assert.equal(payload.commit, 'abc123');
  assert.equal(payload.entries.length, 2, '空路径丢弃');
  assert.equal(payload.entries[0].content, 'old-a');
  assert.equal(payload.entries[1].content, null);
  assert.equal(payload.entries[1].reason, 'too-large');
  assert.equal(payload.skippedCount, 2);

  assert.deepEqual(parseRollbackSnapshot(JSON.stringify(payload)).entries.length, 2, 'round-trip');
  assert.equal(parseRollbackSnapshot('{坏'), null);
  assert.equal(parseRollbackSnapshot('[]'), null);
  assert.equal(parseRollbackSnapshot({ no: 'entries' }), null, '缺 entries 视为无效');
  assert.equal(parseRollbackSnapshot(null), null);

  // 路径生成：非法 ts 用当前时间兜底（仍然可写）
  assert.match(rollbackSnapshotPath(5), /^\.easychat\/rollback\/5\.json$/);
  assert.match(rollbackSnapshotPath('bad'), /^\.easychat\/rollback\/\d+\.json$/);
});

test('H3 快照挑选与轮换：按时间戳降序、保留最近 KEEP 份', () => {
  const picked = pickRollbackSnapshots([
    `${ROLLBACK_DIR}/100.json`,
    `${ROLLBACK_DIR}/300.json`,
    `${ROLLBACK_DIR}/200.json`,
    `${ROLLBACK_DIR}/`,
    `${ROLLBACK_DIR}/notes.txt`,
    '.easychat/other/999.json',
    'repos/o/r/main/a.js',
  ]);
  assert.deepEqual(picked.map(item => item.ts), [300, 200, 100], '降序（最新在前）');
  const deletes = rollbackRotationDeletes(picked, ROLLBACK_KEEP);
  assert.deepEqual(deletes, [], `${ROLLBACK_KEEP} 份以内不删`);
  const more = pickRollbackSnapshots(
    Array.from({ length: 5 }, (_, i) => `${ROLLBACK_DIR}/${(i + 1) * 100}.json`)
  );
  assert.deepEqual(rollbackRotationDeletes(more, 3), [
    `${ROLLBACK_DIR}/200.json`,
    `${ROLLBACK_DIR}/100.json`,
  ], '保留最近 3 份、最旧两份待删');

  // 可恢复性分组
  const { restorable, unrestorable } = rollbackRestorableEntries({
    entries: [
      { path: 'a', content: 'x' },
      { path: 'b', content: null },
      { path: 'c' },
    ],
  });
  assert.deepEqual(restorable.map(item => item.path), ['a']);
  assert.deepEqual(unrestorable.map(item => item.path), ['b', 'c']);
});

test('H3 IO 往返：写 + 轮换删除 + 读最新 + 应用恢复（单条失败不拖垮其余）', async () => {
  const files = new Map();
  const deleted = [];
  const store = {
    async listWorkspaceFiles({ subdir }) {
      const prefix = `${subdir}/`;
      return [...files.keys()].filter(path => path.startsWith(prefix));
    },
    async writeWorkspaceFile({ path, content }) {
      if (path.endsWith('boom.txt')) throw new Error('write fail');
      files.set(path, content);
    },
    async readWorkspaceFile({ path }) {
      if (!files.has(path)) throw new Error('missing');
      return { content: files.get(path) };
    },
    async deleteFile({ path }) {
      deleted.push(path);
      files.delete(path);
    },
  };

  const make = at => buildRollbackPayload({
    owner: 'o', repo: 'r', branch: 'main', commit: `c${at}`, at,
    rollback: { entries: [{ path: 'a.txt', sha: 's', content: `old-${at}` }] },
  });
  // 写 5 份 → 轮换只留最近 3 份（最旧两份被删）
  for (const at of [100, 200, 300, 400, 500]) {
    assert.ok(await writeRollbackSnapshot(store, 'c1', make(at)), '写入成功');
  }
  const snapshots = await listRollbackSnapshots(store, 'c1');
  assert.deepEqual(snapshots.map(item => item.ts), [500, 400, 300], '只保留最近 3 份');
  assert.equal(deleted.length, 2, '旧两份被删');

  // 读最新一份
  const latest = await readLatestRollbackSnapshot(store, 'c1');
  assert.equal(latest.at, 500);
  assert.equal(latest.entries[0].content, 'old-500');

  // 应用恢复：带前缀写回；单条失败记账不中断
  const payload = buildRollbackPayload({
    owner: 'o', repo: 'r', branch: 'main', commit: 'c9', at: 900,
    rollback: {
      entries: [
        { path: 'ok.txt', sha: 's1', content: 'restored!' },
        { path: 'boom.txt', sha: 's2', content: 'will fail' },
        { path: 'lost.txt', sha: 's3', content: null, reason: 'too-large' },
      ],
    },
  });
  const outcome = await applyRollbackSnapshot({
    store,
    characterId: 'c1',
    payload,
    localPrefix: 'repos/o/r/main/',
  });
  assert.deepEqual(outcome.restored, ['ok.txt']);
  assert.deepEqual(outcome.failed, ['boom.txt']);
  assert.deepEqual(outcome.unrestorable, ['lost.txt']);
  assert.equal(files.get('repos/o/r/main/ok.txt'), 'restored!', '带前缀写回');

  // 旁路：缺 store / 无快照都安全
  assert.equal(await readLatestRollbackSnapshot(null, 'c1'), null);
  assert.equal(await writeRollbackSnapshot(null, 'c1', make(1)), null);
  assert.deepEqual(
    (await applyRollbackSnapshot({ store: null, characterId: 'c1', payload, localPrefix: '' })).restored,
    []
  );
});
