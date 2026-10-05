// 记忆分档：置顶单独成组，其余按「最近 7 天 / 更早」两档划分。纯函数，便于单测与 UI 复用。
// 历史版本曾按 最近/一天前/一周前/一个月前/半年前/一年前 分 6 档——会话量级是个位数到
// 几十时，组头比会话还多，纵向空间全被标题吃掉（2026-10-06 指令书 Phase 2 收敛为 3 组）。
// 分组展开态只活在内存（不持久化），换档位 id 无需兼容旧展开状态。

export const DAY_MS = 24 * 60 * 60 * 1000;

export const PINNED_GROUP_ID = 'pinned';

// maxAge 为开区间上界：age < maxAge 落入该档；最后一档不设上界。
export const MEMORY_BUCKETS = [
  { id: 'recent', label: '最近 7 天', maxAge: 7 * DAY_MS },
  { id: 'older', label: '更早' },
];

// 列表筛选 chips（记忆页头部下方）：全部 / 置顶 / 群聊。
// 「本地」chip 依赖会话的 modelKind 字段（Phase 3 落盘），由界面按数据有无条件追加。
export const MEMORY_FILTERS = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'pinned', label: '置顶' },
  { id: 'group', label: '群聊' },
]);

export function filterSessionsForMemory(sessions, filterId) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (filterId === 'pinned') return list.filter(item => item && item.pinned === true);
  if (filterId === 'group') return list.filter(item => item && item.type === 'group');
  if (filterId === 'local') return list.filter(item => item && item.modelKind === 'local');
  return list;
}

export function bucketIdForTimestamp(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  const age = Number.isFinite(value) && value > 0
    ? Math.max(0, now - value)
    : Number.POSITIVE_INFINITY;
  for (const bucket of MEMORY_BUCKETS) {
    if (bucket.maxAge === undefined || age < bucket.maxAge) return bucket.id;
  }
  return MEMORY_BUCKETS[MEMORY_BUCKETS.length - 1].id;
}

// 置顶优先，其余按档位从新到旧；空组不返回，避免出现只有标题没有内容的分组。
export function groupSessionsByAge(sessions, now = Date.now()) {
  const list = Array.isArray(sessions) ? sessions.filter(item => item && item.id) : [];
  const groups = [];
  const pinned = list.filter(item => item.pinned === true);
  if (pinned.length > 0) {
    groups.push({ id: PINNED_GROUP_ID, label: '置顶', sessions: pinned });
  }
  const rest = list.filter(item => item.pinned !== true);
  MEMORY_BUCKETS.forEach(bucket => {
    const items = rest.filter(item => bucketIdForTimestamp(item.updatedAt, now) === bucket.id);
    if (items.length > 0) groups.push({ id: bucket.id, label: bucket.label, sessions: items });
  });
  return groups;
}

// 会话行的徽章列表（纯函数，便于单测）：克隆副本 badge；置顶星由行组件按
// pinned 单独渲染（它是图标不是文字 badge），这里不重复。
export function buildSessionBadges(session) {
  const badges = [];
  if (session && session.clonedFrom) badges.push({ text: '副本' });
  return badges;
}

// 扁平化成可交给 FlatList 的列表：每组一个头，展开时才插入该组的会话行。
export function buildMemoryListData(groups, expandedIds) {
  const expanded = expandedIds instanceof Set ? expandedIds : new Set(expandedIds || []);
  const data = [];
  (Array.isArray(groups) ? groups : []).forEach(group => {
    data.push({
      kind: 'header',
      id: `header:${group.id}`,
      groupId: group.id,
      label: group.label,
      count: group.sessions.length,
    });
    if (expanded.has(group.id)) {
      group.sessions.forEach(session => {
        data.push({ kind: 'session', id: `session:${session.id}`, session });
      });
    }
  });
  return data;
}
