// 记忆总结的公共常量。放在无依赖的独立模块，供 prompt 层（lorebook）/存储层（归属对账）
// 判定记忆条目与作用域，避免从 memorySummary 反向引入网络/存储依赖。
export const MEMORY_SUMMARY_PREFIX = '记忆总结';
// 记忆作用域阈值：某角色的单聊会话数达到它，记忆一律按会话级隔离（不再读写角色卡）。
// 单会话时世界书写入等价于「本会话记忆」，故保留以兼容既有数据。
export const MEMORY_SCOPE_THRESHOLD = 2;

// 长记忆（总结后的）默认保留上限：最多保存/注入多少条，超出淘汰最旧的。
export const DEFAULT_MEMORY_MAX_ENTRIES = 100;

// 只保留最近 maxEntries 条（按数组顺序，末尾最新）；上限非法/<=0 时原样返回。
export function capMemoryEntries(entries, maxEntries) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Number(maxEntries);
  if (!Number.isFinite(limit) || limit <= 0) return list;
  return list.length > limit ? list.slice(list.length - limit) : list;
}
