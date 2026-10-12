// 记忆体检：把「记忆到底存在哪、有多少、有没有不合法的残留」算成一份结构化报告。
// 纯函数（只吃数据、不做 IO），弹层负责读盘与展示。
//
// 判定口径与启动对账一致（memoryRetire.planWorldMemoryRetire）：一条卡上记忆合法的
// 唯一情形是「该角色恰好 1 个单聊会话，且条目 boundary 属于那个会话」。会话数这一半
// 由 worldMemoryIssue 自己算；boundary 这一半需要消息 id 集合，由弹层读盘后传进来
// （messageIdsByCharacter）——本模块不读盘，但**必须**把这半个条件判掉，否则体检会对
// 「boundary 指向已删/其它会话消息」的条目显示绿勾，而 memoryRetire.js:53-55 在下次
// 启动时把它 enabled:false：正是本文件要避免的「体检说正常、对账在悄悄改」。
// 读不出消息（null）时判 'unknown'，绝不把未知当健康（先例：planWorldMemoryRetire
// 对 messageIds=null 的「不动」语义，storage/memoryOwnership.js:40-77 的读盘方式）。
//
// 为什么要体检入口：记忆分两层存——会话级摘要（按 sessionId）与角色卡上的
// 「记忆总结」条目（世界书，单会话角色才有）。普通用户看不到自己在哪一层留了东西，
// 出问题（串记忆）时也无从自查。这里把两层都摊开：多少会话有摘要、卡上还有多少
// 生效条目、哪些条目已经不可能被读到（内置助手 / 多会话 / 无会话承载 / boundary 不属该会话）。

import { MEMORY_SCOPE_THRESHOLD } from './memoryConstants.js';
import { activeWorldMemoryEntries, isBuiltinCharacter, isWorldMemoryEntry } from './memoryRetire.js';

// 该角色的单聊会话（群聊不计；群聊没有「角色记忆」这回事）。
// 实现只有这一份：storage/memoryOwnership.js:24 已改为
// `import { singleChatSessionsOf } from '../memory/checkup.js'`（那边 :32-37 记了理由），
// 因此不存在「体检与对账两套标准」的漂移面（无循环：checkup 只依赖 memory/ 内的纯函数，
// 不反向依赖 storage）。tests/memoryCheckup.test.mjs:153-157 的守卫据此直接放行，
// tests/memoryOwnership.test.mjs:294-319 另有一条行为测试盯着对账真的走这一个实现。
export function singleChatSessionsOf(sessions, characterId) {
  const id = String(characterId || '');
  if (!id) return [];
  return (Array.isArray(sessions) ? sessions : []).filter(session => (
    session && String(session.type || 'single') !== 'group' && String(session.characterId || '') === id
  ));
}

// 卡上一条生效记忆的「问题类型」：'' = 合法（跟随唯一会话且 boundary 属于它）。
// builtin  = 内置助手卡上的记忆永远读不到（它被强制会话级）；
// multi    = 该角色有 ≥2 个单聊会话，卡上记忆已被隔离（读不到，也不该再被读到）；
// orphan   = 该角色一个会话都没有，记忆没有承载者；
// boundary = 只有 1 个会话，但条目 boundary 不属于它（消息被删/跨卡流通的残留）；
// unknown  = 只有 1 个会话，但消息读不出来，无法判定 boundary —— 不是「正常」。
export function worldMemoryIssue(character, sessionCount, messageIds = null) {
  if (isBuiltinCharacter(character)) return 'builtin';
  const count = Number(sessionCount);
  if (!Number.isFinite(count)) return '';
  if (count >= MEMORY_SCOPE_THRESHOLD) return 'multi';
  if (count === 0) return 'orphan';
  // 恰好 1 个会话：与 planWorldMemoryRetire 同一条规则——boundary 必须属于那个会话。
  // 消息读不出来（null/undefined）时返回 'unknown'：对账那边此时会「本次不动」，
  // 但体检不能因此显示健康，否则用户看到绿勾、下次启动却被悄悄退休。
  if (messageIds === null || messageIds === undefined) return 'unknown';
  const ids = messageIds instanceof Set ? messageIds : new Set(messageIds);
  const active = activeWorldMemoryEntries(character && character.worldInfo);
  return active.some(entry => !ids.has(String((entry && entry.boundary) || ''))) ? 'boundary' : '';
}

// 体检报告。
//   summaryStats：{ status, totalSessions, singleSessions, groupSessions, withSummaries, summariesCount }
//   —— 由弹层逐会话读摘要后传入（纯函数不读盘）；缺省视为未统计。
//   messageIdsByCharacter：Map<角色 id, Set<消息 id> | null>，只对「恰好 1 个单聊会话」的
//   角色有意义（其余情形由会话数就能判定，不需要消息）。null 值 = 读盘失败 → 'unknown'。
//   未出现在 Map 里的角色同样按「未读到」处理（'unknown'），不做「缺省即健康」的猜测。
export function buildMemoryCheckup({
  sessions = [],
  characters = [],
  summaryStats = null,
  messageIdsByCharacter = null,
} = {}) {
  const sessionList = Array.isArray(sessions) ? sessions : [];
  const singleSessions = sessionList.filter(session => session && String(session.type || 'single') !== 'group');
  const groupSessions = sessionList.filter(session => session && String(session.type || 'single') === 'group');
  const idsOf = typeof messageIdsByCharacter === 'object' && messageIdsByCharacter !== null
    && typeof messageIdsByCharacter.get === 'function'
    ? id => (messageIdsByCharacter.has(id) ? messageIdsByCharacter.get(id) : null)
    : () => null;

  const worldEntries = [];
  (Array.isArray(characters) ? characters : []).forEach(character => {
    const worldInfo = Array.isArray(character && character.worldInfo) ? character.worldInfo : [];
    const active = activeWorldMemoryEntries(worldInfo);
    const retired = worldInfo.filter(entry => isWorldMemoryEntry(entry) && entry.enabled === false).length;
    if (active.length === 0 && retired === 0) return;
    const characterId = String((character && character.id) || '');
    const sessionCount = singleChatSessionsOf(sessionList, characterId).length;
    worldEntries.push({
      characterId,
      characterName: String((character && character.name) || '').trim(),
      builtin: isBuiltinCharacter(character),
      activeCount: active.length,
      retiredCount: retired,
      sessionCount,
      issue: active.length > 0
        ? worldMemoryIssue(character, sessionCount, idsOf(characterId))
        : '',
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
