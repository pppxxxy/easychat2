// 世界书条目（character_book / worldbook / lorebook）的归一化。纯函数。
import {
  firstNumber,
  firstString,
  isPlainObject,
  numberOrNull,
  toBool,
  toStringArray,
} from './normalizeUtils.js';

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

const WORLD_ROLE_LABELS = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
};

function normalizeWorldPosition(value) {
  let numeric = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    numeric = value;
  } else if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (WORLD_POSITION_ALIASES[lowered] !== undefined) {
      numeric = WORLD_POSITION_ALIASES[lowered];
    } else {
      const parsed = Number(lowered);
      if (Number.isFinite(parsed)) numeric = parsed;
    }
  }
  if (numeric === null || WORLD_POSITION_LABELS[numeric] === undefined) {
    numeric = 0;
  }
  return { position: numeric, positionLabel: WORLD_POSITION_LABELS[numeric] };
}

function normalizeWorldRole(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return WORLD_ROLE_LABELS.user;
    if (value === 2) return WORLD_ROLE_LABELS.assistant;
    return WORLD_ROLE_LABELS.system;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (WORLD_ROLE_LABELS[lowered]) return WORLD_ROLE_LABELS[lowered];
  }
  return WORLD_ROLE_LABELS.system;
}

function normalizeWorldEntry(entry, index) {
  const source = isPlainObject(entry)
    ? entry
    : { content: String(entry == null ? '' : entry) };
  const extensions = isPlainObject(source.extensions) ? source.extensions : {};
  const keys = toStringArray(
    source.keys ?? source.key ?? source.keywords ?? source.keyword ?? source.trigger ?? source.triggers
  );
  const secondaryKeys = toStringArray(
    source.secondary_keys ?? source.secondaryKeys ?? source.keysecondary ?? source.secondaryKeywords
  );
  const comment = firstString(
    [source, extensions],
    ['comment', 'name', 'title', 'label']
  );
  const content = firstString(
    [source, extensions],
    ['content', 'value', 'entry', 'text', 'prompt', 'description']
  );
  const { position, positionLabel } = normalizeWorldPosition(
    source.position ?? extensions.position
  );
  const rawId = source.uid ?? source.id ?? source.displayIndex;
  // SillyTavern 把 depth / probability / scan_depth 放在 extensions 里，
  // 只读顶层会把这些值静默重置为默认值。
  const depth = firstNumber([source, extensions], ['depth'], 4);
  const probability = firstNumber([source, extensions], ['probability'], 100);
  const scanDepth = numberOrNull(
    source.scanDepth ?? source.scan_depth ?? extensions.scanDepth ?? extensions.scan_depth
  );
  return {
    id: rawId === null || rawId === undefined ? `entry-${index}` : String(rawId),
    comment: comment || `世界书条目 ${index + 1}`,
    keys,
    secondaryKeys,
    content,
    constant: toBool(source.constant ?? source.always, false),
    // 与 SillyTavern 保持一致：selective 默认 false（次要关键词默不生效），
    // useRegex 默认 false（关键词按字面量匹配）。此前默认 true 会让普通关键词
    // 被当正则编译：'(' 这类语法非法的键永久静默失效，'C++'、'1.5' 这类
    // 语法合法但语义不同的键则会匹配错乱。
    // 需要正则的卡片可显式写 use_regex: true，或用 /pattern/flags 写法（lorebook 会自动识别）。
    selective: toBool(source.selective ?? source.conditional, false),
    enabled: source.enabled === undefined
      ? !(source.disabled === true || source.disabled === 'true')
      : toBool(source.enabled, true),
    useRegex: toBool(source.use_regex ?? source.useRegex, false),
    caseSensitive: toBool(source.caseSensitive ?? source.case_sensitive, false),
    matchWholeWords: toBool(
      source.matchWholeWords
      ?? source.match_whole_words
      ?? extensions.matchWholeWords
      ?? extensions.match_whole_words,
      false
    ),
    position,
    positionLabel,
    role: normalizeWorldRole(source.role ?? extensions.role),
    order: firstNumber(
      [source],
      ['insertion_order', 'insertionOrder', 'order'],
      100
    ),
    depth,
    probability,
    useProbability: toBool(
      source.useProbability
      ?? source.use_probability
      ?? extensions.useProbability
      ?? extensions.use_probability,
      true
    ),
    scanDepth,
    boundary: String(source.boundary ?? extensions.boundary ?? ''),
  };
}

function normalizeEntriesContainer(container) {
  if (Array.isArray(container)) return container;
  if (!isPlainObject(container)) return [];
  if (Array.isArray(container.entries)) return container.entries;
  if (isPlainObject(container.entries)) return normalizeEntriesContainer(container.entries);
  if (Array.isArray(container.items)) return container.items;
  if (isPlainObject(container.items)) return normalizeEntriesContainer(container.items);
  if (isPlainObject(container.book)) return normalizeEntriesContainer(container.book);
  if (isPlainObject(container.worldbook)) return normalizeEntriesContainer(container.worldbook);
  if (isPlainObject(container.world_info)) return normalizeEntriesContainer(container.world_info);
  if (
    'content' in container ||
    'value' in container ||
    'entry' in container ||
    'text' in container ||
    'keys' in container ||
    'key' in container
  ) {
    return [container];
  }
  const values = Object.values(container);
  const nested = values.filter(Array.isArray).flat();
  const objects = values.filter(isPlainObject);
  if (nested.length > 0) return nested;
  if (
    objects.length > 0 &&
    objects.some(
      item => 'content' in item || 'value' in item || 'text' in item || 'keys' in item || 'key' in item
    )
  ) {
    return objects;
  }
  return [];
}

function extractWorldInfo(root, data) {
  const candidates = [
    data?.character_book,
    root?.character_book,
    data?.worldbook,
    data?.world_book,
    data?.worldBook,
    data?.worldbook_entries,
    data?.worldBookEntries,
    data?.worldInfo,
    data?.world_info,
    data?.agent_worldbook,
    data?.agent_world_book,
    data?.agentWorldbook,
    data?.agent_world_info,
    data?.agentWorldInfo,
    data?.lorebook,
    data?.lore_book,
    root?.worldbook,
    root?.world_book,
    root?.worldBook,
    root?.worldbook_entries,
    root?.worldBookEntries,
    root?.worldInfo,
    root?.world_info,
    root?.agent_worldbook,
    root?.agent_world_book,
    root?.agentWorldbook,
    root?.agent_world_info,
    root?.agentWorldInfo,
    root?.lorebook,
    root?.lore_book,
    data?.extensions?.worldInfo,
    root?.extensions?.worldInfo,
    data?.extensions?.worldbook,
    root?.extensions?.worldbook,
  ];
  for (const candidate of candidates) {
    const entries = normalizeEntriesContainer(candidate);
    if (entries.length > 0) {
      return entries.map(normalizeWorldEntry);
    }
  }
  return [];
}

export function createWorldEntry(partial = {}, index = 0) {
  return normalizeWorldEntry(partial, index);
}

export { extractWorldInfo, normalizeWorldEntry };
