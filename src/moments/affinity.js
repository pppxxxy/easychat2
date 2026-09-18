const POSITIVE_WORDS = [
  '喜欢', '开心', '谢谢', '感谢', '爱', '太好了', '真棒', '厉害', '温柔', '可爱',
  '抱抱', '亲亲', '加油', '辛苦', '感动', '幸福', '想你', '陪我', '信任', '安心',
];

const NEGATIVE_WORDS = [
  '讨厌', '滚', '烦', '闭嘴', '恶心', '废物', '去死', '垃圾', '蠢', '笨',
  '生气', '难过', '伤心', '失望', '别烦', '不要你', '分手', '再见',
];

const MILESTONE_EVENTS = [
  { id: 'confession', words: ['表白', '我喜欢你', '在一起', '做我女朋友', '做我男朋友'] },
  { id: 'birthday', words: ['生日', '生日快乐'] },
  { id: 'farewell', words: ['永别', '离开你', '再也不见', '分手'] },
  { id: 'promise', words: ['约定', '发誓', '承诺', '永远'] },
];

const DELTA_LIMIT = 5;

function countMatches(text, words) {
  const source = String(text || '');
  if (!source) return 0;
  return words.reduce((acc, word) => (source.includes(word) ? acc + 1 : acc), 0);
}

export function detectMilestone(text) {
  const source = String(text || '');
  if (!source) return null;
  const hit = MILESTONE_EVENTS.find(event => event.words.some(word => source.includes(word)));
  return hit ? hit.id : null;
}

export function evaluateTurn({ userText, assistantText } = {}) {
  const user = String(userText || '');
  const assistant = String(assistantText || '');
  const positive = countMatches(user, POSITIVE_WORDS) + countMatches(assistant, POSITIVE_WORDS);
  const negative = countMatches(user, NEGATIVE_WORDS) + countMatches(assistant, NEGATIVE_WORDS);
  let delta = 0;
  if (positive > negative) delta = Math.min(DELTA_LIMIT, positive - negative);
  else if (negative > positive) delta = -Math.min(DELTA_LIMIT, negative - positive);
  if (delta === 0 && user.trim().length >= 20) delta = 1;
  return {
    delta,
    milestone: detectMilestone(user) || detectMilestone(assistant),
  };
}

export function clampAffinity(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

export const AFFINITY_LIMIT = 100;
