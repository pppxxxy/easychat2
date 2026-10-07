// Field, tag and collection-entry assistance prompts, parsing and merging.

import { WORLD_POSITION_LABELS, REGEX_PLACEMENT_LABELS, MAX_PRESERVED_TEXT, clean } from './shared.js';

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
