// 正则脚本（regex_scripts）的归一化。纯函数。
import { firstString, isPlainObject, numberOrNull, toBool } from './normalizeUtils.js';

export const REGEX_PLACEMENT_LABELS = {
  1: '用户输入',
  2: 'AI 输出',
  3: '快捷命令',
  5: '世界信息',
  6: '推理',
};

function normalizeRegexPlacement(value) {
  let list = [];
  if (typeof value === 'number' || typeof value === 'string') {
    list = [value];
  } else if (Array.isArray(value)) {
    list = value;
  }
  const aliases = {
    user: 1,
    input: 1,
    ai: 2,
    output: 2,
    world: 5,
    world_info: 5,
    reasoning: 6,
  };
  const placement = list
    .map(item => {
      const key = String(item || '').trim().toLowerCase();
      return aliases[key] ?? (key ? Number(item) : NaN);
    })
    .filter(item => Number.isFinite(item));
  if (Array.isArray(value) && value.length === 0) return [];
  if (placement.length === 0) return [1, 2];
  return Array.from(new Set(placement));
}

function placementLabel(placement) {
  return placement
    .map(item => REGEX_PLACEMENT_LABELS[item] || `范围 ${item}`)
    .join('、');
}

function firstRegexString(source, keys, fallback = '') {
  for (const key of keys) {
    if (source[key] !== null && source[key] !== undefined) return String(source[key]);
  }
  return fallback;
}

function normalizeRegexScript(script, index) {
  const source = isPlainObject(script)
    ? script
    : { regex: String(script == null ? '' : script) };
  const placement = normalizeRegexPlacement(
    source.placement ?? source.placements ?? source.scope ?? source.scopes ?? source.targets
  );
  const disabled = source.disabled === undefined ? false : toBool(source.disabled, false);
  const enabled = source.enabled === undefined ? !disabled : toBool(source.enabled, true);
  const rawId = source.id ?? source.uid ?? source.key;
  return {
    id: rawId === null || rawId === undefined ? `regex-${index}` : String(rawId),
    name:
      firstString([source], ['name', 'scriptName', 'script_name', 'title', 'label']) ||
      `正则脚本 ${index + 1}`,
    findRegex: firstRegexString(
      source,
      ['regex', 'findRegex', 'find_regex', 'pattern', 'match', 'search', 'find']
    ),
    replaceString: firstRegexString(
      source,
      ['replacement', 'replaceString', 'replace_string', 'replace', 'substitute']
    ),
    flags: firstRegexString(source, ['flags', 'regexFlags', 'regex_flags'], 'g'),
    placement,
    placementLabel: placementLabel(placement),
    enabled,
    markdownOnly: toBool(source.markdownOnly ?? source.markdown_only, false),
    promptOnly: toBool(source.promptOnly ?? source.prompt_only, false),
    minDepth: numberOrNull(source.minDepth ?? source.min_depth),
    maxDepth: numberOrNull(source.maxDepth ?? source.max_depth),
  };
}

function normalizeRegexContainer(container) {
  if (Array.isArray(container)) return container;
  if (!isPlainObject(container)) return [];
  if (Array.isArray(container.scripts)) return container.scripts;
  if (isPlainObject(container.scripts)) return normalizeRegexContainer(container.scripts);
  if (Array.isArray(container.items)) return container.items;
  if (isPlainObject(container.items)) return normalizeRegexContainer(container.items);
  if (Array.isArray(container.regexes)) return container.regexes;
  if (isPlainObject(container.regexes)) return normalizeRegexContainer(container.regexes);
  if (
    'regex' in container ||
    'findRegex' in container ||
    'find_regex' in container ||
    'pattern' in container ||
    'replaceString' in container ||
    'replace_string' in container ||
    'replace' in container ||
    'replacement' in container
  ) {
    return [container];
  }
  return Object.values(container).filter(
    item =>
      isPlainObject(item) &&
      ('regex' in item ||
        'findRegex' in item ||
        'find_regex' in item ||
        'pattern' in item ||
        'replaceString' in item ||
        'replace_string' in item ||
        'replace' in item ||
        'replacement' in item ||
        'scriptName' in item)
  );
}

function extractRegexScripts(root, data) {
  const candidates = [
    data?.agent_regex,
    data?.agentRegex,
    data?.agent_regexes,
    root?.agent_regex,
    root?.agentRegex,
    root?.agent_regexes,
    data?.extensions?.regex_scripts,
    data?.extensions?.regexScripts,
    root?.extensions?.regex_scripts,
    root?.extensions?.regexScripts,
    data?.regexScripts,
    data?.regex_scripts,
    root?.regexScripts,
    root?.regex_scripts,
  ];
  for (const candidate of candidates) {
    const scripts = normalizeRegexContainer(candidate);
    if (scripts.length > 0) {
      return scripts.map(normalizeRegexScript);
    }
  }
  return [];
}

export function createRegexScript(partial = {}, index = 0) {
  return normalizeRegexScript(partial, index);
}

export { extractRegexScripts, normalizeRegexScript };
