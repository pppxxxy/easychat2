// 记忆体检：把「记忆到底存在哪、有多少、有没有不合法的残留」算成一份结构化报告。
// 纯函数（只吃数据、不做 IO），弹层负责读盘与展示；判定口径与 memoryRetire 完全一致，
// 避免「体检说正常、对账在悄悄改」这种两套标准。
//
// 为什么要体检入口：记忆分两层存——会话级摘要（按 sessionId）与角色卡上的
// 「记忆总结」条目（世界书，单会话角色才有）。普通用户看不到自己在哪一层留了东西，
// 出问题（串记忆）时也无从自查。这里把两层都摊开：多少会话有摘要、卡上还有多少
// 生效条目、哪些条目已经不可能被读到（内置助手 / 多会话 / 无会话承载）。

import { MEMORY_SCOPE_THRESHOLD } from './memoryConstants.js';
import { activeWorldMemoryEntries, isBuiltinCharacter, isWorldMemoryEntry } from './memoryRetire.js';

// 该角色的单聊会话（群聊不计；群聊没有「角色记忆」这回事）。
export function singleChatSessionsOf(sessions, characterId) {
  const id = String(characterId || '');
  if (!id) return [];
  return (Array.isArray(sessions) ? sessions : []).filter(session => (
    session && String(session.type || 'single') !== 'group' && String(session.characterId || '') === id
  ));
}

// 卡上一条生效记忆的「问题类型」：'' = 合法（跟随唯一会话）。
// builtin  = 内置助手卡上的记忆永远读不到（它被强制会话级）；
// multi    = 该角色有 ≥2 个单聊会话，卡上记忆已被隔离（读不到，也不该再被读到）；
// orphan   = 该角色一个会话都没有，记忆没有承载者。
export function worldMemoryIssue(character, sessionCount) {
  if (isBuiltinCharacter(character)) return 'builtin';
  const count = Number(sessionCount);
  if (!Number.isFinite(count)) return '';
  if (count >= MEMORY_SCOPE_THRESHOLD) return 'multi';
  if (count === 0) return 'orphan';
  return '';
}

// 体检报告。
//   summaryStats：{ status, totalSessions, singleSessions, groupSessions, withSummaries, summariesCount }
//   —— 由弹层逐会话读摘要后传入（纯函数不读盘）；缺省视为未统计。
export function buildMemoryCheckup({ sessions = [], characters = [], summaryStats = null } = {}) {
  const sessionList = Array.isArray(sessions) ? sessions : [];
  const singleSessions = sessionList.filter(session => session && String(session.type || 'single') !== 'group');
  const groupSessions = sessionList.filter(session => session && String(session.type || 'single') === 'group');

  const worldEntries = [];
  (Array.isArray(characters) ? characters : []).forEach(character => {
    const worldInfo = Array.isArray(character && character.worldInfo) ? character.worldInfo : [];
    const active = activeWorldMemoryEntries(worldInfo);
    const retired = worldInfo.filter(entry => isWorldMemoryEntry(entry) && entry.enabled === false).length;
    if (active.length === 0 && retired === 0) return;
    const sessionCount = singleChatSessionsOf(sessionList, character && character.id).length;
    worldEntries.push({
      characterId: String((character && character.id) || ''),
      characterName: String((character && character.name) || '').trim(),
      builtin: isBuiltinCharacter(character),
      activeCount: active.length,
      retiredCount: retired,
      sessionCount,
      issue: active.length > 0 ? worldMemoryIssue(character, sessionCount) : '',
    });
  });
  // 有问题的排前面（用户最关心的先看到），其次按生效条数降序。
  worldEntries.sort((left, right) => {
    if (!!left.issue !== !!right.issue) return left.issue ? -1 : 1;
    return right.activeCount - left.activeCount;
  });

  const issues = worldEntries.filter(item => item.issue);
  const worldActiveTotal = worldEntries.reduce((sum, item) => sum + item.activeCount, 0);
  const worldRetiredTotal = worldEntries.reduce((sum, item) => sum + item.retiredCount, 0);

  return {
    totalSessions: sessionList.length,
    singleSessions: singleSessions.length,
    groupSessions: groupSessions.length,
    worldEntries,
    issues,
    worldActiveTotal,
    worldRetiredTotal,
    healthy: issues.length === 0,
    summaryStats: summaryStats && typeof summaryStats === 'object' ? summaryStats : null,
  };
}
