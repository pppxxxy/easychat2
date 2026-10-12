// Local normalization of generated world entries, regex scripts and presets.

import {
  WORLD_POSITION_LABELS,
  REGEX_PLACEMENT_LABELS,
  MAX_PRESERVED_ITEMS,
  ENTRY_KEYS_MAX_COUNT,
  collapseOnlyFlags,
  clean,
  entryFieldLimit,
  preserveText,
} from './shared.js';
// 危险正则筛查必须复用聊天引擎那一份启发式，不能在这里另写一份：
// 两份实现一旦漂移，就会出现「制卡说安全、聊天里被静默跳过」的分裂。
// 注意方向：这里只读它的纯函数 isUnsafeRegexPattern，不碰 src/prompt/** 的任何文件。
import { isUnsafeRegexPattern } from '../../prompt/regexEngine.js';

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

function toStringList(value, field = 'keys') {
  const maxChars = entryFieldLimit('worldInfo', field);
  if (Array.isArray(value)) {
    return value.map(item => clean(item, maxChars)).filter(Boolean).slice(0, ENTRY_KEYS_MAX_COUNT);
  }
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/[,，\n]/)
    .map(item => clean(item, maxChars))
    .filter(Boolean)
    .slice(0, ENTRY_KEYS_MAX_COUNT);
}

// depth 的口径照抄参考实现 src/character/cardParser/normalizeUtils.js 的 firstNumber：
// null / undefined / '' 一律算「模型没给」，回落默认 4；否则 Number() 之后必须是有限数。
// 旧写法 `Math.trunc(Number(source.depth))` 把 null 变成 0 且照样通过 Number.isFinite，
// 于是模型给 {"position":4,"depth":null} 时存成 0，chatPipeline 会把条目注入到最末
// 一条消息旁边，而不是提示词里承诺的「倒数第 4 条」。
function normalizeWorldDepth(value) {
  if (value === null || value === undefined || value === '') return 4;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 4;
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

export function sanitizeWorldEntry(item, index) {
  const source = item && typeof item === 'object' ? item : { content: String(item == null ? '' : item) };
  const keys = toStringList(source.keys ?? source.key ?? source.keywords ?? source.keyword, 'keys');
  const secondaryKeys = toStringList(source.secondaryKeys ?? source.secondary_keys, 'secondaryKeys');
  const content = preserveText(source.content ?? source.value ?? source.text ?? '');
  // 「实质为空」= 既没有可注入的内容、也没有任何触发关键词（含次要关键词）。
  // 这种条目入库后永远不会生效——引擎要么按关键词命中注入，要么 constant 常驻注入
  // 空内容——属于「看着生成了、实际永远不生效」的静默空条目。口径与 sanitizePreset
  // 的空 prompt → null 统一（问题 G），由 sanitizeAdvancedArray 统一滤掉。
  if (!content.trim() && keys.length === 0 && secondaryKeys.length === 0) return null;
  const position = normalizeWorldPositionValue(source.position);
  return {
    id: `forge-entry-${index + 1}`,
    comment: clean(source.comment ?? source.name ?? source.title, entryFieldLimit('worldInfo', 'comment')) || `世界书条目 ${index + 1}`,
    keys,
    secondaryKeys,
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
    depth: normalizeWorldDepth(source.depth),
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

export function sanitizeRegexScript(item, index) {
  const source = item && typeof item === 'object' ? item : { findRegex: String(item == null ? '' : item) };
  const findRegex = preserveText(source.findRegex ?? source.regex ?? source.pattern ?? '');
  // 空 findRegex 的脚本会被引擎直接跳过（regexEngine.js 的 `if (!script.findRegex) continue`），
  // 入库后永远不生效，同样是「看着生成了、实际永远不生效」的静默空条目 →
  // 与 sanitizePreset 口径统一，返回 null 丢弃（问题 G）。
  if (!findRegex.trim()) return null;
  const placement = sanitizeRegexPlacement(source.placement ?? source.placements ?? source.scope);
  // 两个 Only 开关互斥收口（问题 B）：both-true 在引擎里等价于 both-false，
  // 即「慎用」的全量生效，会让本应只改展示的正则开始改发给模型的内容。
  const only = collapseOnlyFlags({
    markdownOnly: source.markdownOnly === true,
    promptOnly: source.promptOnly === true,
  });
  return {
    id: `forge-regex-${index + 1}`,
    name: clean(source.name ?? source.title, entryFieldLimit('regexScripts', 'name')) || `正则脚本 ${index + 1}`,
    findRegex,
    replaceString: preserveText(source.replaceString ?? source.replacement ?? source.replace ?? ''),
    flags: clean(source.flags, entryFieldLimit('regexScripts', 'flags')) || 'g',
    placement,
    placementLabel: placement.map(key => REGEX_PLACEMENT_LABELS[key]).join('、'),
    enabled: source.enabled !== false,
    markdownOnly: only.markdownOnly === true,
    promptOnly: only.promptOnly === true,
    // 危险正则筛查（问题 A）：复用 prompt/regexEngine.js 的 isUnsafeRegexPattern。
    // 引擎对灾难性回溯模式是直接 continue（regexEngine.js 里那一行），也就是
    // 「入库了但聊天里永远静默不生效」。这里把它标出来交给编辑器做可见告警，
    // 而不是静默入库（丢弃会让用户连改的机会都没有）。
    unsafe: isUnsafeRegexPattern(findRegex),
    minDepth: null,
    maxDepth: null,
  };
}

export function sanitizePreset(item, index) {
  const source = typeof item === 'string'
    ? { prompt: item }
    : (item && typeof item === 'object' ? item : {});
  const prompt = preserveText(source.prompt ?? source.content ?? source.text ?? '');
  if (!prompt.trim()) return null;
  return {
    id: `forge-preset-${index + 1}`,
    name: clean(source.name ?? source.title, entryFieldLimit('presets', 'name')) || `预设 ${index + 1}`,
    description: clean(source.description ?? source.note, entryFieldLimit('presets', 'description')),
    prompt,
    enabled: source.enabled !== false,
  };
}

export function sanitizeAdvancedArray(value, sanitizer) {
  if (!Array.isArray(value)) return null;
  const list = value
    .map((item, index) => sanitizer(item, index))
    .filter(Boolean)
    .slice(0, MAX_PRESERVED_ITEMS);
  return list.length > 0 ? list : null;
}
