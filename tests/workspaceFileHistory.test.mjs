// J1 文件历史（写前快照）测试：纯函数（元数据收敛/轮换）+ IO（记录/读取/恢复/轮换）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_HISTORY_DIR,
  FILE_HISTORY_INDEX,
  historyRotationDeletes,
  listFileHistory,
  normalizeHistoryEntry,
  recordFileHistory,
  readFileHistoryEntry,
  restoreFileHistory,
  HISTORY_ENTRY_MAX_CHARS,
  HISTORY_MAX,
} from '../src/workspace/fileHistory.js';

// fake SAF store：内存文件表 + delete 记录。
function makeStore() {
  const files = new Map();
  const deleted = [];
  return {
    files,
    deleted,
    store: {
      async writeWorkspaceFile({ path, content }) { files.set(path, content); },
      async readWorkspaceFile({ path }) {
        if (!files.has(path)) throw new Error('missing');
        return { content: files.get(path) };
      },
      async deleteFile({ path }) { deleted.push(path); files.delete(path); },
    },
  };
}

test('J1 元数据收敛：白名单字段 / 坏输入 null / 来源收敛', () => {
  const meta = normalizeHistoryEntry({
    id: 'abc-1',
    path: 'src/a.js',
    source: 'push-baseline',
    size: 12,
    restorable: true,
    at: 555,
    extra: 'ignored',
  });
  assert.deepEqual(meta, {
    id: 'abc-1',
    path: 'src/a.js',
    source: 'push-baseline',
    size: 12,
    restorable: true,
    at: 555,
  });
  assert.equal(normalizeHistoryEntry({ id: '', path: 'x' }), null, '缺 id → null');
  assert.equal(normalizeHistoryEntry({ id: 'x', path: '' }), null, '缺 path → null');
  assert.equal(normalizeHistoryEntry({ id: 'x', path: 'y', source: 'hacker' }).source, 'tool', '未知来源收敛 tool');
});

test('J1 轮换：超上限丢最旧（id 列表）', () => {
  const index = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => ({ id: `e${i}` }));
  const deletes = historyRotationDeletes(index);
  assert.equal(deletes.length, 5);
  assert.deepEqual(deletes, ['e200', 'e201', 'e202', 'e203', 'e204'], '最旧的先删');
  assert.deepEqual(historyRotationDeletes(index.slice(0, 3)), []);
});

test('J1 记录/读取：新建记空内容可逆 / 常规覆盖 / 列表按路径过滤最新在前', async () => {
  const { store, files } = makeStore();

  // 新建（无旧内容）：同样记录（删除可逆）
  const created = await recordFileHistory(store, 'c1', { path: 'new.js', oldContent: '', source: 'tool', at: 100 });
  assert.equal(created.ok, true);
  assert.ok(files.has(FILE_HISTORY_INDEX), 'index 落盘');
  assert.ok([...files.keys()].some(path => path.startsWith(`${FILE_HISTORY_DIR}/entries/`)), '条目文件落盘');

  // 覆盖（有旧内容）
  await recordFileHistory(store, 'c1', { path: 'new.js', oldContent: 'old body', source: 'tool', at: 200 });

  // 列表：同路径最新在前
  const list = await listFileHistory(store, 'c1', 'new.js');
  assert.equal(list.length, 2);
  assert.equal(list[0].at, 200, '最新在前');
  assert.equal(list[0].size, 8, 'old body 长度');

  // 读单条：内容原样
  const entry = await readFileHistoryEntry(store, 'c1', list[1].id);
  assert.equal(entry.content, '', '新建条目内容为空（可逆恢复成空文件）');
  const entry2 = await readFileHistoryEntry(store, 'c1', list[0].id);
  assert.equal(entry2.content, 'old body');

  // 其它路径的列表为空（路径过滤）
  assert.deepEqual(await listFileHistory(store, 'c1', 'other.js'), []);
});

test('J1 恢复：写回旧内容 + 恢复前先快照当前（天然可逆）', async () => {
  const { store, files } = makeStore();
  await recordFileHistory(store, 'c1', { path: 'a.js', oldContent: 'version-1', at: 100 });
  const list = await listFileHistory(store, 'c1', 'a.js');

  // 恢复（当前内容 'current' 会被先快照）
  const out = await restoreFileHistory(store, 'c1', list[0].id, { currentContent: 'current' });
  assert.equal(out.ok, true);
  assert.equal(files.get('a.js'), 'version-1', '写回旧内容');

  // 恢复动作本身进了历史（再恢复一次就能回到 current）
  const after = await listFileHistory(store, 'c1', 'a.js');
  assert.equal(after.length, 2);
  const snapshot = await readFileHistoryEntry(store, 'c1', after[0].id);
  assert.equal(snapshot.content, 'current', '恢复前的当前内容被快照');

  // 不可恢复条目（超限）：如实拒（restorable false → not-restorable）
  const huge = await recordFileHistory(store, 'c1', {
    path: 'big.log',
    oldContent: 'x'.repeat(HISTORY_ENTRY_MAX_CHARS + 1),
  });
  assert.equal(huge.ok, true, '超限条目元数据仍记录');
  const bigEntry = await readFileHistoryEntry(store, 'c1', huge.id);
  assert.equal(bigEntry.restorable, false, '如实标记不可恢复');
  assert.equal(bigEntry.content, null);
  const refused = await restoreFileHistory(store, 'c1', huge.id, { currentContent: '' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not-restorable');

  // 不存在的条目 → not-found
  assert.equal((await restoreFileHistory(store, 'c1', 'nope-1', {})).reason, 'not-found');
});

test('J1 轮换实测：写超上限后 index 收敛 + 最旧条目文件被删', async () => {
  const { store, files, deleted } = makeStore();
  for (let i = 0; i < HISTORY_MAX + 3; i += 1) {
    await recordFileHistory(store, 'c1', { path: `f${i}.txt`, oldContent: `v${i}`, at: 1000 + i });
  }
  const index = JSON.parse(files.get(FILE_HISTORY_INDEX));
  assert.equal(index.length, HISTORY_MAX, 'index 收敛到上限');
  // 最旧三条的条目文件被删（f0/f1/f2 的快照）
  assert.ok(deleted.some(path => path.includes('e') && path.endsWith('.json')), '有旧条目被清理');
  // 最新三条仍可读
  const head = await listFileHistory(store, 'c1', 'f202.txt');
  const entry = await readFileHistoryEntry(store, 'c1', head[0].id);
  assert.equal(entry.content, 'v202');
});

test('J1 旁路纪律：坏 store / 空 path 绝不抛错', async () => {
  assert.equal((await recordFileHistory(null, 'c1', { path: 'a', oldContent: 'x' })).ok, false);
  assert.equal((await recordFileHistory(makeStore().store, 'c1', { path: '', oldContent: 'x' })).ok, false);
  assert.deepEqual(await listFileHistory(null, 'c1', 'a'), []);
  assert.equal(await readFileHistoryEntry(null, 'c1', 'x'), null);
  assert.equal((await restoreFileHistory(null, 'c1', 'x', {})).ok, false);
});
