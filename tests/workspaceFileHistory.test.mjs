// J1 文件历史（写前快照）测试：纯函数（元数据收敛/轮换）+ IO（记录/读取/恢复/轮换）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  FILE_HISTORY_DIR,
  FILE_HISTORY_INDEX,
  historyRotationDeletes,
  listFileHistory,
  listFileHistoryPaths,
  normalizeHistoryEntry,
  recordFileHistory,
  readFileHistoryEntry,
  restoreFileHistory,
  summarizeFileHistory,
  HISTORY_ENTRY_MAX_CHARS,
  HISTORY_MAX,
} from '../src/workspace/fileHistory.js';
import { ROLLBACK_KEEP } from '../src/workspace/rollbackBaseline.js';
import { SESSION_EVENTS_MAX_BYTES } from '../src/workspace/sessionEvents.js';
import { zhCN } from '../src/i18n/locales/zh-CN.js';
import { en } from '../src/i18n/locales/en.js';

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

test('J1 轮换：每个路径最旧的一条（基线）不参与轮换', () => {
  // 同一路径 5 条（新→旧）、上限 3：只删中间两条，最新与基线都留。
  const same = [
    { id: 'a0', path: 'f.js', at: 500 },
    { id: 'a1', path: 'f.js', at: 400 },
    { id: 'a2', path: 'f.js', at: 300 },
    { id: 'a3', path: 'f.js', at: 200 },
    { id: 'a4', path: 'f.js', at: 100 },
  ];
  assert.deepEqual(historyRotationDeletes(same, 3), ['a2', 'a3'], '只删最旧的非基线');
  assert.deepEqual(historyRotationDeletes(same, 5), [], '不超上限不删');

  // 多路径混合：先删非基线，各路径的基线各自保留。
  const mixed = [
    { id: 'b0', path: 'b.js', at: 900 },
    { id: 'b1', path: 'b.js', at: 800 },
    { id: 'a0', path: 'a.js', at: 700 },
    { id: 'a1', path: 'a.js', at: 600 },
    { id: 'b2', path: 'b.js', at: 500 },
    { id: 'a2', path: 'a.js', at: 400 },
  ];
  const mixedDeletes = historyRotationDeletes(mixed, 4);
  assert.equal(mixedDeletes.length, 2);
  assert.ok(!mixedDeletes.includes('a2') && !mixedDeletes.includes('b2'), '基线不删');
  assert.deepEqual(mixedDeletes, ['a0', 'a1'], '删的是最旧的非基线');

  // 路径数本身就超过上限：连基线一起删，保证 index 有界。
  const manyPaths = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, path: `p${i}.js`, at: 100 - i }));
  assert.deepEqual(historyRotationDeletes(manyPaths, 3), ['p3', 'p4'], '从最旧的基线开始删');

  // 无 path 的坏条目没有基线可言，退回纯「丢最旧」。
  const noPath = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}` }));
  assert.deepEqual(historyRotationDeletes(noPath, 2), ['n2', 'n3']);
});

test('J1 总览汇总：按路径计数/可恢复数/最新最早时间，按最新倒序', () => {
  const summary = summarizeFileHistory([
    { id: '1', path: 'a.js', at: 300, restorable: true },
    { id: '2', path: 'b.js', at: 500, restorable: true },
    { id: '3', path: 'a.js', at: 100, restorable: false },
    { id: '4', path: 'a.js', at: 200, restorable: true },
    { id: '5', at: 999, restorable: true },              // 无 path → 丢弃
    { id: '6', path: 'b.js', at: 400, restorable: true },
  ]);
  assert.deepEqual(summary.map(item => item.path), ['b.js', 'a.js'], '按最新时间倒序');
  const a = summary.find(item => item.path === 'a.js');
  assert.equal(a.count, 3);
  assert.equal(a.restorableCount, 2, '不可恢复条目如实计入总数但不算可恢复');
  assert.equal(a.latestAt, 300);
  assert.equal(a.oldestAt, 100);
  assert.deepEqual(summarizeFileHistory(null), []);
});

test('J1 listFileHistoryPaths：总览走真实 index（含坏输入兜底）', async () => {
  const { store } = makeStore();
  await recordFileHistory(store, 'c1', { path: 'x.js', oldContent: 'v1', at: 100 });
  await recordFileHistory(store, 'c1', { path: 'x.js', oldContent: 'v2', at: 200 });
  await recordFileHistory(store, 'c1', { path: 'y.md', oldContent: 'w1', at: 300 });
  const summary = await listFileHistoryPaths(store, 'c1');
  assert.deepEqual(summary.map(item => item.path).sort(), ['x.js', 'y.md']);
  assert.equal(summary.find(item => item.path === 'x.js').count, 2);
  assert.deepEqual(await listFileHistoryPaths(null, 'c1'), [], '坏 store 不抛错');
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

test('保留口径的对外文案与代码常量一致（改了常量必须同步改文案）', () => {
  // 设置层把「最近 200 条 / 单条 256KB / 保留 3 份 / 事件流 512KB」写给了用户看。
  // 这些数字是承诺：常量改了而文案没改，界面就在说谎（仓库纪律：如实告知）。
  const zhHistory = zhCN['workspace.settings.history.hint'];
  const enHistory = en['workspace.settings.history.hint'];
  assert.ok(zhHistory.includes(String(HISTORY_MAX)), `快照条数 ${HISTORY_MAX} 应出现在中文文案里`);
  assert.ok(zhHistory.includes(`${HISTORY_ENTRY_MAX_CHARS / 1024}KB`), '单条上限应出现');
  assert.ok(zhHistory.includes(String(ROLLBACK_KEEP)), `回滚基线份数 ${ROLLBACK_KEEP} 应出现`);
  assert.ok(enHistory.includes(String(HISTORY_MAX)) && enHistory.includes(String(ROLLBACK_KEEP)), '英文文案同步');

  const eventsKb = SESSION_EVENTS_MAX_BYTES / 1024;
  assert.ok(zhCN['workspace.settings.events.hint'].includes(`${eventsKb}KB`), `事件流上限 ${eventsKb}KB 应出现`);
  assert.ok(en['workspace.settings.events.hint'].includes(`${eventsKb} KB`), '英文文案同步');
});

test('J1 二期接线：文件面板打开「文件历史」，sheet 走 list/read/restore 三件事', () => {
  // UI 组件在 Node 里进不来（RN），接线只能钉源码——与 WorkspaceHistorySheet 同款做法。
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/FilesPanel.js'), 'utf8');
  assert.ok(panel.includes("import FileHistorySheet from '../FileHistorySheet.js';"), '面板引入历史 sheet');
  assert.ok(panel.includes('setHistoryPath(preview.path)'), '预览里能带着当前文件路径打开历史');
  assert.ok(panel.includes("setHistoryPath(''); setHistoryOpen(true);"), '工具栏有总览入口（路径为空 = 看全部有历史的文件）');
  assert.ok(panel.includes('path={historyPath}'), '把路径传给 sheet');
  assert.ok(panel.includes('visible={historyOpen}'), '开关与路径分开（总览时 path 为空但面板要开）');
  assert.ok(panel.includes('onRestored={() => {'), '恢复后有回调（刷新列表 + 关掉过期预览）');

  const sheet = fs.readFileSync(path.resolve('src/workspace/FileHistorySheet.js'), 'utf8');
  assert.ok(sheet.includes('listFileHistoryPaths(store, characterId)'), '总览走 listFileHistoryPaths');
  assert.ok(sheet.includes('listFileHistory(store, characterId, activePath'), '单文件走 listFileHistory');
  assert.ok(sheet.includes('restoreFileHistory(store, characterId, entry.id, { currentContent: current })'), '恢复走 restoreFileHistory 并带上当前内容（可逆）');
  assert.ok(sheet.includes('<DiffView'), '恢复前用 DiffView 看「会变成什么」');
  assert.ok(sheet.includes("t('workspace.fileHistory.hint')"), '如实告知覆盖面边界');
  // 词条中英都在（缺一边会被 i18n 一致性测试拦下，这里给出更早的失败点）。
  assert.ok(zhCN['workspace.fileHistory.title'] && en['workspace.fileHistory.title'], '标题词条双语齐备');
  assert.ok(zhCN['workspace.fileHistory.restoreBody'].includes('{path}'), '恢复确认文案带路径占位符');
});
