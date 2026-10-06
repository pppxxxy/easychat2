import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

import {
  bucketIdForTimestamp,
  buildMemoryListData,
  buildSessionBadges,
  DAY_MS,
  filterSessionsForMemory,
  groupSessionsByAge,
  hasLocalSessions,
  LOCAL_FILTER,
  MEMORY_BUCKETS,
  MEMORY_FILTERS,
  PINNED_GROUP_ID,
} from '../src/memory/memoryBuckets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'MemoryScreen.js'), 'utf8');
const SEARCH_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'SearchScreen.js'), 'utf8');
const SWITCHER_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'SwitcherModal.js'), 'utf8');

const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime();

function session(id, ageDays, extra = {}) {
  return { id, updatedAt: NOW - ageDays * DAY_MS, ...extra };
}

test('时间档边界：最近 7 天 / 更早', () => {
  assert.equal(bucketIdForTimestamp(NOW, NOW), 'recent');
  assert.equal(bucketIdForTimestamp(NOW - 0.5 * DAY_MS, NOW), 'recent');
  assert.equal(bucketIdForTimestamp(NOW - 6.9 * DAY_MS, NOW), 'recent');
  assert.equal(bucketIdForTimestamp(NOW - 7 * DAY_MS, NOW), 'older');
  assert.equal(bucketIdForTimestamp(NOW - 30 * DAY_MS, NOW), 'older');
  assert.equal(bucketIdForTimestamp(NOW - 365 * DAY_MS, NOW), 'older');
  // 无时间戳的旧会话落入「更早」，而不是被当成“最近”
  assert.equal(bucketIdForTimestamp(0, NOW), 'older');
});

test('分组：置顶单独成组，其余按时间从新到旧，空组不出现', () => {
  const groups = groupSessionsByAge([
    session('recent-1', 0.2),
    session('recent-2', 3),
    session('old-1', 30),
    session('old-2', 500),
    session('pin-1', 400, { pinned: true }),
    session('pin-2', 2, { pinned: true }),
  ], NOW);

  assert.deepEqual(groups.map(group => group.id), [PINNED_GROUP_ID, 'recent', 'older']);
  assert.deepEqual(groups[0].sessions.map(item => item.id), ['pin-1', 'pin-2']);
  assert.deepEqual(groups[1].sessions.map(item => item.id), ['recent-1', 'recent-2']);
  assert.deepEqual(groups[2].sessions.map(item => item.id), ['old-1', 'old-2']);
});

test('空输入与非法项安全返回', () => {
  assert.deepEqual(groupSessionsByAge(null, NOW), []);
  assert.deepEqual(groupSessionsByAge([{ updatedAt: NOW }], NOW), []);
});

test('扁平列表：折叠只出头，展开才插入会话行', () => {
  const groups = groupSessionsByAge([
    session('a', 0.2),
    session('b', 30),
  ], NOW);

  const collapsed = buildMemoryListData(groups, new Set());
  assert.deepEqual(collapsed.map(item => item.kind), ['header', 'header']);
  assert.equal(collapsed[0].count, 1);
  assert.equal(collapsed[0].label, '最近 7 天');

  const expanded = buildMemoryListData(groups, new Set(['recent']));
  assert.deepEqual(expanded.map(item => item.kind), ['header', 'session', 'header']);
  assert.equal(expanded[1].session.id, 'a');
  assert.equal(expanded[2].groupId, 'older');
});

test('档位定义完整：3 组（置顶 + 两档时间）', () => {
  assert.deepEqual(MEMORY_BUCKETS.map(item => item.id), ['recent', 'older']);
  assert.equal(MEMORY_BUCKETS[MEMORY_BUCKETS.length - 1].maxAge, undefined);
});

test('筛选 chips：置顶/群聊/本地 按谓词过滤，全部原样返回', () => {
  const sessions = [
    { id: 'a', pinned: true },
    { id: 'b', type: 'group' },
    { id: 'c', modelKind: 'local' },
    { id: 'd' },
    null,
  ];
  assert.deepEqual(filterSessionsForMemory(sessions, 'all').filter(Boolean).map(s => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterSessionsForMemory(sessions, 'pinned').map(s => s.id), ['a']);
  assert.deepEqual(filterSessionsForMemory(sessions, 'group').map(s => s.id), ['b']);
  assert.deepEqual(filterSessionsForMemory(sessions, 'local').map(s => s.id), ['c']);
  assert.deepEqual(filterSessionsForMemory(null, 'pinned'), []);
  assert.deepEqual(MEMORY_FILTERS.map(item => item.id), ['all', 'pinned', 'group']);
});

test('记忆界面接入分组折叠与展开全部', () => {
  assert.ok(SCREEN_SOURCE.includes("from './memory/memoryBuckets.js'"));
  assert.ok(SCREEN_SOURCE.includes('groupSessionsByAge'));
  assert.ok(SCREEN_SOURCE.includes('buildMemoryListData'));
  assert.ok(SCREEN_SOURCE.includes('expandedGroups'));
  assert.ok(SCREEN_SOURCE.includes('toggleGroup'));
  assert.ok(SCREEN_SOURCE.includes('toggleAllGroups'));
  assert.ok(SCREEN_SOURCE.includes("t('memory.expandAll')"), '应引用展开全部的 i18n 键');
  assert.equal(zhCN['memory.expandAll'], '展开全部', '语言包中文值正确');
  assert.ok(SCREEN_SOURCE.includes("t('memory.collapseAll')"), '应引用折叠全部的 i18n 键');
  assert.equal(zhCN['memory.collapseAll'], '折叠全部', '语言包中文值正确');
  // 编辑模式强制展开，保证折叠里的会话可被点选
  assert.ok(SCREEN_SOURCE.includes('editing ? new Set(groups.map(group => group.id))'));
  // 首屏默认展开第一组，避免只剩标题的回归（且只自动展开一次）
  assert.ok(SCREEN_SOURCE.includes('autoExpandedRef'));
  assert.ok(SCREEN_SOURCE.includes('setExpandedGroups(new Set([groups[0].id]))'));
});

test('记忆页头部收敛：⋯ 菜单 + 筛选 chips + 吸顶组头', () => {
  // 头部 5 组元素收敛：教学/计数/展开全部进 ⋯ 菜单（MoreMenuModal 复用聊天页组件）
  assert.ok(SCREEN_SOURCE.includes("from './chat/MoreMenuModal.js'"));
  assert.ok(SCREEN_SOURCE.includes('menuItems'));
  assert.ok(!SCREEN_SOURCE.includes('TopicButton'), '教学按钮应已收进 ⋯ 菜单');
  // 注意别用裸 '段对话' 子串：删除/克隆弹窗文案里有大量「这段对话」误命中。
  assert.ok(
    !SCREEN_SOURCE.includes('${visibleSessions.length} 段对话'),
    '常驻计数文字应已移除（计数在各分组头里）'
  );
  // 筛选 chips：先筛选再分组
  assert.ok(SCREEN_SOURCE.includes('filterSessionsForMemory'));
  assert.ok(SCREEN_SOURCE.includes('MEMORY_FILTERS'));
  assert.ok(SCREEN_SOURCE.includes('memoryFilter'));
  // 吸顶组头
  assert.ok(SCREEN_SOURCE.includes('stickyHeaderIndices'));
});

test('会话行三处统一：同一 SessionRow 组件，常驻操作按钮已删', () => {
  // 三处都从同一文件导入默认导出（SessionRow）与 SessionAvatar
  for (const [label, source] of [['memory', SCREEN_SOURCE], ['search', SEARCH_SOURCE], ['switcher', SWITCHER_SOURCE]]) {
    assert.ok(source.includes('SessionAvatar'), `${label} 未接入 SessionAvatar`);
  }
  assert.ok(SCREEN_SOURCE.includes("from './memory/SessionRow.js'"));
  assert.ok(SEARCH_SOURCE.includes("from './memory/SessionRow.js'"));
  assert.ok(SWITCHER_SOURCE.includes("from '../memory/SessionRow.js'"));
  // 记忆页：长按出操作单（置顶/克隆/删除收进 Alert），不再每行常驻按钮
  assert.ok(SCREEN_SOURCE.includes('onLongPress'));
  assert.ok(SCREEN_SOURCE.includes('onRowActions'));
  // 注意别用裸 'RowAction' 子串：onRowActions 会误命中（substring 陷阱）。
  assert.ok(!SCREEN_SOURCE.includes('function RowAction'), 'RowAction 常驻按钮组件应已删除');
  assert.ok(!SCREEN_SOURCE.includes('styles.rowAction'), 'rowAction 样式引用应已清空');
  // 切换器（群聊行）有预览与时间：用的是 session 对象上的现成字段
  assert.ok(SWITCHER_SOURCE.includes('formatSessionTime'));
  assert.ok(SWITCHER_SOURCE.includes('item.preview'));
});

test('buildSessionBadges：克隆副本与本地模型 badge', () => {
  assert.deepEqual(buildSessionBadges({ clonedFrom: 'abc' }), [{ text: '副本' }]);
  assert.deepEqual(buildSessionBadges({ modelKind: 'local' }), [{ icon: 'hardware-chip-outline', text: '本地' }]);
  assert.deepEqual(
    buildSessionBadges({ clonedFrom: 'abc', modelKind: 'local' }),
    [{ text: '副本' }, { icon: 'hardware-chip-outline', text: '本地' }]
  );
  // api 与旧数据（无字段）都没有本地 badge
  assert.deepEqual(buildSessionBadges({ modelKind: 'api' }), []);
  assert.deepEqual(buildSessionBadges({}), []);
  assert.deepEqual(buildSessionBadges(null), []);
});

test('hasLocalSessions：存在本地会话才为真', () => {
  assert.equal(hasLocalSessions([{ modelKind: 'local' }]), true);
  assert.equal(hasLocalSessions([{ modelKind: 'api' }, {}]), false);
  assert.equal(hasLocalSessions(null), false);
  assert.equal(LOCAL_FILTER.id, 'local');
});
