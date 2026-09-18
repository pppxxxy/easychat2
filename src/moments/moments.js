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
  const next = Array.isArray(list) ? [...list, moment] : [moment];
  if (next.length <= MAX_MOMENTS) return next;
  return next.slice(next.length - MAX_MOMENTS);
}
