// 制卡（AI 辅助创建角色卡）的核心逻辑：问题脚本、提示词构造、模型回复解析、草稿与角色的互转。
// 纯函数、零依赖（不 import storage / api / cardParser），便于单测与在纯 Node 环境运行。

export const FORGE_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'firstMes',
  'mesExample',
  'creatorNotes',
  'postHistoryInstructions',
];

export const FIELD_LABELS = {
  name: '角色名',
  description: '角色描述',
  personality: '性格',
  scenario: '场景',
  firstMes: '开场白',
  mesExample: '对话示例',
  creatorNotes: '备注',
  postHistoryInstructions: '历史后指令',
};

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
];

const MAX_FIELD_TEXT = 4000;
const MAX_TRANSCRIPT = 200;
const MAX_TAG_COUNT = 10;
const ROLE_SET = new Set(['ai', 'user', 'note']);

function clean(value, max = MAX_FIELD_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

export function createForgeDraft() {
  const draft = {};
  FORGE_FIELDS.forEach(key => { draft[key] = ''; });
  draft.tags = [];
  // 下面这几个不属于 AI 改写范围，只在「角色 → 制卡 → 角色」之间原样保留：
  // 否则用制卡改一遍角色，就会把原有系统提示、备用开场白、世界书、正则脚本静默丢掉。
  draft.systemPrompt = '';
  draft.alternateGreetings = [];
  draft.worldInfo = [];
  draft.regexScripts = [];
  return draft;
}

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
  const value = clean(answer, 600);
  const answers = { ...(base.answers || {}) };
  if (questionId) answers[questionId] = value;
  const step = Math.min((Math.trunc(Number(base.step)) || 0) + 1, FORGE_QUESTIONS.length);
  const answered = { ...base, answers, step, updatedAt: now };
  let next = appendTranscript(answered, { id: `a-${now}`, role: 'user', text: value }, now);
  const question = FORGE_QUESTIONS[step] || null;
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

export function buildGeneratePrompt(state) {
  const answers = summarizeAnswers(state);
  const draft = JSON.stringify((state && state.draft) || {}, null, 0);
  return [
    '你是角色卡（SillyTavern 风格）撰写助手。请根据下面的问答结果和当前草稿，写出一张完整的角色卡。',
    '',
    '问答结果：',
    answers || '（用户没有回答任何问题，请你自行合理设计一个有意思的角色）',
    '',
    '当前草稿（在此基础上完善，可以为空）：',
    draft,
    '',
    '输出要求：',
    '- 只输出一个 JSON 对象，不要任何解释、前后缀或代码块标记。',
    '- 字段固定为：name, description, personality, scenario, firstMes, mesExample, creatorNotes, postHistoryInstructions, tags。',
    '- name：角色名（2-8 字）；description：外貌、身份、背景（150-400 字）；personality：性格与说话方式（80-200 字）。',
    '- scenario：故事背景以及角色与用户的关系（50-200 字）。',
    '- firstMes：角色主动说的第一条消息，第一人称，1-3 句，不要替用户说话。',
    '- mesExample：1-2 组对话示例，格式为「{{user}}：…」与「角色名：…」逐行交替。',
    '- creatorNotes：给用户的使用建议（可留空）；postHistoryInstructions：给模型的持续要求（可留空）。',
    '- tags：3-6 个简短中文标签组成的数组。',
    '- 全部使用中文。',
  ].join('\n');
}

export function buildEditPrompt({ draft, request, answers } = {}) {
  const summary = clean(answers, 800);
  return [
    '你是角色卡编辑器。请按用户的要求修改下面的角色卡，只改需要改的字段，其余字段原样保留。',
    '',
    '当前卡片 JSON：',
    JSON.stringify(draft || {}, null, 0),
    summary ? `\n已知的设定要求：\n${summary}` : '',
    '',
    `用户要求：${clean(request, 800) || '（空）'}`,
    '',
    '输出要求：',
    '- 只输出修改后的完整 JSON 对象，不要任何解释或代码块标记。',
    '- 字段与结构保持不变，不要新增或删除字段。',
    '- 全部使用中文。',
  ].filter(Boolean).join('\n');
}

// 从模型回复里抠出 JSON（容忍代码块包裹与前后多余文字），只取白名单字段
export function parseCardPatch(text) {
  const raw = clean(text, 20000);
  if (!raw) return null;
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const patch = {};
    FORGE_FIELDS.forEach(key => {
      if (typeof parsed[key] === 'string') patch[key] = parsed[key];
    });
    if (Array.isArray(parsed.tags)) {
      patch.tags = parsed.tags
        .map(item => clean(item, 40))
        .filter(Boolean)
        .slice(0, MAX_TAG_COUNT);
    }
    if (Object.keys(patch).length > 0) return patch;
  }
  return null;
}

export function mergeDraft(draft, patch, now = Date.now()) {
  const base = draft && typeof draft === 'object' ? draft : createForgeDraft();
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = { ...base };
  const changed = [];
  FORGE_FIELDS.forEach(key => {
    if (typeof source[key] !== 'string') return;
    const value = clean(source[key]);
    if (!value || value === clean(base[key])) return;
    next[key] = value;
    changed.push(FIELD_LABELS[key] || key);
  });
  if (Array.isArray(source.tags)) {
    const tags = source.tags.map(item => clean(item, 40)).filter(Boolean).slice(0, MAX_TAG_COUNT);
    if (tags.length > 0 && tags.join('|') !== (Array.isArray(base.tags) ? base.tags.join('|') : '')) {
      next.tags = tags;
      changed.push('标签');
    }
  }
  return { draft: next, changed, updatedAt: now };
}

// 反向导入：把角色库里已有的角色读成制卡草稿
export function draftFromCharacter(character) {
  const source = character && typeof character === 'object' ? character : {};
  const draft = createForgeDraft();
  FORGE_FIELDS.forEach(key => { draft[key] = clean(source[key]); });
  draft.tags = Array.isArray(source.tags)
    ? source.tags.map(item => clean(item, 40)).filter(Boolean).slice(0, MAX_TAG_COUNT)
    : [];
  // 原样带走这些字段，保证往返不丢内容
  draft.systemPrompt = clean(source.systemPrompt, 12000);
  draft.alternateGreetings = Array.isArray(source.alternateGreetings)
    ? source.alternateGreetings.map(item => clean(item)).filter(Boolean).slice(0, 20)
    : [];
  draft.worldInfo = Array.isArray(source.worldInfo)
    ? source.worldInfo.filter(item => item && typeof item === 'object').slice(0, 100)
    : [];
  draft.regexScripts = Array.isArray(source.regexScripts)
    ? source.regexScripts.filter(item => item && typeof item === 'object').slice(0, 100)
    : [];
  return draft;
}

// 正向导入：把草稿变成可以 addCharacter 的角色结构。
// composedPrompt 由调用方用 cardParser 的 buildSystemPrompt 生成（这里保持零依赖）。
export function draftToCharacterPatch(draft, { composedPrompt = '', now = Date.now() } = {}) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const ownPrompt = clean(source.systemPrompt, 12000);
  return {
    id: `forge-${now.toString(36)}`,
    name: clean(source.name, 60) || '新角色',
    systemPrompt: ownPrompt,
    systemPromptComposed: clean(composedPrompt, 12000) || ownPrompt,
    description: clean(source.description),
    personality: clean(source.personality),
    scenario: clean(source.scenario),
    firstMes: clean(source.firstMes),
    alternateGreetings: Array.isArray(source.alternateGreetings)
      ? source.alternateGreetings.slice(0, 20)
      : [],
    mesExample: clean(source.mesExample),
    creatorNotes: clean(source.creatorNotes),
    postHistoryInstructions: clean(source.postHistoryInstructions),
    tags: Array.isArray(source.tags) ? source.tags.map(item => clean(item, 40)).filter(Boolean) : [],
    worldInfo: Array.isArray(source.worldInfo) ? source.worldInfo.slice(0, 100) : [],
    regexScripts: Array.isArray(source.regexScripts) ? source.regexScripts.slice(0, 100) : [],
  };
}

export function hasCardContent(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  return FORGE_FIELDS.some(key => clean(source[key]).length > 0)
    || clean(source.systemPrompt).length > 0;
}
