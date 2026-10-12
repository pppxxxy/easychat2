// Shared field definitions, preservation limits and text helpers.

// 制卡请求共用的系统提示词与采样参数。原本只写在 CardForgeScreen.js 里，
// 「从对话生成角色卡」是第二条制卡入口，两处各写一份必然漂移（字段规则、
// 温度、maxTokens 一旦不一致，同一张卡在不同入口的表现就会不同），故上提到此。
export const FORGE_SYSTEM = '你是中文角色卡撰写与编辑助手，严格遵守输出格式要求，只输出要求的 JSON。';

// 制卡请求用独立采样：低温提高 JSON 稳定性，大 max_tokens 避免长 JSON 被截断。
// 仅覆盖本次请求（api.mergeSamplingOverrides），不写回设置、不影响全局聊天采样。
export const FORGE_SAMPLING_OVERRIDES = { temperature: 0.3, maxTokens: 8192 };

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

// ---- 高级内容的本地清洗：forge 保持零依赖，不引入 cardParser，仅产出与
// normalizeWorldEntry / normalizeRegexScript / characterPresets 一致的结构 ----
export const WORLD_POSITION_LABELS = {
  0: '角色定义之前',
  1: '角色定义之后',
  2: '作者注释之前',
  3: '作者注释之后',
  4: '按深度插入',
  5: '示例消息前',
  6: '示例消息后',
  7: '锚点',
};

export const REGEX_PLACEMENT_LABELS = {
  1: '用户输入',
  2: 'AI 输出',
  3: '快捷命令',
  5: '世界信息',
  6: '推理',
};

const MAX_FIELD_TEXT = 4000;

export const MAX_PRESERVED_TEXT = 500000;

export const MAX_PRESERVED_ITEMS = 2000;

// 标签上限全流程统一：草稿导入、提示词投影、模型补丁解析、合并与编辑器 UI 共用同一常量，
// 避免导入时保留 2000 个、AI 往返却静默截断到 10 个的往返丢失。
export const MAX_FORGE_TAG_COUNT = 100;

// ---- 高级内容字段的「字段 → 上限」单一来源（问题 D）----
//
// 两条写入路径过去各写一套上限：模型生成/保存路径（advanced.js 的三个 sanitizer）
// comment/name 限 120、flags 限 10，而条目辅助生成路径（assist.js 的
// mergeEntryAssistPatch）对任何字符串字段一律按 MAX_PRESERVED_TEXT 截断——
// 于是「辅助生成」能落一条 50 万字的 comment，同名字段在两条路径上上限完全不同。
// 上限一旦分散在两个文件里就必然漂移，故合并成这一张表：advanced.js（生成/保存清洗）、
// assist.js（条目辅助合并）以及 storage 侧的保存清洗都查它。
export const ENTRY_FIELD_LIMITS = {
  worldInfo: {
    comment: 120,
    content: MAX_PRESERVED_TEXT,
    keys: 200,
    secondaryKeys: 200,
  },
  regexScripts: {
    name: 120,
    findRegex: MAX_PRESERVED_TEXT,
    replaceString: MAX_PRESERVED_TEXT,
    flags: 10,
  },
  presets: {
    name: 120,
    description: 300,
    prompt: MAX_PRESERVED_TEXT,
  },
};

// 关键词条数上限：advanced.js 的 toStringList 与 assist.js 的 splitAssistList 共用，
// 避免一处切 50 个、另一处不限（提示词要求 2-4 个，但用户手改不受此限）。
export const ENTRY_KEYS_MAX_COUNT = 50;

// 查表取字段上限。表里没登记的字段回退到调用方给的默认值，
// 而不是静默变成 0 长度（那会把内容整段清空，比截断更糟）。
export function entryFieldLimit(kind, field, fallback = MAX_PRESERVED_TEXT) {
  const table = ENTRY_FIELD_LIMITS[kind];
  const limit = table ? table[field] : undefined;
  return typeof limit === 'number' && limit > 0 ? limit : fallback;
}

// ---- markdownOnly / promptOnly 互斥收口（问题 B）----
//
// 两个开关都独立写在辅助生成的白名单里，模型（或手改）很容易同时给 true。
// 而引擎的判定是「mode==='prompt' 时跳过 markdownOnly 且非 promptOnly」
// 「mode==='display' 时跳过 promptOnly 且非 markdownOnly」——两个 skip 条件
// 都不成立，等于两边都生效，与 both-false 完全等价（正是 prompts.js 里标注
// 「慎用」的那种全量生效）。本应只改展示的正则因此开始改发给模型的内容。
// 两条写入路径（advanced.js 的生成清洗、assist.js 的条目辅助合并）共用这一个
// 收口函数：只堵住其中一条等于没堵。
export function collapseOnlyFlags(next, base = {}) {
  if (!next || next.markdownOnly !== true || next.promptOnly !== true) return next;
  // 优先保留「原本就为 true」的那个（尊重用户/上一轮的显式选择）；
  // 两个都不是（或原本两个都是）时保留 markdownOnly——它只影响界面展示、
  // 不改变发给模型的内容，是两种误判里代价更小的一种。
  const keepMarkdownOnly = base.markdownOnly === true || base.promptOnly !== true;
  return { ...next, markdownOnly: keepMarkdownOnly, promptOnly: !keepMarkdownOnly };
}

export function clean(value, max = MAX_FIELD_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

export function preserveText(value, max = MAX_PRESERVED_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
}
