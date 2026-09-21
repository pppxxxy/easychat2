import { readJsonFromPNG } from 'parsecard';
import { Buffer } from 'buffer';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

const WORLD_ROLE_LABELS = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstString(sources, keys) {
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of keys) {
      const value = source[key];
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item ?? '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，\n]/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

function firstNumber(sources, keys, fallback) {
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of keys) {
      const raw = source[key];
      if (raw === null || raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

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
  const source = isPlainObject(entry) ? entry : {};
  const extensions = isPlainObject(source.extensions) ? source.extensions : {};
  const keys = toStringArray(source.keys ?? source.key ?? source.keywords);
  const secondaryKeys = toStringArray(
    source.secondary_keys ?? source.secondaryKeys ?? source.keysecondary
  );
  const comment = firstString([source, extensions], ['comment', 'name', 'title']);
  const content = firstString([source], ['content', 'value', 'entry']);
  const { position, positionLabel } = normalizeWorldPosition(
    source.position ?? extensions.position
  );
  const rawId = source.uid ?? source.id ?? source.displayIndex;
  return {
    id: rawId === null || rawId === undefined ? `entry-${index}` : String(rawId),
    comment: comment || `世界书条目 ${index + 1}`,
    keys,
    secondaryKeys,
    content,
    constant: toBool(source.constant, false),
    // 与 SillyTavern 保持一致：selective 默认 false（次要关键词默不生效），
    // useRegex 默认 false（关键词按字面量匹配）。此前默认 true 会让普通关键词
    // 被当正则编译：'(' 这类语法非法的键永久静默失效，'C++'、'1.5' 这类
    // 语法合法但语义不同的键则会匹配错乱。
    // 需要正则的卡片可显式写 use_regex: true，或用 /pattern/flags 写法（lorebook 会自动识别）。
    selective: toBool(source.selective, false),
    enabled: source.enabled === undefined ? true : toBool(source.enabled, true),
    useRegex: toBool(source.use_regex ?? source.useRegex, false),
    caseSensitive: toBool(source.caseSensitive ?? source.case_sensitive, false),
    matchWholeWords: toBool(source.matchWholeWords ?? source.match_whole_words, false),
    position,
    positionLabel,
    role: normalizeWorldRole(source.role ?? extensions.role),
    order: firstNumber(
      [source],
      ['insertion_order', 'insertionOrder', 'order'],
      100
    ),
    depth: firstNumber([source], ['depth'], 4),
    probability: firstNumber([source], ['probability'], 100),
    useProbability: toBool(source.useProbability ?? source.use_probability, true),
    scanDepth: numberOrNull(source.scanDepth ?? source.scan_depth),
  };
}

function normalizeRegexPlacement(value) {
  let list = [];
  if (typeof value === 'number') {
    list = [value];
  } else if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string' && value.trim()) {
    list = value.split(/[,，\s]+/);
  }
  const placement = list
    .map(item => Number(item))
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
  const source = isPlainObject(script) ? script : {};
  const placement = normalizeRegexPlacement(source.placement);
  const disabled = source.disabled === undefined ? false : toBool(source.disabled, false);
  const enabled = source.enabled === undefined ? !disabled : toBool(source.enabled, true);
  const rawId = source.id ?? source.uid;
  return {
    id: rawId === null || rawId === undefined ? `regex-${index}` : String(rawId),
    name:
      firstString([source], ['name', 'scriptName', 'script_name']) ||
      `正则脚本 ${index + 1}`,
    findRegex: firstRegexString(source, ['regex', 'findRegex', 'find_regex']),
    replaceString: firstRegexString(
      source,
      ['replacement', 'replaceString', 'replace_string']
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

function normalizeEntriesContainer(container) {
  if (Array.isArray(container)) return container;
  if (!isPlainObject(container)) return [];
  if (Array.isArray(container.entries)) return container.entries;
  const values = Object.values(container).filter(isPlainObject);
  if (
    values.length > 0 &&
    values.some(
      item => 'content' in item || 'keys' in item || 'key' in item
    )
  ) {
    return values;
  }
  return [];
}

function extractWorldInfo(root, data) {
  const candidates = [
    data?.character_book,
    root?.character_book,
    data?.worldInfo,
    data?.world_info,
    root?.worldInfo,
    root?.world_info,
    data?.extensions?.worldInfo,
    root?.extensions?.worldInfo,
  ];
  for (const candidate of candidates) {
    const entries = normalizeEntriesContainer(candidate);
    if (entries.length > 0) {
      return entries.map(normalizeWorldEntry);
    }
  }
  return [];
}

function normalizeRegexContainer(container) {
  if (Array.isArray(container)) return container;
  if (!isPlainObject(container)) return [];
  return Object.values(container).filter(
    item =>
      isPlainObject(item) &&
      ('regex' in item ||
        'findRegex' in item ||
        'replaceString' in item ||
        'replacement' in item ||
        'scriptName' in item)
  );
}

function extractRegexScripts(root, data) {
  const candidates = [
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

function extractStandardFields(root, data, extensions) {
  return {
    name: firstString([data, root], ['name', 'char_name', 'charName']),
    description: firstString(
      [data, root],
      ['description', 'char_persona', 'charPersona']
    ),
    personality: firstString([data, root], ['personality', 'char_personality']),
    scenario: firstString(
      [data, root],
      ['scenario', 'world_scenario', 'worldScenario']
    ),
    firstMes: firstString(
      [data, root],
      ['first_mes', 'firstMes', 'first_message']
    ),
    alternateGreetings: toStringArray(
      data?.alternate_greetings ?? root?.alternate_greetings ?? data?.alternateGreetings
    ),
    mesExample: firstString(
      [data, root],
      ['mes_example', 'mesExample', 'example_dialogue', 'exampleMessages']
    ),
    creatorNotes: firstString(
      [data, root, extensions],
      ['creator_notes', 'creatorNotes', 'creator_comment', 'creatorcomment']
    ),
    systemPrompt: firstString([data, root], ['system_prompt', 'systemPrompt']),
    postHistoryInstructions: firstString(
      [data, root],
      ['post_history_instructions', 'postHistoryInstructions']
    ),
    tags: toStringArray(data?.tags ?? root?.tags),
  };
}

export function buildSystemPrompt(fields) {
  const sections = [
    ['角色描述', fields.description],
    ['性格', fields.personality],
    ['场景', fields.scenario],
    ['系统提示', fields.systemPrompt],
    ['历史后指令', fields.postHistoryInstructions],
  ];
  return sections
    .filter(([, text]) => text && text.trim())
    .map(([label, text]) => `[${label}]\n${text.trim()}`)
    .join('\n\n');
}

export function ensureUniqueIds(items, prefix) {
  const seen = new Set();
  return items.map((item, index) => {
    let id = String(item.id);
    if (seen.has(id)) {
      let candidate = `${prefix}-${index}`;
      let bump = index;
      while (seen.has(candidate)) {
        bump += 1;
        candidate = `${prefix}-${index}-${bump}`;
      }
      id = candidate;
    }
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

export function normalizeCard(raw) {
  const source = Array.isArray(raw) ? raw.find(isPlainObject) : raw;
  if (!isPlainObject(source)) {
    throw new Error('角色卡内容不是有效的对象。');
  }
  const data = isPlainObject(source.data) ? source.data : {};
  const extensions = isPlainObject(data.extensions)
    ? data.extensions
    : isPlainObject(source.extensions)
      ? source.extensions
      : {};
  const fields = extractStandardFields(source, data, extensions);
  const worldInfo = ensureUniqueIds(extractWorldInfo(source, data), 'entry');
  const regexScripts = ensureUniqueIds(extractRegexScripts(source, data), 'regex');
  return {
    name: fields.name,
    fields,
    systemPrompt: buildSystemPrompt(fields),
    worldInfo,
    regexScripts,
  };
}

export function parseCardFromJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 语法错误：${error.message}`);
  }
  return normalizeCard(raw);
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.length === 'number') return Uint8Array.from(input);
  return new Uint8Array(0);
}

function isPng(data) {
  if (data.length < 8) return false;
  return PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

function readUint32(data, offset) {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

function decodeBase64(base64) {
  return Buffer.from(String(base64).replace(/\s+/g, ''), 'base64').toString('utf8');
}

function readTextChunkBase64(data, keyword) {
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = readUint32(data, offset);
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) {
      throw new Error(`PNG 数据损坏：${type} 块长度异常`);
    }
    if (type === 'tEXt') {
      const separator = data.indexOf(0x00, start);
      if (separator !== -1 && separator < end) {
        const key = Buffer.from(data.slice(start, separator)).toString('utf8');
        if (key === keyword) {
          return Buffer.from(data.slice(separator + 1, end)).toString('utf8');
        }
      }
    } else if (type === 'iTXt') {
      const separator = data.indexOf(0x00, start);
      if (separator !== -1 && separator + 2 < end) {
        const key = Buffer.from(data.slice(start, separator)).toString('utf8');
        const compressionFlag = data[separator + 1];
        if (key === keyword && compressionFlag === 0) {
          const languageEnd = data.indexOf(0x00, separator + 3);
          if (languageEnd !== -1) {
            const translatedEnd = data.indexOf(0x00, languageEnd + 1);
            if (translatedEnd !== -1 && translatedEnd < end) {
              return Buffer.from(data.slice(translatedEnd + 1, end)).toString('utf8');
            }
          }
        }
      }
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  return null;
}

function readFallbackJsonFromPng(bytes) {
  const data = toUint8Array(bytes);
  if (!isPng(data)) {
    throw new Error('不是合法的 PNG 文件：签名不匹配');
  }
  for (const keyword of ['ccv3', 'chara']) {
    const base64 = readTextChunkBase64(data, keyword);
    if (base64) {
      try {
        return decodeBase64(base64);
      } catch (error) {
        throw new Error(`解码 PNG 中的 base64 数据失败：${error.message}`);
      }
    }
  }
  return null;
}

export function readCardJsonFromPng(bytes) {
  let primaryError = null;
  try {
    const text = readJsonFromPNG(toUint8Array(bytes));
    if (text) return text;
  } catch (error) {
    primaryError = error;
  }
  const fallback = readFallbackJsonFromPng(bytes);
  if (fallback) return fallback;
  if (primaryError) throw primaryError;
  return null;
}

export function parseCardFromPng(bytes) {
  const jsonText = readCardJsonFromPng(bytes);
  if (!jsonText) return null;
  return parseCardFromJson(jsonText);
}

export function createWorldEntry(partial = {}, index = 0) {
  return normalizeWorldEntry(partial, index);
}

export function createRegexScript(partial = {}, index = 0) {
  return normalizeRegexScript(partial, index);
}

export { WORLD_POSITION_LABELS, REGEX_PLACEMENT_LABELS };
