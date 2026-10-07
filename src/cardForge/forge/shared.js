// Shared field definitions, preservation limits and text helpers.

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

export function clean(value, max = MAX_FIELD_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

export function preserveText(value, max = MAX_PRESERVED_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
}
