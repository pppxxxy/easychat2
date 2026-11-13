// 桌面记忆列表视图模型（memoryListView）的行为测试。
//
// 这张表驱动「记忆」标签页的全部判定：跨角色汇总、筛选、搜索、时间分档、全选口径。
// 其中「全选必须等于渲染集」是**数据安全**约束——口径不一致会把用户看不见的会话删掉。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMemoryRows,
  flattenMemoryGroups,
  groupMemoryRows,
  memoryFilterOptions,
  selectableSessionIds,
  sessionMatchesQuery,
} from '../../src/memory/memoryListView.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const sessions = [
  { id: 's-pinned', characterId: 'c1', title: '重要', preview: 'PIN', updatedAt: NOW - 30 * DAY, pinned: true },
  { id: 's-recent', characterId: 'c1', title: '最近聊', preview: 'hello world', updatedAt: NOW - 2 * DAY },
  { id: 's-old', characterId: 'c2', title: '旧话题', preview: '很久以前', updatedAt: NOW - 40 * DAY },
  { id: 's-group', characterId: '', type: 'group', name: '读书会', preview: '群聊', updatedAt: NOW - 1 * DAY },
  { id: 's-local', characterId: 'c2', title: '本地模型', modelKind: 'local', updatedAt: NOW - 3 * DAY },
];
const characters = [
  { id: 'c1', name: '角色一' },
  { id: 'c2', name: '角色二' },
];

test('buildMemoryRows：跨角色汇总并挂上角色名（手机按角色、桌面全局）', () => {
  const rows = buildMemoryRows({ sessions, characters });
  assert.equal(rows.length, sessions.length);
  const byId = new Map(rows.map(row => [row.session.id, row]));
  assert.equal(byId.get('s-recent').displayName, '角色一');
  assert.equal(byId.get('s-old').displayName, '角色二');
  // 群聊用群名，而不是角色名（群聊没有单个角色）。
  assert.equal(byId.get('s-group').displayName, '读书会');
  // 角色被删的历史会话：displayName 为空，由界面兜底成「未命名角色」。
  const orphan = buildMemoryRows({ sessions: [{ id: 'x', characterId: 'gone' }], characters });
  assert.equal(orphan[0].displayName, '');
});

test('buildMemoryRows：筛选项与手机同源（全部/置顶/群聊/本地）', () => {
  const all = buildMemoryRows({ sessions, characters }).length;
  const pinned = buildMemoryRows({ sessions, characters, filterId: 'pinned' });
  const group = buildMemoryRows({ sessions, characters, filterId: 'group' });
  const local = buildMemoryRows({ sessions, characters, filterId: 'local' });
  assert.equal(all, 5);
  assert.deepEqual(pinned.map(row => row.session.id), ['s-pinned']);
  assert.deepEqual(group.map(row => row.session.id), ['s-group']);
  assert.deepEqual(local.map(row => row.session.id), ['s-local']);
  // 未知筛选 id 按「全部」处理（与 filterSessionsForMemory 同口径）。
  assert.equal(buildMemoryRows({ sessions, characters, filterId: 'nope' }).length, 5);
});

test('sessionMatchesQuery：标题/预览/群名/角色名都参与，大小写不敏感', () => {
  const recent = sessions[1];
  const character = characters[0];
  assert.equal(sessionMatchesQuery(recent, character, ''), true);
  assert.equal(sessionMatchesQuery(recent, character, '   '), true);
  assert.equal(sessionMatchesQuery(recent, character, '最近'), true);
  assert.equal(sessionMatchesQuery(recent, character, 'HELLO'), true);
  assert.equal(sessionMatchesQuery(recent, character, '角色一'), true);
  assert.equal(sessionMatchesQuery(recent, character, 'zzz'), false);
  assert.equal(sessionMatchesQuery(null, character, 'x'), false);
  // 群聊：群名参与匹配。
  assert.equal(sessionMatchesQuery(sessions[3], null, '读书'), true);
});

test('buildMemoryRows：搜索与筛选叠加，空结果不抛', () => {
  const rows = buildMemoryRows({ sessions, characters, filterId: 'local', query: '本地' });
  assert.deepEqual(rows.map(row => row.session.id), ['s-local']);
  assert.deepEqual(buildMemoryRows({ sessions, characters, query: 'zzz' }), []);
  assert.deepEqual(buildMemoryRows({ sessions: null, characters: null }), []);
});

test('groupMemoryRows：置顶独立成组，其余按 7 天分档；组内保持原顺序', () => {
  const rows = buildMemoryRows({ sessions, characters });
  const groups = groupMemoryRows(rows, NOW);
  assert.deepEqual(groups.map(group => group.id), ['pinned', 'recent', 'older']);
  assert.deepEqual(groups[0].rows.map(row => row.session.id), ['s-pinned']);
  // 最近 7 天：recent(2d)、group(1d)、local(3d)——按原数组顺序，不重排。
  assert.deepEqual(groups[1].rows.map(row => row.session.id), ['s-recent', 's-group', 's-local']);
  assert.deepEqual(groups[2].rows.map(row => row.session.id), ['s-old']);
  // 组内的 row 必须带回 character，否则界面拿不到角色名。
  assert.equal(groups[1].rows[0].character.id, 'c1');
  assert.equal(groups[1].count, 3);
});

test('flattenMemoryGroups：折叠的组只出组头，展开才出行', () => {
  const groups = groupMemoryRows(buildMemoryRows({ sessions, characters }), NOW);
  const collapsed = flattenMemoryGroups(groups, new Set());
  assert.equal(collapsed.filter(item => item.kind === 'header').length, 3);
  assert.equal(collapsed.filter(item => item.kind === 'session').length, 0);

  const expanded = flattenMemoryGroups(groups, new Set(['pinned', 'recent']));
  const rows = expanded.filter(item => item.kind === 'session');
  assert.equal(rows.length, 4, '置顶 1 + 最近 3');
  // 每个 session 项都带 row（含 character/displayName）。
  assert.ok(rows.every(item => item.row && item.row.session));
});

test('selectableSessionIds 就是渲染集：全选不会删到看不见的会话', () => {
  // 这是数据安全约束：筛选/搜索后，全选只应覆盖当前可见行。
  const filtered = buildMemoryRows({ sessions, characters, filterId: 'pinned' });
  assert.deepEqual(selectableSessionIds(filtered), ['s-pinned']);
  const searched = buildMemoryRows({ sessions, characters, query: '旧话题' });
  assert.deepEqual(selectableSessionIds(searched), ['s-old']);
  assert.deepEqual(selectableSessionIds(null), []);
});

test('memoryFilterOptions：桌面不提供「屏幕对话」（Android 专属能力）', () => {
  const ids = memoryFilterOptions().map(item => item.id);
  assert.deepEqual(ids, ['all', 'pinned', 'group', 'local']);
  assert.equal(ids.includes('screenwatch'), false);
});