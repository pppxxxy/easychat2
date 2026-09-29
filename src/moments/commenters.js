// 用户发动态后，选择哪些角色来评论。
//
// 规则（与产品确认一致）：
// - 保底：活跃度（消息总条数）最高的角色；并列时全部纳入，可超过 max；
// - 若保底人数 < max，从剩余角色随机补足到 max；
// - 若保底人数 >= max，不再随机，直接用全部保底（允许超过 max）。
//
// 纯函数、随机源可注入，便于确定性单测。

export const DEFAULT_COMMENTER_MAX = 7;

// 按角色累计消息总条数。sessions 为会话列表，messagesBySession 为
// { [sessionId]: Message[] }；只统计单聊（排除群聊）且归属角色明确的会话。
export function countCharacterMessageTotals(sessions, messagesBySession) {
  const totals = {};
  const sessionList = Array.isArray(sessions) ? sessions : [];
  const messageMap = messagesBySession && typeof messagesBySession === 'object'
    ? messagesBySession
    : {};
  sessionList.forEach(session => {
    if (!session || String(session.type || 'single') === 'group') return;
    const characterId = String(session.characterId || '');
    if (!characterId) return;
    const list = Array.isArray(messageMap[session.id]) ? messageMap[session.id] : [];
    const count = list.filter(item => item && (item.role === 'user' || item.role === 'assistant')).length;
    totals[characterId] = (totals[characterId] || 0) + count;
  });
  return totals;
}

// 从剩余候选里随机抽 count 个（不重复），返回保持输入相对顺序的子集。
export function pickRandom(list, count, random = Math.random) {
  const source = Array.isArray(list) ? list.slice() : [];
  const target = Math.max(0, Math.min(Math.trunc(Number(count)) || 0, source.length));
  const picked = [];
  while (picked.length < target && source.length > 0) {
    const index = Math.min(source.length - 1, Math.floor(random() * source.length));
    picked.push(source.splice(index, 1)[0]);
  }
  return picked;
}

// 选出评论角色 id 列表。characters 为角色列表，totals 为 countCharacterMessageTotals 结果。
export function selectCommenters({
  characters,
  totals,
  max = DEFAULT_COMMENTER_MAX,
  excludeIds = [],
  random = Math.random,
} = {}) {
  const limit = Math.trunc(Number(max)) > 0 ? Math.trunc(Number(max)) : DEFAULT_COMMENTER_MAX;
  const excluded = new Set((Array.isArray(excludeIds) ? excludeIds : []).map(id => String(id || '')));
  const list = (Array.isArray(characters) ? characters : [])
    .filter(item => item && item.id && !excluded.has(String(item.id)));
  if (list.length === 0) return [];
  const score = item => Number((totals && totals[String(item.id)]) || 0);

  const maxScore = list.reduce((best, item) => Math.max(best, score(item)), 0);
  // 保底：活跃度最高的角色；并列全部纳入。
  const guaranteed = maxScore > 0 ? list.filter(item => score(item) === maxScore) : [];
  const guaranteedIds = new Set(guaranteed.map(item => String(item.id)));
  const rest = list.filter(item => !guaranteedIds.has(String(item.id)));

  if (guaranteed.length >= limit) {
    // 保底已达标（含超过 max），不再随机。
    return guaranteed.map(item => String(item.id));
  }
  const fill = pickRandom(rest, limit - guaranteed.length, random);
  return [...guaranteed, ...fill].map(item => String(item.id));
}
