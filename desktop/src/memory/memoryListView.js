// 桌面「记忆」页的列表视图模型（纯函数，Node 直测）。
//
// 参照 Android MemoryScreen 的口径，但桌面版有两个前提不同，必须显式处理：
//   1. 手机按「当前角色」的会话列表进入记忆页；桌面顶栏是全局入口，因此这里跨角色
//      汇总全部会话，并把角色名一起带出来（否则用户分不清这是谁的对话）；
//   2. 手机有「看屏幕」线程与孤儿恢复（Android 专属能力），桌面没有，故不接入。
//
// 复用共享层 memoryBuckets：筛选项 id、分档规则、置顶组、列表扁平化都同源，
// 避免桌面/手机对「最近 7 天」这类概念各写一套。
import {
  buildMemoryListData,
  filterSessionsForMemory,
  groupSessionsByAge,
} from '../../../src/memory/memoryBuckets.js';

const MEMORY_FILTERS = [
  { id: 'all', labelKey: 'memory.filter.all' },
  { id: 'pinned', labelKey: 'memory.bucket.pinned' },
  { id: 'group', labelKey: 'memory.groupChat' },
  { id: 'local', labelKey: 'memory.filter.local' },
];

// 会话搜索：标题 / 预览 / 角色名都参与，大小写与首尾空白不敏感。
export function sessionMatchesQuery(session, character, query) {
  const needle = String(query === undefined || query === null ? '' : query).trim().toLowerCase();
  if (!needle) return true;
  if (!session) return false;
  const haystack = [
    String(session.title || ''),
    String(session.preview || ''),
    String(session.name || ''),
    String((character && character.name) || ''),
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
}

// 桌面用：跨角色汇总 + 角色名挂到行上 + 筛选 + 搜索。
// 返回的每个条目是 { session, character, displayName }，displayName 为空时由界面兜底。
export function buildMemoryRows({ sessions, characters, filterId = 'all', query = '' } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const characterList = Array.isArray(characters) ? characters : [];
  const characterMap = new Map();
  characterList.forEach(character => {
    if (character && character.id) characterMap.set(character.id, character);
  });

  const filtered = filterSessionsForMemory(list, filterId);
  const rows = [];
  for (const session of filtered) {
    if (!session || !session.id) continue;
    const character = characterMap.get(String(session.characterId || '')) || null;
    if (!sessionMatchesQuery(session, character, query)) continue;
    const displayName = session.type === 'group'
      ? String(session.name || '').trim()
      : String((character && character.name) || '').trim();
    rows.push({ session, character, displayName });
  }
  return rows;
}

// 分组：直接复用共享的分档（置顶 / 最近 7 天 / 更早）。
// 这里不重排——groupSessionsByAge 已按「置顶优先、组内原顺序」处理。
export function groupMemoryRows(rows, now = Date.now()) {
  const source = Array.isArray(rows) ? rows : [];
  const bySession = new Map();
  source.forEach(row => {
    if (row && row.session && row.session.id) bySession.set(row.session.id, row);
  });
  const groups = groupSessionsByAge(source.map(row => row.session), now);
  return groups.map(group => ({
    id: group.id,
    label: group.label,
    labelKey: group.labelKey,
    count: group.sessions.length,
    rows: group.sessions.map(session => bySession.get(session.id)).filter(Boolean),
  }));
}

// 扁平化成「组头 + 行」的序列，供渲染层直接遍历（桌面不用 FlatList）。
export function flattenMemoryGroups(groups, expandedIds) {
  const data = buildMemoryListData(
    (Array.isArray(groups) ? groups : []).map(group => ({
      ...group,
      sessions: group.rows.map(row => row.session),
    })),
    expandedIds
  );
  const rowMap = new Map();
  (Array.isArray(groups) ? groups : []).forEach(group => {
    group.rows.forEach(row => rowMap.set(`session:${row.session.id}`, row));
  });
  return data.map(item => (item.kind === 'header' ? item : { ...item, row: rowMap.get(item.id) || null }));
}

// 筛选项清单（桌面不提供「屏幕对话」——那是 Android 专属能力）。
export function memoryFilterOptions() {
  return MEMORY_FILTERS;
}

// 全选口径必须与渲染集一致（筛选 + 搜索之后），否则会把看不见的会话删掉。
export function selectableSessionIds(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => String((row && row.session && row.session.id) || ''))
    .filter(Boolean);
}
