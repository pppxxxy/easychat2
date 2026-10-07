// Draft defaults, model projection and loss-preserving character conversion.

import { FORGE_FIELDS, MAX_PRESERVED_ITEMS, MAX_FORGE_TAG_COUNT, clean, preserveText } from './shared.js';

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
