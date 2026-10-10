// P1-11：保留口径可配置（快照条数 / 回滚基线份数 / 会话事件流上限）。
//
// 三个上限分别落在 fileHistory / rollbackBaseline / sessionEvents，这里跑**真函数**
// （不是读常量）：默认值必须与加设置之前逐字一致，配了就必须立即生效，非法值夹区间。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RETENTION,
  HISTORY_KEEP_DEFAULT,
  RETENTION_BOUNDS,
  ROLLBACK_KEEP_DEFAULT,
  SESSION_EVENTS_MAX_KB_DEFAULT,
  normalizeRetention,
  retentionOf,
  sessionEventsMaxBytes,
} from '../src/workspace/retention.js';
import {
  FILE_HISTORY_INDEX,
  HISTORY_MAX,
  listFileHistory,
  readFileHistoryEntry,
  recordFileHistory,
} from '../src/workspace/fileHistory.js';
import {
  ROLLBACK_KEEP,
  listRollbackSnapshots,
  writeRollbackSnapshot,
} from '../src/workspace/rollbackBaseline.js';
import {
  SESSION_EVENTS_MAX_BYTES,
  appendSessionEvent,
  sessionEventsPath,
} from '../src/workspace/sessionEvents.js';

// fake store：内存文件表 + 删除记录 + 目录列举（回滚基线要用 listWorkspaceFiles）。
function makeStore(retention) {
  const files = new Map();
  const deleted = [];
  const store = {
    async writeWorkspaceFile({ path, content }) { files.set(path, content); },
    async readWorkspaceFile({ path }) {
      if (!files.has(path)) throw new Error('missing');
      return { content: files.get(path) };
    },
    async deleteFile({ path }) { deleted.push(path); files.delete(path); },
    async listWorkspaceFiles({ subdir = '' } = {}) {
      const prefix = subdir ? `${subdir}/` : '';
      return [...files.keys()].filter(path => path.startsWith(prefix));
    },
  };
  if (retention !== undefined) store.retention = retention;
  return { store, files, deleted };
}

test('默认口径与历史常量一致（配了设置不该悄悄改默认行为）', () => {
  assert.deepEqual(normalizeRetention(undefined), DEFAULT_RETENTION);
  assert.deepEqual(normalizeRetention({}), DEFAULT_RETENTION);
  assert.deepEqual(normalizeRetention(null), DEFAULT_RETENTION);
  assert.equal(HISTORY_MAX, HISTORY_KEEP_DEFAULT);
  assert.equal(ROLLBACK_KEEP, ROLLBACK_KEEP_DEFAULT);
  assert.equal(SESSION_EVENTS_MAX_BYTES, SESSION_EVENTS_MAX_KB_DEFAULT * 1024);
  assert.equal(DEFAULT_RETENTION.historyKeep, 200, '默认 200 条（设置层文案里的数字）');
  assert.equal(DEFAULT_RETENTION.rollbackKeep, 3);
  assert.equal(DEFAULT_RETENTION.sessionEventsMaxKb, 512);
});

test('归一化：非法回落默认、合法值夹区间（不允许把上限配成 0 或负数）', () => {
  assert.deepEqual(normalizeRetention({ historyKeep: 0, rollbackKeep: -5, sessionEventsMaxKb: 'abc' }), {
    historyKeep: RETENTION_BOUNDS.historyKeep.min,
    rollbackKeep: RETENTION_BOUNDS.rollbackKeep.min,
    sessionEventsMaxKb: DEFAULT_RETENTION.sessionEventsMaxKb,
  });
  assert.deepEqual(normalizeRetention({ historyKeep: 999999, rollbackKeep: 999, sessionEventsMaxKb: 999999 }), {
    historyKeep: RETENTION_BOUNDS.historyKeep.max,
    rollbackKeep: RETENTION_BOUNDS.rollbackKeep.max,
    sessionEventsMaxKb: RETENTION_BOUNDS.sessionEventsMaxKb.max,
  });
  assert.deepEqual(normalizeRetention({ historyKeep: '42.9', rollbackKeep: 2 }), {
    historyKeep: 42,
    rollbackKeep: 2,
    sessionEventsMaxKb: DEFAULT_RETENTION.sessionEventsMaxKb,
  }, '数字字符串也收（设置页输入框给的就是字符串），小数向下取整');
  // 从 store / 设置对象取生效值：同一个字段名。
  assert.equal(retentionOf({ retention: { historyKeep: 30 } }).historyKeep, 30);
  assert.equal(retentionOf(null).historyKeep, HISTORY_KEEP_DEFAULT);
  assert.equal(sessionEventsMaxBytes({ sessionEventsMaxKb: 64 }), 64 * 1024);
});

test('文件快照条数：store.retention.historyKeep 生效，index 与条目文件始终对得上', async () => {
  const { store, files, deleted } = makeStore({ historyKeep: 12 });
  // 同一个文件改 15 次：基线保护下，index 里留下的每一条都必须真的有条目文件。
  for (let i = 0; i < 15; i += 1) {
    const result = await recordFileHistory(store, 'c1', { path: 'a.txt', oldContent: `v${i}`, at: 1000 + i });
    assert.equal(result.ok, true);
  }
  const index = JSON.parse(files.get(FILE_HISTORY_INDEX));
  assert.equal(index.length, 12, '收敛到配置的 12 条（不是默认 200）');
  assert.equal(deleted.length, 3, '挤出 3 条');
  for (const item of index) {
    const entry = await readFileHistoryEntry(store, 'c1', item.id);
    assert.ok(entry && typeof entry.content === 'string', `index 里的 ${item.id} 必须仍可读（不能列出已被删文件的快照）`);
  }
  const head = await listFileHistory(store, 'c1', 'a.txt');
  assert.equal(head.length, 12);
  assert.equal(head[0].at, 1014, '最新一条在最前');

  // 没配 retention 的 store（老数据/假 store）走默认 200：行为与加设置之前一致。
  const plain = makeStore();
  await recordFileHistory(plain.store, 'c1', { path: 'a.txt', oldContent: 'x' });
  assert.equal(JSON.parse(plain.files.get(FILE_HISTORY_INDEX)).length, 1);
  assert.equal(HISTORY_MAX, 200);
});

test('回滚基线份数：store.retention.rollbackKeep 生效（默认仍是 3）', async () => {
  const { store, files } = makeStore({ rollbackKeep: 1 });
  const payload = at => ({ owner: 'o', repo: 'r', branch: 'main', commit: 'c', at, entries: [] });
  await writeRollbackSnapshot(store, 'c1', payload(1000));
  await writeRollbackSnapshot(store, 'c1', payload(2000));
  await writeRollbackSnapshot(store, 'c1', payload(3000));
  const snapshots = await listRollbackSnapshots(store, 'c1');
  assert.equal(snapshots.length, 1, '只留最近 1 份');
  assert.ok(snapshots[0].path.endsWith('3000.json'), '留的是最新那份');
  assert.equal([...files.keys()].filter(path => path.startsWith('.easychat/rollback/')).length, 1);

  const plain = makeStore();
  await writeRollbackSnapshot(plain.store, 'c1', payload(1000));
  await writeRollbackSnapshot(plain.store, 'c1', payload(2000));
  await writeRollbackSnapshot(plain.store, 'c1', payload(3000));
  assert.equal((await listRollbackSnapshots(plain.store, 'c1')).length, ROLLBACK_KEEP, '默认 3 份');
});

test('会话事件流上限：store.retention.sessionEventsMaxKb 生效（到上限如实返回 null）', async () => {
  const { store, files } = makeStore({ sessionEventsMaxKb: 64 });
  const path = sessionEventsPath('chat-1');
  let appended = 0;
  for (let i = 0; i < 400; i += 1) {
    const event = await appendSessionEvent(store, 'c1', 'chat-1', 'user', { text: 'x'.repeat(200) });
    if (event) appended += 1;
  }
  assert.ok(appended > 0, '至少写进去几条');
  assert.ok(appended < 400, '到上限就停（不是无限追加）');
  assert.ok(files.get(path).length <= 64 * 1024 + 400, '文件不超过配置上限太多（最后一条允许略微越过）');
  assert.equal(
    await appendSessionEvent(store, 'c1', 'chat-1', 'user', { text: 'y' }),
    null,
    '超限后如实返回 null（不假装写入成功）'
  );

  // 默认 512KB 时同样的循环不会被拦（证明差异来自配置而不是别的原因）。
  const plain = makeStore();
  for (let i = 0; i < 400; i += 1) {
    await appendSessionEvent(plain.store, 'c1', 'chat-1', 'user', { text: 'x'.repeat(200) });
  }
  assert.ok(plain.files.get(path).length > 64 * 1024, '默认上限下写进了 64KB 以上');
});
