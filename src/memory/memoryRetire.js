// 世界书记忆的归属判定（纯函数，Node 直测；只判定、不做 IO）。
//
// 「记忆总结」条目存在角色卡 worldInfo 里（comment 以前缀开头），它只在一种情形下合法：
// **该角色恰好一个单聊会话，且条目 boundary（已总结到的消息 id）属于那个会话**。
// 其余情形（0 个会话 / ≥2 个会话 / boundary 不属于唯一会话 / 内置助手）都说明条目是
// 历史残留——单会话时代写下的、删会话后留下的、或跨卡流通过来的。只要它们还是 enabled，
// 一旦会话结构回到「单会话」就会被注入，用户感知就是「记忆又串了」。
//
// 退休动作 = enabled:false + stale:true（内容保留、不再注入、用户仍可在角色卡编辑器里
// 看到并自行清理），与 invalidateHistorySummaries 的失效标记同一口径。

import { MEMORY_SCOPE_THRESHOLD, MEMORY_SUMMARY_PREFIX } from './memoryConstants.js';

// 内置助手（EasyChat2 助手）：通用工具角色，记忆被强制按会话级处理，
// 卡上的「记忆总结」永远读不到——只剩「以后被别的路径读出来」的风险。
export function isBuiltinCharacter(character) {
  return !!(character && character.builtin === true);
}

export function isWorldMemoryEntry(entry) {
  return !!(entry && String(entry.comment || '').trim().startsWith(MEMORY_SUMMARY_PREFIX));
}

// 卡上「还在生效」的记忆条目：读取侧（worldSummaryEntries）也只认这些，
// 判定与读取必须同口径，否则会漏掉真正会被注入的条目。
export function activeWorldMemoryEntries(worldInfo) {
  return (Array.isArray(worldInfo) ? worldInfo : []).filter(entry => (
    isWorldMemoryEntry(entry)
    && entry.enabled !== false
    && String(entry.content || '').trim()
  ));
}

function entryIds(list) {
  return list.map(entry => String((entry && entry.id) || '')).filter(Boolean);
}

// 返回需要退休的条目 id 列表；不需要处理时返回空数组（调用方据此跳过写盘）。
//   sessionCount：该角色当前的**单聊**会话数（群聊不计）。
//   messageIds：唯一会话的消息 id 集合；null/undefined = 无法判定（消息读不出来）→ 不动，
//     宁可下次启动再试，也不能凭猜测把合法记忆退休掉。
//   builtin：内置助手 → 卡上记忆一律退休。
export function planWorldMemoryRetire(worldInfo, { sessionCount = 0, messageIds = null, builtin = false } = {}) {
  const active = activeWorldMemoryEntries(worldInfo);
  if (active.length === 0) return [];
  if (builtin) return entryIds(active);

  const count = Number(sessionCount);
  if (!Number.isFinite(count) || count < 0) return [];
  // 0 个会话（会话被删光）或 ≥2 个（多会话隔离）：卡上记忆没有合法读者。
  if (count === 0 || count >= MEMORY_SCOPE_THRESHOLD) return entryIds(active);
  // 恰好 1 个会话：只有 boundary 属于它的条目留下（读不到消息时不动）。
  if (messageIds === null || messageIds === undefined) return [];
  const ids = messageIds instanceof Set ? messageIds : new Set(messageIds);
  return entryIds(active.filter(entry => !ids.has(String(entry.boundary || ''))));
}

// 退休后的 worldInfo（不改动其它条目）；retireIds 为空时原样返回，便于调用方判等。
export function applyWorldMemoryRetire(worldInfo, retireIds) {
  const ids = new Set((Array.isArray(retireIds) ? retireIds : []).map(id => String(id || '')));
  const list = Array.isArray(worldInfo) ? worldInfo : [];
  if (ids.size === 0) return list;
  return list.map(entry => (
    ids.has(String((entry && entry.id) || ''))
      ? { ...entry, enabled: false, stale: true }
      : entry
  ));
}
