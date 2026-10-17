import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';
import { en } from '../src/i18n/locales/en.js';

import {
  bucketIdForTimestamp,
  buildMemoryListData,
  buildSessionBadges,
  DAY_MS,
  filterSessionsForMemory,
  groupSessionsByAge,
  hasLocalSessions,
  isScreenWatchFilter,
  LOCAL_FILTER,
  mapScreenThreadsToGroupItems,
  MEMORY_BUCKETS,
  MEMORY_FILTERS,
  PINNED_GROUP_ID,
  SCREEN_WATCH_FILTER,
  screenThreadPreview,
  splitScreenThreads,
} from '../src/memory/memoryBuckets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'MemoryScreen.js'), 'utf8');
const VIEW_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'memory', 'useMemoryListView.js'), 'utf8');
const SEARCH_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'SearchScreen.js'), 'utf8');
const SWITCHER_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'SwitcherModal.js'), 'utf8');
const SESSION_ROW_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'memory', 'SessionRow.js'), 'utf8');

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

test('筛选 chips 与档位都带 labelKey，界面据此取词（英文不再漏译）', () => {
  assert.deepEqual(MEMORY_FILTERS.map(item => item.labelKey), ['memory.filter.all', 'memory.bucket.pinned', 'memory.groupChat']);
  assert.deepEqual(MEMORY_BUCKETS.map(item => item.labelKey), ['memory.bucket.recent7', 'memory.bucket.older']);
  assert.equal(LOCAL_FILTER.labelKey, 'memory.filter.local');
  assert.equal(SCREEN_WATCH_FILTER.labelKey, 'memory.filter.screenWatch');
  // 分组头也带 labelKey（置顶组 + 两个时间档）
  const groups = groupSessionsByAge([
    session('p', 1, { pinned: true }),
    session('a', 0.2),
    session('o', 30),
  ], NOW);
  assert.deepEqual(groups.map(g => g.labelKey), ['memory.bucket.pinned', 'memory.bucket.recent7', 'memory.bucket.older']);
  const data = buildMemoryListData(groups, new Set());
  assert.deepEqual(data.map(item => item.labelKey), ['memory.bucket.pinned', 'memory.bucket.recent7', 'memory.bucket.older']);
  // 界面用 t(labelKey) 取词，不再直出中文 label
  assert.ok(SCREEN_SOURCE.includes('t(chip.labelKey)'), 'chip 文案应经 t(labelKey)');
  assert.ok(SCREEN_SOURCE.includes('t(item.labelKey)'), '分组头文案应经 t(labelKey)');
  // 两种语言的词条都在（漏译会被 i18n 一致性测试兜住，这里钉住语义）
  assert.equal(zhCN['memory.filter.all'], '全部');
  assert.equal(en['memory.filter.all'], 'All');
  assert.equal(en['memory.filter.screenWatch'], 'Screen chats');
  assert.equal(en['memory.bucket.recent7'], 'Last 7 days');
  assert.equal(en['memory.bucket.older'], 'Earlier');
});

test('会话时间文案走 i18n：昨天 / M月D日 不再硬编码', () => {
  assert.ok(SESSION_ROW_SOURCE.includes("translate('memory.date.yesterday')"), '昨天应走词条');
  assert.ok(SESSION_ROW_SOURCE.includes("translate('memory.date.md'"), '月日应走词条');
  // 只否定代码形态（文件头注释里仍会提到这两个文案，不算回归）
  assert.ok(!SESSION_ROW_SOURCE.includes("return '昨天'"), '不得再硬编码昨天');
  assert.ok(!SESSION_ROW_SOURCE.includes('getMonth() + 1}月'), '不得再硬编码「M月D日」');
  assert.equal(en['memory.date.yesterday'], 'Yesterday');
  assert.equal(en['memory.date.md'], '{m}/{d}');
  // 调用方把 t 传进来（否则回落 tActive＝当前活动语言，不再固定中文基准）
  assert.ok(SCREEN_SOURCE.includes('formatSessionTime(session.updatedAt, t)'));
  assert.ok(SWITCHER_SOURCE.includes('formatSessionTime(item.updatedAt, t)'));
});

test('记忆界面接入分组折叠与展开全部', () => {
  assert.ok(SCREEN_SOURCE.includes("from './memory/memoryBuckets.js'"));
  assert.ok(VIEW_SOURCE.includes('groupSessionsByAge'));
  assert.ok(VIEW_SOURCE.includes('buildMemoryListData'));
  assert.ok(VIEW_SOURCE.includes('expandedGroups'));
  assert.ok(VIEW_SOURCE.includes('toggleGroup'));
  assert.ok(VIEW_SOURCE.includes('toggleAllGroups'));
  assert.ok(SCREEN_SOURCE.includes("t('memory.expandAll')"), '应引用展开全部的 i18n 键');
  assert.equal(zhCN['memory.expandAll'], '展开全部', '语言包中文值正确');
  assert.ok(SCREEN_SOURCE.includes("t('memory.collapseAll')"), '应引用折叠全部的 i18n 键');
  assert.equal(zhCN['memory.collapseAll'], '折叠全部', '语言包中文值正确');
  // 编辑模式强制展开，保证折叠里的会话可被点选
  assert.ok(VIEW_SOURCE.includes('editing ? new Set(groups.map(group => group.id))'));
  // 首屏默认展开第一组，避免只剩标题的回归（且只自动展开一次）
  assert.ok(VIEW_SOURCE.includes('autoExpandedRef'));
  assert.ok(VIEW_SOURCE.includes('setExpandedGroups(new Set([groups[0].id]))'));
  // 回归：分组结构整体换掉后（如「全部置顶」后只剩「置顶」组）旧展开 id 失效，
  // 必须补展开，否则列表只剩折叠组头、看起来像会话丢失。
  assert.ok(
    VIEW_SOURCE.includes('groups.some(group => current.has(group.id)) ? current : new Set([groups[0].id])'),
    '分组结构换掉后应补展开'
  );
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
  assert.ok(VIEW_SOURCE.includes('filterSessionsForMemory'));
  assert.ok(VIEW_SOURCE.includes('MEMORY_FILTERS'));
  assert.ok(SCREEN_SOURCE.includes('memoryFilter'));
  // 吸顶组头
  assert.ok(VIEW_SOURCE.includes('stickyHeaderIndices'));
  // 回归：Android 上 FlatList 同渲染既换 data 又换 stickyHeaderIndices 会原生崩溃
  // （facebook/react-native#25157），因此吸顶只在 iOS 启用。
  assert.ok(
    VIEW_SOURCE.includes("() => (Platform.OS === 'ios'"),
    '吸顶组头应仅在 iOS 启用'
  );
  assert.ok(VIEW_SOURCE.includes('react-native#25157'), '应注明崩溃来源便于回归追溯');
});

test('回归：空 preview 兜底读的依赖按「待补 id 序列」收窄，不得依赖 sessions 数组本身', () => {
  // 失效模式：sessions 每次刷新（落盘 / 标记已读 / 60 秒调度器）都是**新数组**，
  // 若 effect 依赖数组本身，这批会话的消息体就会被**整批重新串行读一遍**
  // （每条一次 getItem + JSON.parse，最坏几 MB）——列表内容没变，做的事全白做。
  // 现在依赖是 missingPreviewKey（id 序列拼接），id 集合不变就不重跑。
  assert.ok(VIEW_SOURCE.includes('const missingPreviewKey'), '必须按待补 id 序列做依赖键');
  // 精确定位到「兜底读」这个 effect 自己的依赖数组：从 missingPreviewKey 声明往后
  // 第一处 `}, [` 就是它的依赖列表（别用 includes 全文搜，memoryChips 也以
  // [visibleSessions] 结尾，会误判成没改）。
  const keyStart = VIEW_SOURCE.indexOf('const missingPreviewKey');
  const depStart = VIEW_SOURCE.indexOf('}, [', keyStart);
  const depEnd = VIEW_SOURCE.indexOf(');', depStart);
  assert.equal(
    VIEW_SOURCE.slice(depStart, depEnd + 2),
    '}, [missingPreviewKey]);',
    '兜底读 effect 的依赖必须是 missingPreviewKey，而不是 visibleSessions 数组'
  );
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
  // 回归：Android Alert 默认 cancelable=false，三个按钮占满后无法退出；
  // 必须显式传 cancelable:true 才能点外部/返回键关闭。
  assert.ok(SCREEN_SOURCE.includes('{ cancelable: true }'), '长按操作单应可点外部关闭');
  // 注意别用裸 'RowAction' 子串：onRowActions 会误命中（substring 陷阱）。
  assert.ok(!SCREEN_SOURCE.includes('function RowAction'), 'RowAction 常驻按钮组件应已删除');
  assert.ok(!SCREEN_SOURCE.includes('styles.rowAction'), 'rowAction 样式引用应已清空');
  // 切换器（群聊行）有预览与时间：用的是 session 对象上的现成字段
  assert.ok(SWITCHER_SOURCE.includes('formatSessionTime'));
  assert.ok(SWITCHER_SOURCE.includes('item.preview'));
});

test('buildSessionBadges：克隆副本与本地模型 badge', () => {
  // text 是中文兜底，labelKey 供界面取词（MemoryScreen 用 t(labelKey) 覆盖 text）。
  assert.deepEqual(buildSessionBadges({ clonedFrom: 'abc' }), [{ text: '副本', labelKey: 'memory.cloneBadge' }]);
  assert.deepEqual(buildSessionBadges({ modelKind: 'local' }), [{ icon: 'hardware-chip-outline', text: '本地', labelKey: 'memory.filter.local' }]);
  assert.deepEqual(
    buildSessionBadges({ clonedFrom: 'abc', modelKind: 'local' }),
    [
      { text: '副本', labelKey: 'memory.cloneBadge' },
      { icon: 'hardware-chip-outline', text: '本地', labelKey: 'memory.filter.local' },
    ]
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

test('屏幕对话 chip：看屏幕线程按时间分档，空线程单独聚合', () => {
  assert.equal(SCREEN_WATCH_FILTER.id, 'screenwatch');
  assert.equal(isScreenWatchFilter('screenwatch'), true);
  assert.equal(isScreenWatchFilter('all'), false);

  const threads = [
    { id: 't-recent', updatedAt: NOW - 0.5 * DAY_MS, entries: [{ id: 'e1', text: '刚聊过' }] },
    { id: 't-old', updatedAt: NOW - 30 * DAY_MS, entries: [{ id: 'e2', text: '很久以前' }] },
    { id: 't-empty', updatedAt: NOW, entries: [] },
    null,
  ];
  const { active, empty } = splitScreenThreads(threads);
  assert.deepEqual(active.map(t => t.id), ['t-recent', 't-old']);
  assert.deepEqual(empty.map(t => t.id), ['t-empty']);

  // 非空线程借会话分档：最近 7 天 / 更早；空线程不进入分组条目。
  const groups = groupSessionsByAge(mapScreenThreadsToGroupItems(threads), NOW);
  assert.deepEqual(groups.map(g => g.id), ['recent', 'older']);
  assert.deepEqual(groups[0].sessions.map(item => item.id), ['t-recent']);
  assert.equal(groups[0].sessions[0].pinned, false);
  assert.equal(groups[0].sessions[0].thread.id, 't-recent');
  assert.deepEqual(groups[1].sessions.map(item => item.id), ['t-old']);

  // 预览取最后一条 entry 文本，空线程/无 entry 返回空串。
  assert.equal(screenThreadPreview(threads[0]), '刚聊过');
  assert.equal(screenThreadPreview({ entries: [{ text: 'a' }, { text: 'b' }] }), 'b');
  assert.equal(screenThreadPreview({ entries: [] }), '');
  assert.equal(screenThreadPreview(null), '');

  assert.deepEqual(splitScreenThreads(null), { active: [], empty: [] });
  assert.deepEqual(mapScreenThreadsToGroupItems(null), []);
});

test('筛选 chips 行不被纵向压缩：chipScroll 必须同时禁生长与禁收缩，FlatList 接管剩余空间', () => {
  // RN 横向 ScrollView 基础样式 baseHorizontal 自带 flexShrink:1：
  // 只写 flexGrow:0 挡得住拉伸挡不住收缩，纵向空间不足时胶囊被压成细条
  // （2026-10-06 用户截图证实）。 flexGrow 与 flexShrink 必须成对显式声明。
  const line = SCREEN_SOURCE.slice(
    SCREEN_SOURCE.indexOf('chipScroll: {'),
    SCREEN_SOURCE.indexOf('}', SCREEN_SOURCE.indexOf('chipScroll: {'))
  );
  assert.ok(line.includes('flexGrow: 0'), 'chipScroll 应禁拉伸');
  assert.ok(line.includes('flexShrink: 0'), 'chipScroll 必须显式 flexShrink:0（RN 基础样式默认 1）');
  // FlatList 显式接管剩余空间，溢出压力不再外溢到非列表元素
  const listAt = SCREEN_SOURCE.indexOf('<FlatList');
  assert.ok(SCREEN_SOURCE.slice(listAt, listAt + 120).includes('style={styles.list}'), 'FlatList 应带 style={styles.list}');
  assert.ok(SCREEN_SOURCE.includes('list: { flex: 1 }'), '应有 list: { flex: 1 } 样式');
});
