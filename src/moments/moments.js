export const MAX_MOMENTS = 200;

const TURN_THRESHOLDS = [50, 100];

const TEMPLATES = {
  'affinity-best': [
    '今天心情特别好，遇到了很重要的人。',
    '有些话想记下来：被认真对待的感觉，真好。',
    '原来被人放在心上，是这么温暖的事。',
  ],
  'affinity-worst': [
    '有点难过，好像说什么都不对。',
    '今天不太想说话，只想安静一会儿。',
    '有些关系，好像正在慢慢变远。',
  ],
  'turns-50': [
    '不知不觉已经聊了这么久，时间过得真快。',
    '第 50 次对话。细水长流，也很好。',
  ],
  'turns-100': [
    '第 100 次对话。能坚持这么久，是件了不起的事。',
    '一百次了。谢谢你一直都在。',
  ],
  milestone: '今天发生了一件值得记住的事。',
};

function pick(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const index = Math.abs(Number(seed) || 0) % list.length;
  return list[index];
}

export function shouldTrigger({ affinity = 0, turnCount = 0, milestone = null, triggers = [] } = {}) {
  const seen = Array.isArray(triggers) ? triggers : [];
  const score = Number(affinity);
  if (Number.isFinite(score) && score >= 100 && !seen.includes('affinity-best')) return 'affinity-best';
  if (Number.isFinite(score) && score <= -100 && !seen.includes('affinity-worst')) return 'affinity-worst';
  const turns = Number(turnCount);
  if (Number.isFinite(turns)) {
    for (const threshold of TURN_THRESHOLDS) {
      if (turns >= threshold && !seen.includes(`turns-${threshold}`)) return `turns-${threshold}`;
    }
  }
  if (milestone) {
    const id = `milestone-${milestone}`;
    if (!seen.includes(id)) return id;
  }
  return null;
}

export function buildMomentText({ trigger, character, seed = 0 } = {}) {
  const name = String((character && character.name) || '').trim() || '角色';
  if (trigger && trigger.startsWith('milestone-')) {
    return `${TEMPLATES.milestone}（${name}）`;
  }
  const list = TEMPLATES[trigger];
  const text = pick(list, seed) || TEMPLATES.milestone;
  return `${text}（${name}）`;
}

export function appendMoment(list, moment) {
  // 按 createdAt 升序后再保留最新 MAX_MOMENTS 条：调用方传入的列表可能是
  // getMoments 的降序结果，直接按位置 slice 会把最新动态当旧数据丢掉。
  const next = [...(Array.isArray(list) ? list : []), moment]
    .sort((a, b) => (Number(a && a.createdAt) || 0) - (Number(b && b.createdAt) || 0));
  if (next.length <= MAX_MOMENTS) return next;
  return next.slice(next.length - MAX_MOMENTS);
}

function sessionIdSet(sessionIds) {
  return new Set(
    (Array.isArray(sessionIds) ? sessionIds : [])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
}

function characterIdSet(characterIds) {
  return new Set(
    (Array.isArray(characterIds) ? characterIds : [])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
}

function isMomentLinkedToCharacterDeletion(moment, characterIds, sessionIds) {
  const characters = characterIdSet(characterIds);
  const sessions = sessionIdSet(sessionIds);
  if (characters.size === 0 && sessions.size === 0) return false;
  return !!moment && (
    characters.has(String(moment.characterId || ''))
    || sessions.has(String(moment.sessionId || ''))
  );
}

export function countMomentsForCharacterDeletion(list, characterIds, sessionIds = []) {
  return (Array.isArray(list) ? list : [])
    .filter(moment => isMomentLinkedToCharacterDeletion(moment, characterIds, sessionIds))
    .length;
}

export function removeMomentsForCharacterDeletion(list, characterIds, sessionIds = []) {
  return (Array.isArray(list) ? list : [])
    .filter(moment => !isMomentLinkedToCharacterDeletion(moment, characterIds, sessionIds));
}

// 删除记忆（会话）时用于联动清理锚定在这些会话上的动态。动态的 sessionId 为
// 空串时（老数据或不来自对话）不参与匹配。
export function selectMomentIdsBySessionIds(list, sessionIds) {
  const ids = sessionIdSet(sessionIds);
  if (ids.size === 0) return [];
  return (Array.isArray(list) ? list : [])
    .filter(moment => moment && ids.has(String(moment.sessionId || '')))
    .map(moment => String((moment && moment.id) || ''))
    .filter(Boolean);
}

export function countMomentsBySessionIds(list, sessionIds) {
  return selectMomentIdsBySessionIds(list, sessionIds).length;
}

export function removeMomentsBySessionIds(list, sessionIds) {
  const ids = sessionIdSet(sessionIds);
  if (ids.size === 0) return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : [])
    .filter(moment => !moment || !ids.has(String(moment.sessionId || '')));
}
