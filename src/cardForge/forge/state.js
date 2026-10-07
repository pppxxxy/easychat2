// Questionnaire progression, answers and bounded transcript state.

import { clean } from './shared.js';
import { createForgeDraft } from './draft.js';

export const FORGE_QUESTIONS = [
  {
    id: 'name',
    prompt: '先定个名字：这个角色叫什么？',
    options: [
      { id: 'auto', label: '由你根据设定取名' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入角色名',
  },
  {
    id: 'gender',
    prompt: '希望角色的性别是？',
    options: [
      { id: 'male', label: '男性' },
      { id: 'female', label: '女性' },
      { id: 'none', label: '无性别' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入性别设定',
  },
  {
    id: 'identity',
    prompt: '角色的身份或职业是？',
    options: [
      { id: 'student', label: '学生' },
      { id: 'worker', label: '上班族' },
      { id: 'freelance', label: '自由职业' },
      { id: 'fantasy', label: '奇幻世界居民' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入身份或职业',
  },
  {
    id: 'personality',
    prompt: '性格更接近哪一种？',
    options: [
      { id: 'gentle', label: '温柔体贴' },
      { id: 'calm', label: '冷静理性' },
      { id: 'tsundere', label: '傲娇毒舌' },
      { id: 'lively', label: '活泼开朗' },
      { id: 'gloomy', label: '阴郁神秘' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入性格描述',
  },
  {
    id: 'speech',
    prompt: '说话风格呢？',
    options: [
      { id: 'plain', label: '简洁口语' },
      { id: 'formal', label: '文雅书面' },
      { id: 'accent', label: '带口癖或方言' },
      { id: 'jargon', label: '夹带专业术语' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入说话风格',
  },
  {
    id: 'relation',
    prompt: '你和角色的关系起点是？',
    options: [
      { id: 'stranger', label: '初次见面' },
      { id: 'friend', label: '熟人 / 朋友' },
      { id: 'lover', label: '恋人' },
      { id: 'colleague', label: '同事 / 主从' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入关系设定',
  },
  {
    id: 'world',
    prompt: '故事背景设定？',
    options: [
      { id: 'city', label: '现代都市' },
      { id: 'school', label: '校园' },
      { id: 'ancient', label: '古风 / 武侠' },
      { id: 'fantasy', label: '奇幻异世界' },
      { id: 'scifi', label: '科幻未来' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入背景设定',
  },
  {
    id: 'opening',
    prompt: '开场白希望怎么开场？',
    options: [
      { id: 'intro', label: '自我介绍' },
      { id: 'scene', label: '场景描写后搭话' },
      { id: 'question', label: '直接抛出问题' },
      { id: 'emotion', label: '带着情绪开场' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入开场白要求',
  },
  {
    id: 'extra',
    prompt: '还有什么要补充的要求吗？（外貌、口癖、爱好、禁忌等，可留空）',
    options: [
      { id: 'skip', label: '暂时没有了' },
      { id: 'other', label: '其它（自行输入）', free: true },
    ],
    freeHint: '输入补充要求',
  },
  {
    id: 'advanced',
    prompt: '要一起生成世界书、正则脚本或文本预设吗？',
    options: [
      { id: 'none', label: '暂时不要' },
      { id: 'world', label: '生成世界书' },
      { id: 'regex', label: '生成正则脚本' },
      { id: 'presets', label: '生成文本预设' },
      { id: 'all', label: '全部生成' },
    ],
    freeHint: '也可以直接说明要生成哪些',
  },
];

// 高级内容的分段标识：与界面选项标签对应，解析答案时按包含关系匹配。
const ADVANCED_SECTION_LABELS = {
  world: '世界书',
  regex: '正则脚本',
  presets: '文本预设',
};

export function requestedAdvancedSections(state) {
  const answer = clean((state && state.answers && state.answers.advanced) || '', 200);
  if (!answer) return [];
  if (answer.includes('全部')) return ['world', 'regex', 'presets'];
  return Object.keys(ADVANCED_SECTION_LABELS)
    .filter(key => answer.includes(ADVANCED_SECTION_LABELS[key]));
}

const MAX_TRANSCRIPT = 200;

const ROLE_SET = new Set(['ai', 'user', 'note']);

export function createForgeState(now = Date.now()) {
  const first = FORGE_QUESTIONS[0];
  return {
    version: 1,
    step: 0,
    answers: {},
    draft: createForgeDraft(),
    transcript: [
      {
        id: `forge-${now}-intro`,
        role: 'ai',
        text: '我是制卡助手：先问几个问题，你点选项或直接说要求都行。随时可以点「卡片」查看和修改，满意了点「导入」就进角色库。',
      },
      { id: `forge-${now}-q0`, role: 'ai', text: first.prompt, questionId: first.id },
    ],
    updatedAt: now,
  };
}

export function appendTranscript(state, entry, now = Date.now()) {
  const base = state && typeof state === 'object' ? state : createForgeState(now);
  const list = Array.isArray(base.transcript) ? base.transcript : [];
  const record = {
    id: clean(entry && entry.id, 80) || `forge-${now}-${list.length}`,
    role: ROLE_SET.has(entry && entry.role) ? entry.role : 'note',
    text: clean(entry && entry.text),
    questionId: clean(entry && entry.questionId, 60),
    createdAt: now,
  };
  const next = [...list, record];
  return {
    ...base,
    transcript: next.length > MAX_TRANSCRIPT ? next.slice(next.length - MAX_TRANSCRIPT) : next,
    updatedAt: now,
  };
}

export function currentQuestion(state) {
  const index = Math.max(0, Math.trunc(Number(state && state.step)) || 0);
  return FORGE_QUESTIONS[index] || null;
}

export function summarizeAnswers(state) {
  const answers = (state && state.answers) || {};
  return FORGE_QUESTIONS
    .map(question => ({
      question,
      value: clean(answers[question.id], 400),
    }))
    .filter(item => item.value)
    .map(item => `- ${item.question.prompt} → ${item.value}`)
    .join('\n');
}

// 记录一道题的答案并推进到下一题（供界面点击选项 / 输入"其它"时调用）
export function recordAnswer(state, questionId, answer, now = Date.now()) {
  const base = state && typeof state === 'object' ? state : createForgeState(now);
  const step = Math.max(0, Math.trunc(Number(base.step)) || 0);
  const current = FORGE_QUESTIONS[step] || null;
  if (!questionId || !current || String(current.id) !== String(questionId)) return base;
  const value = clean(answer, 600);
  const answers = { ...(base.answers || {}) };
  if (questionId) answers[questionId] = value;
  const nextStep = Math.min(step + 1, FORGE_QUESTIONS.length);
  const answered = { ...base, answers, step: nextStep, updatedAt: now };
  let next = appendTranscript(answered, { id: `a-${now}`, role: 'user', text: value }, now);
  const question = FORGE_QUESTIONS[nextStep] || null;
  if (question) {
    next = appendTranscript(
      next,
      { id: `q-${step}-${now}`, role: 'ai', text: question.prompt, questionId: question.id },
      now + 1
    );
  } else {
    next = appendTranscript(
      next,
      {
        id: `done-${now}`,
        role: 'note',
        text: '问题问完了。点「生成」让我据此写卡（会覆盖当前卡片内容），或直接输入修改要求。',
      },
      now + 1
    );
  }
  return next;
}
