// 记忆总结的公共常量。放在无依赖的独立模块，供 prompt 层（lorebook）判定并剔除
// 记忆条目，避免从 memorySummary 反向引入网络/存储依赖。
export const MEMORY_SUMMARY_PREFIX = '记忆总结';
