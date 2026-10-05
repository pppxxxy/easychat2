// 记忆总结的公共常量。放在无依赖的独立模块，供 prompt 层（lorebook）/存储层（归属对账）
// 判定记忆条目与作用域，避免从 memorySummary 反向引入网络/存储依赖。
export const MEMORY_SUMMARY_PREFIX = '记忆总结';
// 记忆作用域阈值：某角色的单聊会话数达到它，记忆一律按会话级隔离（不再读写角色卡）。
// 单会话时世界书写入等价于「本会话记忆」，故保留以兼容既有数据。
export const MEMORY_SCOPE_THRESHOLD = 2;
