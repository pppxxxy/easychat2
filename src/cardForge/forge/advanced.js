// Local normalization of generated world entries, regex scripts and presets.

import { WORLD_POSITION_LABELS, REGEX_PLACEMENT_LABELS, MAX_PRESERVED_ITEMS, clean, preserveText } from './shared.js';

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

export function sanitizeWorldEntry(item, index) {
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

export function sanitizeRegexScript(item, index) {
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

export function sanitizePreset(item, index) {
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

export function sanitizeAdvancedArray(value, sanitizer) {
  if (!Array.isArray(value)) return null;
  const list = value
    .map((item, index) => sanitizer(item, index))
    .filter(Boolean)
    .slice(0, MAX_PRESERVED_ITEMS);
  return list.length > 0 ? list : null;
}
