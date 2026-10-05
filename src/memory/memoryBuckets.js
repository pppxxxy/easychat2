// 记忆分档：按会话最后更新时间把历史对话分成「最近 / 一天前 / 一周前 /
// 一个月前 / 半年前 / 一年前」，置顶单独成组。纯函数，便于单测与 UI 复用。

export const DAY_MS = 24 * 60 * 60 * 1000;

export const PINNED_GROUP_ID = 'pinned';

// maxAge 为开区间上界：age < maxAge 落入该档；最后一档不设上界（一年前及以上）。
// label 保留给既有测试/调试用中文基准文案；UI 渲染一律走 labelKey + t()。
export const MEMORY_BUCKETS = [
  { id: 'recent', label: '最近', labelKey: 'memory.bucket.recent', maxAge: 1 * DAY_MS },
  { id: 'day', label: '一天前', labelKey: 'memory.bucket.day', maxAge: 7 * DAY_MS },
  { id: 'week', label: '一周前', labelKey: 'memory.bucket.week', maxAge: 30 * DAY_MS },
  { id: 'month', label: '一个月前', labelKey: 'memory.bucket.month', maxAge: 180 * DAY_MS },
  { id: 'halfYear', label: '半年前', labelKey: 'memory.bucket.halfYear', maxAge: 365 * DAY_MS },
  { id: 'year', label: '一年前', labelKey: 'memory.bucket.year' },
];

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
    groups.push({ id: PINNED_GROUP_ID, label: '置顶', labelKey: 'memory.bucket.pinned', sessions: pinned });
  }
  const rest = list.filter(item => item.pinned !== true);
  MEMORY_BUCKETS.forEach(bucket => {
    const items = rest.filter(item => bucketIdForTimestamp(item.updatedAt, now) === bucket.id);
    if (items.length > 0) groups.push({ id: bucket.id, label: bucket.label, labelKey: bucket.labelKey, sessions: items });
  });
  return groups;
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
      labelKey: group.labelKey,
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
