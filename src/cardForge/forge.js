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

// ---- 高级内容的本地清洗：forge 保持零依赖，不引入 cardParser，仅产出与
// normalizeWorldEntry / normalizeRegexScript / characterPresets 一致的结构 ----

const WORLD_POSITION_LABELS = {
  0: '角色定义之前',
  1: '角色定义之后',
  2: '作者注释之前',
  3: '作者注释之后',
  4: '按深度插入',
  5: '示例消息前',
  6: '示例消息后',
  7: '锚点',
};

const WORLD_POSITION_ALIASES = {
  before_char: 0,
  beforechar: 0,
  after_char: 1,
  afterchar: 1,
  before_author_note: 2,
  before_an: 2,
  after_author_note: 3,
  after_an: 3,
  at_depth: 4,
  atdepth: 4,
  before_example_messages: 5,
  before_em: 5,
  after_example_messages: 6,
  after_em: 6,
  outlet: 7,
};

const REGEX_PLACEMENT_LABELS = {
  1: '用户输入',
  2: 'AI 输出',
  3: '快捷命令',
  5: '世界信息',
  6: '推理',
};

function toStringList(value) {
  if (Array.isArray(value)) {
    return value.map(item => clean(item, 200)).filter(Boolean).slice(0, 50);
  }
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/[,，\n]/)
    .map(item => clean(item, 200))
    .filter(Boolean)
    .slice(0, 50);
}

function normalizeWorldPositionValue(value) {
  let numeric = null;
  if (typeof value === 'number' && Number.isFinite(value)) numeric = value;
  else if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (WORLD_POSITION_ALIASES[lowered] !== undefined) numeric = WORLD_POSITION_ALIASES[lowered];
    else {
      const parsed = Number(lowered);
      if (Number.isFinite(parsed)) numeric = parsed;
    }
  }
  if (numeric === null || WORLD_POSITION_LABELS[numeric] === undefined) numeric = 0;
  return numeric;
}

function sanitizeWorldEntry(item, index) {
  const source = item && typeof item === 'object' ? item : { content: String(item == null ? '' : item) };
  const keys = toStringList(source.keys ?? source.key ?? source.keywords ?? source.keyword);
  const content = preserveText(source.content ?? source.value ?? source.text ?? '');
  const position = normalizeWorldPositionValue(source.position);
  const depthValue = Math.trunc(Number(source.depth));
  return {
    id: `forge-entry-${index + 1}`,
    comment: clean(source.comment ?? source.name ?? source.title, 120) || `世界书条目 ${index + 1}`,
    keys,
    secondaryKeys: toStringList(source.secondaryKeys ?? source.secondary_keys),
    content,
    constant: source.constant === true,
    selective: source.selective === true,
    enabled: source.enabled !== false,
    useRegex: source.useRegex === true,
    caseSensitive: source.caseSensitive === true,
    matchWholeWords: source.matchWholeWords === true,
    position,
    positionLabel: WORLD_POSITION_LABELS[position],
    role: ['system', 'user', 'assistant'].includes(source.role) ? source.role : 'system',
    order: 100,
    depth: Number.isFinite(depthValue) ? depthValue : 4,
    probability: 100,
    useProbability: true,
    scanDepth: null,
    boundary: '',
  };
}

function sanitizeRegexPlacement(value) {
  const aliases = { user: 1, input: 1, ai: 2, output: 2, world: 5, world_info: 5, reasoning: 6 };
  const list = Array.isArray(value) ? value : (value === null || value === undefined ? [] : [value]);
  const placement = list
    .map(item => {
      const key = String(item || '').trim().toLowerCase();
      return aliases[key] ?? (key ? Number(item) : NaN);
    })
    .filter(item => Number.isFinite(item) && REGEX_PLACEMENT_LABELS[item] !== undefined);
  if (placement.length === 0) return [1, 2];
  return Array.from(new Set(placement));
}

function sanitizeRegexScript(item, index) {
  const source = item && typeof item === 'object' ? item : { findRegex: String(item == null ? '' : item) };
  const placement = sanitizeRegexPlacement(source.placement ?? source.placements ?? source.scope);
  return {
    id: `forge-regex-${index + 1}`,
    name: clean(source.name ?? source.title, 120) || `正则脚本 ${index + 1}`,
    findRegex: preserveText(source.findRegex ?? source.regex ?? source.pattern ?? ''),
    replaceString: preserveText(source.replaceString ?? source.replacement ?? source.replace ?? ''),
    flags: clean(source.flags, 10) || 'g',
    placement,
    placementLabel: placement.map(key => REGEX_PLACEMENT_LABELS[key]).join('、'),
    enabled: source.enabled !== false,
    markdownOnly: source.markdownOnly === true,
    promptOnly: source.promptOnly === true,
    minDepth: null,
    maxDepth: null,
  };
}

function sanitizePreset(item, index) {
  const source = typeof item === 'string'
    ? { prompt: item }
    : (item && typeof item === 'object' ? item : {});
  const prompt = preserveText(source.prompt ?? source.content ?? source.text ?? '');
  if (!prompt.trim()) return null;
  return {
    id: `forge-preset-${index + 1}`,
    name: clean(source.name ?? source.title, 120) || `预设 ${index + 1}`,
    description: clean(source.description ?? source.note, 300),
    prompt,
    enabled: source.enabled !== false,
  };
}

function sanitizeAdvancedArray(value, sanitizer) {
  if (!Array.isArray(value)) return null;
  const list = value
    .map((item, index) => sanitizer(item, index))
    .filter(Boolean)
    .slice(0, MAX_PRESERVED_ITEMS);
  return list.length > 0 ? list : null;
}

const MAX_FIELD_TEXT = 4000;
export const MAX_PRESERVED_TEXT = 500000;
export const MAX_PRESERVED_ITEMS = 2000;
const MAX_TRANSCRIPT = 200;
// 标签上限全流程统一：草稿导入、提示词投影、模型补丁解析、合并与编辑器 UI 共用同一常量，
// 避免导入时保留 2000 个、AI 往返却静默截断到 10 个的往返丢失。
export const MAX_FORGE_TAG_COUNT = 100;
const ROLE_SET = new Set(['ai', 'user', 'note']);

function clean(value, max = MAX_FIELD_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function preserveText(value, max = MAX_PRESERVED_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
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
  draft.presets = [];
  // 头像与背景图：制卡里选的图先落在 card-forge/ 目录（不进孤儿回收扫描范围），
  // 导入角色库时才提升到 avatars/ 并进入引用集合。同样不参与 AI 改写。
  draft.avatarUri = '';
  draft.bgUri = '';
  // 往返保留但不由 AI 改写：语音形态、AI 生成标识、第三方扩展与顶层透传字段。
  // 不带这些字段时，用制卡改一遍会把语音形态打回纯文字、并丢掉 AI 标识与作者扩展。
  draft.voiceDisplay = 'text';
  draft.aigcMeta = null;
  draft.cardExtensions = {};
  draft.cardExtra = {};
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

// 提示词只带 AI 可改写的字段。系统提示、备用开场白、世界书、正则脚本属于
// 「原样保留」的字段，既不参与生成也不该出现在提示词里，否则提示词会被
// 这些大块内容无谓放大，还会误导模型以为它们需要一起改写。
export function projectForgeDraft(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const projected = {};
  FORGE_FIELDS.forEach(key => { projected[key] = preserveText(source[key]); });
  projected.tags = Array.isArray(source.tags)
    ? source.tags.map(item => clean(item, 40)).filter(Boolean).slice(0, MAX_FORGE_TAG_COUNT)
    : [];
  return projected;
}

// 世界书字段规则。整卡生成与「补写高级内容」两步共用，避免两处各写一遍后提示词漂移。
function buildWorldInfoRules() {
  return [
    '- worldInfo：世界书条目数组，每项 {comment, keys, content, constant, position, depth, enabled:true}，共写 6-12 条。字段规则：',
    '  · keys：2-4 个触发关键词，选「只在谈到该话题时才会出现的具体词」（如种族名、组织名、地名、人名），禁止使用「你、我、他、她、非常、突然」这类每句话都可能出现的高频词。',
    '  · constant：true 表示常驻注入（无需关键词命中，每一轮都生效）；false 表示关键词触发。',
    '  · position：0=角色定义之前，1=角色定义之后，4=按深度插入（配 depth 数字，表示插入到倒数第 depth 条消息附近）。',
    '  · content：第三人称客观陈述设定事实，不写对话，不写「她会告诉你」这类元描述。',
    '内容组织：',
    '  · 第 1 条必须是总览：comment 写「世界观总览」，constant:true，position:0，keys 可为空数组，content 100-200 字概括世界基调、时代背景、核心冲突。',
    '  · 其余条目全部 constant:false、position:1（紧贴角色定义，适合设定条目）；只有「随对话递进揭晓的真相/秘密」类条目用 position:4、depth:4。',
    '  · 每条只讲一个主题：种族、组织、地点、历史事件、力量/等级体系、规则与禁忌分别成条。',
    '  · 每条 content 80-200 字，要写「具体内容」：例如「等级体系」要写清有哪些等级、各等级特征、晋升条件；「种族」要写清有哪些种族、各自特点与相互关系。',
    '  · 条目之间不要重复；总览只做铺垫，细节留给触发条目。',
  ].join('\n');
}

// 正则字段规则：JS RegExp（非 PCRE）方言、flags、替换语义、placement 与两种 Only 开关。
function buildRegexRules() {
  return [
    '- regexScripts：正则脚本数组，每项 {name, findRegex, replaceString, flags, placement, markdownOnly, promptOnly, enabled:true}。只在确有需要时给 1-3 条，没有合适的用途就不输出该字段。写法规范：',
    '  · 运行环境是 JavaScript RegExp（不是 PCRE）。findRegex 是正则源码字符串：不要带首尾斜杠、不带修饰符（修饰符写进 flags）。可用语法：字符类、量词、分组 (...)、引用分组；lookahead/lookbehind 支持但尽量少用；不要用 \\p{...}、(?P<name>...)、递归等非 JS 语法。',
    '  · flags 是字符串，默认 "g"；需要忽略大小写加 "i"（如 "gi"），跨行匹配加 "m" 或 "s"。不要写 "u"。',
    '  · replaceString 按 JavaScript String.replace 的替换规则：$1 $2 引用分组、$& 引用整段匹配、字面 $ 写 $$。',
    '  · placement 决定作用对象：[1]=用户输入的消息、[2]=AI 输出的消息；只处理展示也必须包含对应项。',
    '  · markdownOnly:true（只影响界面展示，不改变发给模型的内容）与 promptOnly:true（只影响发给模型的内容）互斥，最多一个为 true；两个都 false 表示两边都生效，慎用。',
    '  · replaceString 可以内嵌 HTML 做样式，例如 <span style="color:#c7254e">$&</span> 高亮、<em>$1</em> 斜体；删除匹配内容时 replaceString 用空字符串。',
    '  · 每条 name 用途要一目了然（如「星号动作斜体化」「隐藏状态栏」）。',
    '典型用途参考（按需选用，不要照抄）：',
    '  · 把 *动作* 转为斜体展示：findRegex "\\\\*([^*\\\\n]+)\\\\*"，replaceString "<em>$1</em>"，flags "g"，placement [2]，markdownOnly true。',
    '  · 清理发给模型前的占位符：findRegex "\\\\{\\\\{user\\\\}\\\\}"，replaceString "用户"，flags "g"，placement [1]，promptOnly true。',
  ].join('\n');
}

// 预设字段规则：机制（拼进系统提示词末尾的 [角色预设] 块）+ 行为约束类型 + 与 PHI 的分工。
function buildPresetRules() {
  return [
    '- presets：文本预设数组，每项 {name, prompt, enabled:true}，写 1-3 条。预设的机制：每条 prompt 会被追加到系统提示词末尾的 [角色预设] 区块（角色定义与世界书之后），多条按换行拼接，{{user}} 会替换为用户名。',
    '  · 预设写「对模型输出行为的约束」，不要复述角色设定（那是 description/世界书的职责）。',
    '  · 每条聚焦一类约束，name 说明用途，prompt 40-150 字，用祈使句直接下指令。常用类型：',
    '    文风（如「对话以动作为先，心理描写克制，每段不超过 3 句」）、',
    '    格式（如「动作描写用星号包裹，说话内容用直角引号」）、',
    '    长度（如「每次回复 2-4 段，不要主动结束场景」）、',
    '    禁忌（如「不要替 {{user}} 说话或决定 {{user}} 的行动」）。',
    '  · 与 postHistoryInstructions 的分工：预设放角色/世界层面的长期写作要求；postHistoryInstructions 放必须压过对话惯性的硬规则（输出语言、安全边界、格式红线）。',
  ].join('\n');
}

function buildAdvancedLines(sections) {
  const advancedLines = [];
  if (sections.includes('world')) advancedLines.push(buildWorldInfoRules());
  if (sections.includes('regex')) advancedLines.push(buildRegexRules());
  if (sections.includes('presets')) advancedLines.push(buildPresetRules());
  return advancedLines;
}

const ADVANCED_SECTION_SCHEMA_LABELS = {
  world: 'worldInfo（世界书）',
  regex: 'regexScripts（正则脚本）',
  presets: 'presets（文本预设）',
};

export function buildGeneratePrompt(state, { includeAdvanced = true } = {}) {
  const answers = summarizeAnswers(state);
  const draft = JSON.stringify(projectForgeDraft(state && state.draft), null, 0);
  const sections = includeAdvanced ? requestedAdvancedSections(state) : [];
  const advancedLines = buildAdvancedLines(sections);
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
    ...buildCardOutputRules(),
    ...(advancedLines.length > 0
      ? [
        '- 本次还需要在同一个 JSON 里追加以下高级字段（未要求的字段不要输出）：',
        ...advancedLines,
      ]
      : []),
    '- 全部使用中文。',
  ].join('\n');
}

// 「补写高级内容」的第二步提示词：带上已生成的角色卡投影与全文设定，只要求世界书/正则/预设。
// 拆成第二步是为了避免单次输出数千字 JSON 被截断，导致后半段（高级内容）敷衍或解析失败。
export function buildAdvancedPrompt(state, draft) {
  const sections = requestedAdvancedSections(state);
  const source = draft && typeof draft === 'object' ? draft : ((state && state.draft) || {});
  const advancedLines = buildAdvancedLines(sections);
  return [
    '你是角色卡（SillyTavern 风格）撰写助手。请根据下面的角色卡与设定，补写它的高级内容（世界书 / 正则脚本 / 文本预设）。',
    '',
    '问答结果：',
    summarizeAnswers(state) || '（无）',
    '',
    '已生成的角色卡（在此基础上补写高级内容）：',
    JSON.stringify(projectForgeDraft(source), null, 0),
    '',
    '输出要求：',
    '- 只输出一个 JSON 对象，不要任何解释、前后缀或代码块标记。',
    `- 字段只包含本次要求的这些：${sections.map(key => ADVANCED_SECTION_SCHEMA_LABELS[key] || key).join('、')}；其余字段不要输出。`,
    ...advancedLines,
    '- 全部使用中文。',
  ].join('\n');
}

// JSON 解析失败时的一次性自修复请求：回传被截断/非法转义片段，要求重出完整 JSON。
export function buildJsonRepairPrompt(rawOutput) {
  const snippet = String(rawOutput == null ? '' : rawOutput).slice(0, 500);
  return [
    '你上次输出的 JSON 无法解析（可能被截断或含非法转义）。请重新输出完整、合法的 JSON 对象，不要任何解释或代码块标记。',
    '',
    '上次输出的开头片段（仅供对照，不要原样重复）：',
    snippet || '（空）',
  ].join('\n');
}

// 角色卡 JSON 的输出规则。整卡生成、按图生成、字段描述共用同一份，
// 避免三处各写一遍后互相漂移（字段名/清空语义/中文要求必须一致）。
function buildCardOutputRules() {
  return [
    '- 只输出一个 JSON 对象，不要任何解释、前后缀或代码块标记。',
    '- 字段固定为：name, description, personality, scenario, firstMes, mesExample, creatorNotes, postHistoryInstructions, tags。',
    '- name：角色名（2-8 字）；description：外貌、身份、背景（150-400 字）；personality：性格与说话方式（80-200 字）。',
    '- scenario：故事背景以及角色与用户的关系（50-200 字）。',
    '- firstMes：角色主动说的第一条消息，第一人称，1-3 句，不要替用户说话。',
    '- mesExample：1-2 组对话示例，格式为「{{user}}：…」与「角色名：…」逐行交替。',
    '- creatorNotes：给用户的使用建议（可留空）；postHistoryInstructions：给模型的持续要求（可留空）。',
    '- tags：3-6 个简短中文标签组成的数组。',
    '- 要清空某个字段或全部标签时，把该字段（或 tags）的值写成 null；不要用空字符串或空数组表示清空。',
  ];
}

export function buildEditPrompt({ draft, request, answers } = {}) {
  const summary = clean(answers, 800);
  return [
    '你是角色卡编辑器。请按用户的要求修改下面的角色卡，只改需要改的字段，其余字段原样保留。',
    '',
    '当前卡片 JSON：',
    JSON.stringify(projectForgeDraft(draft), null, 0),
    summary ? `\n已知的设定要求：\n${summary}` : '',
    '',
    `用户要求：${clean(request, 800) || '（空）'}`,
    '',
    '输出要求：',
    '- 只输出修改后的完整 JSON 对象，不要任何解释或代码块标记。',
    '- 字段与结构保持不变，不要新增或删除字段。',
    '- 未修改的字段必须原样完整复制，不要留空。',
    '- 要清空某个字段或全部标签时，把该字段（或 tags）的值写成 null；空字符串和空数组不会被视为清空。',
    '- 全部使用中文。',
  ].filter(Boolean).join('\n');
}

// 「按图片生成角色」的提示词：图片作为多模态内容随本提示一起发送，
// 这里只给文字侧的规则。用户补充说明可选。
export function buildImageCardPrompt({ hint = '', hasAvatar = false, hasBg = false } = {}) {
  const images = [
    hasAvatar ? '第一张是角色的头像/立绘' : '',
    hasBg ? `${hasAvatar ? '第二张' : '第一张'}是角色的场景或背景` : '',
  ].filter(Boolean).join('，');
  return [
    '你是角色卡（SillyTavern 风格）撰写助手。请根据随本条消息附带的图片，写出一张完整的角色卡。',
    images ? `图片说明：${images}。` : '',
    hint ? `用户的补充要求：${clean(hint, 400)}` : '',
    '',
    '要求：',
    '- 从图片中读出外貌特征（发色、瞳色、服饰、气质、年龄感、画风）与场景氛围，据此设计角色。',
    '- 如果图片里有人物，角色要与图中人物一致；如果只有场景，就以该场景设计一个合理的角色。',
    '- 不要描写图片里没有的、与画面明显冲突的特征。',
    ...buildCardOutputRules(),
    '- 全部使用中文。',
  ].filter(Boolean).join('\n');
}

// 从模型回复里抠出 JSON（容忍代码块包裹与前后多余文字），只取白名单字段
export function parseCardPatch(text) {
  const raw = String(text || '').trim().slice(0, MAX_PRESERVED_TEXT);
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
      // null 是唯一的显式清空指令；字符串（含空串）只按普通值处理。
      if (typeof parsed[key] === 'string') patch[key] = parsed[key];
      else if (parsed[key] === null) patch[key] = null;
    });
    if (parsed.tags === null) {
      patch.tags = null;
    } else if (Array.isArray(parsed.tags)) {
      patch.tags = parsed.tags
        .map(item => clean(item, 40))
        .filter(Boolean)
        .slice(0, MAX_FORGE_TAG_COUNT);
    }
    // 高级字段只在模型确实给出非空数组时采纳：空数组不做清空语义，
    // 避免一次「没生成」把用户已有的世界书 / 正则 / 预设抹掉。
    const worldInfo = sanitizeAdvancedArray(parsed.worldInfo, sanitizeWorldEntry);
    if (worldInfo) patch.worldInfo = worldInfo;
    const regexScripts = sanitizeAdvancedArray(parsed.regexScripts, sanitizeRegexScript);
    if (regexScripts) patch.regexScripts = regexScripts;
    const presets = sanitizeAdvancedArray(parsed.presets, sanitizePreset);
    if (presets) patch.presets = presets;
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
    // 显式清空只认 null 哨兵。提示词要求模型回全量 JSON，模型给未改字段填空串
    // 是常见偷懒行为——空串若被当成清空指令，用户已写好的长字段会被一次性抹掉。
    if (source[key] === null) {
      if (clean(base[key], MAX_PRESERVED_TEXT) === '') return;
      next[key] = '';
      changed.push(`${FIELD_LABELS[key] || key}（已清空）`);
      return;
    }
    if (typeof source[key] !== 'string') return;
    const value = clean(source[key], MAX_PRESERVED_TEXT);
    if (!value) return;
    if (value === clean(base[key], MAX_PRESERVED_TEXT)) return;
    next[key] = value;
    changed.push(FIELD_LABELS[key] || key);
  });
  if (source.tags === null) {
    const baseTags = Array.isArray(base.tags) ? base.tags : [];
    if (baseTags.length > 0) {
      next.tags = [];
      changed.push('标签（已清空）');
    }
  } else if (Array.isArray(source.tags)) {
    const tags = source.tags.map(item => clean(item, 40)).filter(Boolean).slice(0, MAX_FORGE_TAG_COUNT);
    // 空数组同样不构成清空指令（理由同上）；只有显式 null 才清空标签。
    if (tags.length > 0 && tags.join('|') !== (Array.isArray(base.tags) ? base.tags.join('|') : '')) {
      next.tags = tags;
      changed.push('标签');
    }
  }
  // 高级内容：模型给了非空数组就整体替换（生成的是新角色卡内容），
  // 没给则保留草稿里原有条目（导入已有角色时不至于被生成覆盖掉）。
  const advanced = [
    ['worldInfo', '世界书', sanitizeWorldEntry],
    ['regexScripts', '正则脚本', sanitizeRegexScript],
    ['presets', '文本预设', sanitizePreset],
  ];
  advanced.forEach(([key, label, sanitizer]) => {
    const list = sanitizeAdvancedArray(source[key], sanitizer);
    if (!list) return;
    next[key] = list;
    changed.push(`${label}（${list.length} 条）`);
  });
  return { draft: next, changed, updatedAt: now };
}

// 反向导入：把角色库里已有的角色读成制卡草稿
export function draftFromCharacter(character) {
  const source = character && typeof character === 'object' ? character : {};
  const draft = createForgeDraft();
  FORGE_FIELDS.forEach(key => { draft[key] = preserveText(source[key]); });
  draft.tags = Array.isArray(source.tags)
    ? source.tags.map(item => preserveText(item, 40)).filter(Boolean).slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.systemPrompt = preserveText(source.systemPrompt);
  draft.alternateGreetings = Array.isArray(source.alternateGreetings)
    ? source.alternateGreetings.map(item => preserveText(item)).filter(item => item.trim()).slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.worldInfo = Array.isArray(source.worldInfo)
    ? source.worldInfo.filter(item => item && typeof item === 'object').slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.regexScripts = Array.isArray(source.regexScripts)
    ? source.regexScripts.filter(item => item && typeof item === 'object').slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.presets = Array.isArray(source.presets)
    ? source.presets.filter(item => item && typeof item === 'object').slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.avatarUri = preserveText(source.avatarUri, 2000);
  draft.bgUri = preserveText(source.bgUri, 2000);
  draft.voiceDisplay = ['text', 'voice-text', 'voice'].includes(source.voiceDisplay)
    ? source.voiceDisplay
    : 'text';
  draft.aigcMeta = source.aigcMeta && typeof source.aigcMeta === 'object' && !Array.isArray(source.aigcMeta)
    ? source.aigcMeta
    : null;
  draft.cardExtensions = source.cardExtensions && typeof source.cardExtensions === 'object' && !Array.isArray(source.cardExtensions)
    ? source.cardExtensions
    : {};
  draft.cardExtra = source.cardExtra && typeof source.cardExtra === 'object' && !Array.isArray(source.cardExtra)
    ? source.cardExtra
    : {};
  return draft;
}

// 正向导入：把草稿变成可以 addCharacter 的角色结构。
// composedPrompt 由调用方用 cardParser 的 buildSystemPrompt 生成（这里保持零依赖）。
export function draftToCharacterPatch(draft, { composedPrompt = '', now = Date.now() } = {}) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const ownPrompt = preserveText(source.systemPrompt);
  return {
    id: `forge-${now.toString(36)}`,
    name: preserveText(source.name, 60) || '新角色',
    systemPrompt: ownPrompt,
    systemPromptComposed: preserveText(composedPrompt) || ownPrompt,
    description: preserveText(source.description),
    personality: preserveText(source.personality),
    scenario: preserveText(source.scenario),
    firstMes: preserveText(source.firstMes),
    alternateGreetings: Array.isArray(source.alternateGreetings)
      ? source.alternateGreetings.slice(0, MAX_PRESERVED_ITEMS)
      : [],
    mesExample: preserveText(source.mesExample),
    creatorNotes: preserveText(source.creatorNotes),
    postHistoryInstructions: preserveText(source.postHistoryInstructions),
    tags: Array.isArray(source.tags) ? source.tags.map(item => preserveText(item, 40)).filter(Boolean) : [],
    worldInfo: Array.isArray(source.worldInfo) ? source.worldInfo.slice(0, MAX_PRESERVED_ITEMS) : [],
    regexScripts: Array.isArray(source.regexScripts) ? source.regexScripts.slice(0, MAX_PRESERVED_ITEMS) : [],
    presets: Array.isArray(source.presets) ? source.presets.slice(0, MAX_PRESERVED_ITEMS) : [],
    avatarUri: preserveText(source.avatarUri, 2000),
    bgUri: preserveText(source.bgUri, 2000),
    voiceDisplay: ['text', 'voice-text', 'voice'].includes(source.voiceDisplay) ? source.voiceDisplay : 'text',
    cardExtensions: source.cardExtensions && typeof source.cardExtensions === 'object' && !Array.isArray(source.cardExtensions)
      ? source.cardExtensions
      : {},
    cardExtra: source.cardExtra && typeof source.cardExtra === 'object' && !Array.isArray(source.cardExtra)
      ? source.cardExtra
      : {},
    aigcMeta: source.aigcMeta && typeof source.aigcMeta === 'object' ? source.aigcMeta : null,
  };
}

export function hasCardContent(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  return FORGE_FIELDS.some(key => clean(source[key]).length > 0)
    || clean(source.systemPrompt).length > 0
    || (Array.isArray(source.alternateGreetings) && source.alternateGreetings.some(item => clean(item).length > 0))
    || (Array.isArray(source.worldInfo) && source.worldInfo.length > 0)
    || (Array.isArray(source.regexScripts) && source.regexScripts.length > 0)
    || (Array.isArray(source.presets) && source.presets.length > 0);
}

// ---- 单字段辅助生成（问题 2）----
// 制卡编辑器每个字段旁的「辅助生成」：用户描述想改的地方，模型只改写这一个字段。
export const FIELD_ASSIST_SYSTEM = '你是中文角色卡字段编辑助手，只输出改写后的字段内容本身，不输出任何解释、前后缀或代码块标记。';

export function buildFieldAssistPrompt({ fieldLabel = '', currentValue = '', request = '' } = {}) {
  const value = clean(currentValue, MAX_PRESERVED_TEXT);
  return [
    `请改写角色卡「${String(fieldLabel || '指定')}」字段的内容。`,
    '',
    `当前「${String(fieldLabel || '字段')}」内容：`,
    value || '（空）',
    '',
    `用户要求：${clean(request, 800) || '（空）'}`,
    '',
    '输出要求：',
    '- 只输出改写后的完整字段内容本身。',
    '- 不要任何解释、前后缀或代码块标记，不要输出 JSON。',
    '- 延续角色卡原有的设定、风格与语言。',
    '- 用户未提到的部分尽量保持原样。',
  ].filter(Boolean).join('\n');
}

export function parseFieldAssistText(raw) {
  const text = String(raw || '').trim().slice(0, MAX_PRESERVED_TEXT);
  if (!text) return null;
  const fenced = text.match(/```[^\n]*\n([\s\S]*?)```/);
  const stripped = String(fenced ? fenced[1] : text).trim();
  return stripped || null;
}

// ---- 集合与标签的辅助生成（问题：标签/世界书/正则/预设也要能 AI 改写）----

// 标签：纯文本输出协议（顿号分隔），沿用 parseFieldAssistText 解析
export function buildTagsAssistPrompt({ currentTags = [], request = '' } = {}) {
  const current = (Array.isArray(currentTags) ? currentTags : []).map(item => String(item || '')).filter(Boolean).join('、');
  return [
    '请按用户要求改写下面角色卡的标签。',
    '',
    `当前标签：${current || '（空）'}`,
    '',
    `用户要求：${clean(request, 800) || '（空）'}`,
    '',
    '输出要求：',
    '- 只输出标签本身，用顿号分隔，2 到 6 个。',
    '- 不要编号、解释、前后缀或代码块标记，不要输出 JSON。',
    '- 全部使用中文。',
  ].filter(Boolean).join('\n');
}

// 集合条目的可见字段白名单：辅助生成只改这些字段，其余（概率/扫描深度等）保留。
// 世界书放开 constant/position/depth，正则放开 flags/placement/markdownOnly/promptOnly——
// 否则模型输出的这些字段会被静默丢弃，用户「改了等于没改」。
const ENTRY_ASSIST_FIELDS = {
  worldInfo: ['comment', 'keys', 'content', 'constant', 'position', 'depth'],
  regexScripts: ['name', 'findRegex', 'replaceString', 'flags', 'placement', 'markdownOnly', 'promptOnly'],
  presets: ['name', 'prompt'],
};

const ENTRY_ASSIST_LABELS = {
  worldInfo: '世界书条目',
  regexScripts: '正则脚本',
  presets: '角色预设',
};

const ENTRY_ASSIST_TYPE_LINES = {
  worldInfo: '- 字段类型：comment/content 是字符串，keys 是字符串数组，constant 是布尔，position 是 0-7 的整数，depth 是整数。',
  regexScripts: '- 字段类型：name/findRegex/replaceString/flags 是字符串，placement 是只含 1/2 的数字数组，markdownOnly/promptOnly 是布尔。',
  presets: '- 字段类型：name/prompt 是字符串。',
};

const ENTRY_ASSIST_BOOLEAN_FIELDS = new Set(['constant', 'markdownOnly', 'promptOnly']);
const ENTRY_ASSIST_NUMBER_FIELDS = new Set(['position', 'depth']);

function projectEntryFields(entry, fields) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const projected = {};
  fields.forEach(field => {
    if (field === 'keys') {
      projected.keys = Array.isArray(source.keys) ? source.keys.map(item => String(item || '')) : [];
    } else if (field === 'placement') {
      projected.placement = Array.isArray(source.placement)
        ? source.placement.map(Number).filter(Number.isFinite)
        : [];
    } else if (ENTRY_ASSIST_BOOLEAN_FIELDS.has(field)) {
      projected[field] = source[field] === true;
    } else if (ENTRY_ASSIST_NUMBER_FIELDS.has(field)) {
      const value = Number(source[field]);
      projected[field] = Number.isFinite(value) ? value : (field === 'depth' ? 4 : 0);
    } else {
      projected[field] = String(source[field] || '');
    }
  });
  return projected;
}

export function buildEntryAssistPrompt({
  kind = '',
  currentEntry = {},
  request = '',
  characterContext = '',
  sampleText = '',
} = {}) {
  const fields = ENTRY_ASSIST_FIELDS[kind] || [];
  const label = ENTRY_ASSIST_LABELS[kind] || '条目';
  const context = String(characterContext || '').trim().slice(0, 600);
  const sample = String(sampleText || '').trim().slice(0, 2000);
  const lines = [`请按用户要求改写下面的${label}，只改需要改的字段。`];
  // 条目是孤立改写的，模型看不到角色卡；注入背景后内容才不会与角色脱节。
  if (context) {
    lines.push('', '角色卡背景（改写时必须与之保持一致）：', context);
  }
  lines.push(
    '',
    '当前条目 JSON：',
    JSON.stringify(projectEntryFields(currentEntry, fields)),
    '',
    `用户要求：${clean(request, 800) || '（空）'}`,
    '',
    '输出要求：',
    '- 只输出修改后的完整 JSON 对象，不要任何解释或代码块标记。',
    `- 只包含这些字段：${fields.join('、')}；不要新增或删除字段。`,
    '- 未修改的字段原样完整复制；用户没要求改动的字段必须原样保留，不要留空。',
    ENTRY_ASSIST_TYPE_LINES[kind] || '- 不要改动未提到的字段。',
  );
  // 世界书条目单独给字段语义与内容约定：否则模型常只给一句笼统概括，且不知道 constant/position 的作用。
  if (kind === 'worldInfo') {
    lines.push(
      '- comment 是简短标题；keys 是 2-4 个该条目最可能被提及的触发关键词；若用户抱怨条目不触发，优先检查 keys 是否过泛或过偏，换成具体的名词性关键词。',
      '- 字段语义：constant=true 表示常驻注入（每轮都生效，无需关键词命中）；position 0=角色定义之前、1=角色定义之后、4=按深度插入（配 depth）；content 写第三人称客观设定事实。',
      '- content 必须具体、可检索：写清「是什么、有哪些、彼此关系、规则或条件」，不要用一句话笼统概括。',
      '- 例如「魅魔等级制度」应写明有哪些等级、各等级的特征与权限、晋升条件与方式；「种族」应写明有哪些种族、各自特点与相互关系。',
      '- content 建议 80-200 字，信息密度高，避免空话与重复。'
    );
  }
  // 正则条目单独给 JS 方言写法约定：否则模型常按 PCRE 输出带斜杠/修饰符或转义错误的表达式，导入后跑不通。
  if (kind === 'regexScripts') {
    if (sample) {
      lines.push('', '需要匹配/处理的样本文本（正则必须与之匹配，输出匹配结果预览）：', sample);
    }
    lines.push(
      '- 运行环境是 JavaScript RegExp（不是 PCRE）。findRegex 是 JavaScript 正则的源码：不要带首尾斜杠与修饰符（如 /foo/g 应写成 findRegex:"foo"，修饰符写进 flags）。',
      '- 可用语法：字符类、量词、分组 (...)、引用分组；不要用 \\p{...}、(?P<name>...)、递归等非 JS 语法。',
      '- flags 默认 "g"；忽略大小写加 "i"（如 "gi"），跨行匹配加 "m" 或 "s"，不要写 "u"。',
      '- 正则元字符要正确转义（双反斜杠），替换用 $1/$2 引用分组、$& 引用整段匹配。',
      '- placement 决定作用对象：[1]=用户输入、[2]=AI 输出；markdownOnly 只影响展示、promptOnly 只影响发给模型的内容，二者最多一个为 true。',
      '- replaceString 可用 HTML 标签做高亮，留空字符串表示删除匹配内容。'
    );
  }
  lines.push('- 全部使用中文。');
  return lines.filter(Boolean).join('\n');
}

// 宽松解析条目辅助生成结果：容忍代码块包裹与前后多余文字，返回对象或 null
export function parseEntryAssistPatch(raw) {
  const text = String(raw || '').trim().slice(0, MAX_PRESERVED_TEXT);
  if (!text) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      // 尝试下一个候选
    }
  }
  return null;
}

// 把解析结果按白名单合并进条目：只接受声明的字段，并按字段类型校验（布尔/数字/数字数组）。
// 正则的 placement 改动会同步重算 placementLabel，保证派生字段与 UI 一致。
function normalizeAssistPlacement(value) {
  const list = Array.isArray(value) ? value : (value === null || value === undefined ? [] : [value]);
  const placement = list
    .map(item => Number(item))
    .filter(item => item === 1 || item === 2);
  return Array.from(new Set(placement));
}

export function mergeEntryAssistPatch(entry, kind, patch) {
  const base = entry && typeof entry === 'object' ? entry : {};
  const fields = ENTRY_ASSIST_FIELDS[kind] || [];
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const next = { ...base };
  fields.forEach(field => {
    if (field === 'keys') {
      const keys = Array.isArray(source.keys)
        ? source.keys.map(item => clean(item, 60)).filter(Boolean)
        : splitAssistList(source.keys);
      if (keys.length > 0) next.keys = keys;
    } else if (ENTRY_ASSIST_BOOLEAN_FIELDS.has(field)) {
      if (typeof source[field] === 'boolean') next[field] = source[field];
    } else if (field === 'position') {
      const value = Number(source[field]);
      if (Number.isInteger(value) && value >= 0 && value <= 7) next.position = value;
    } else if (field === 'depth') {
      const value = Number(source[field]);
      if (Number.isFinite(value)) next.depth = Math.trunc(value);
    } else if (field === 'placement') {
      const placement = normalizeAssistPlacement(source[field]);
      if (placement.length > 0) next.placement = placement;
    } else if (typeof source[field] === 'string' && source[field].trim()) {
      next[field] = clean(source[field], MAX_PRESERVED_TEXT);
    }
  });
  if (kind === 'worldInfo' && next.position !== base.position) {
    next.positionLabel = WORLD_POSITION_LABELS[next.position];
  }
  if (kind === 'regexScripts' && Array.isArray(next.placement) && next.placement.length > 0) {
    next.placementLabel = next.placement.map(key => REGEX_PLACEMENT_LABELS[key] || `范围 ${key}`).join('、');
  }
  return next;
}

function splitAssistList(value) {
  return String(value || '')
    .split(/[、,，]+/)
    .map(item => clean(item, 60))
    .filter(Boolean);
}
