// 角色卡导入/解析与表单态纯函数。从 src/CharacterScreen.js 原样外提（无行为变化）。
// 不含 React：只依赖 cardParser 的 ID 工具、buildSystemPrompt 与 i18n 取词
// （i18n/index.js 是零依赖纯逻辑，Node 可直测），便于单测。

import {
  buildSystemPrompt,
  ensureUniqueIds,
} from './cardParser.js';
import { MEMORY_SUMMARY_PREFIX } from '../memory/memoryConstants.js';
// 渲染侧取词条：placementText 是正则作用范围的**唯一**渲染实现
// （CharacterDetailScreen 与 editors.js 都走它），英文界面能否显示英文全看这里。
// 先例同本文件的 worldEntryMeta：数据 → 文案的翻译由 cardHelpers 承担。
// i18n/index.js 是零依赖纯逻辑（Provider 在 I18nContext.js），Node 测试可直接跑。
import { tActive } from '../i18n/index.js';

// 导入侧同样不带「记忆总结」条目：旧卡（导出未过滤时代做的）里可能带着别处的会话记忆，
// 直接收下就会变成新卡的角色记忆被注入。导入时剔除，与导出侧同一口径。
export function stripMemorySummaryEntries(worldInfo) {
  return (Array.isArray(worldInfo) ? worldInfo : [])
    .filter(entry => !String((entry && entry.comment) || '').trim().startsWith(MEMORY_SUMMARY_PREFIX));
}

export const NO_CARD_DATA_MESSAGE =
  '该图片不包含角色卡数据，请上传角色卡 JSON 文件或含数据的 PNG 图片。';
export const LARGE_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export const CHARACTER_LIST_COLLAPSE_LIMIT = 10;

// FlatList 在 numColumns>1 时，scrollToIndex 的 index 按「行」计数（内部 getItemCount
// = ceil(项数/列数)）。定位滑块给的是「项」序号，套用前必须折算成行号，否则滑到
// 下半部分（项序号 ≥ 行数）会命中 VirtualizedList 的越界 invariant 直接闪退。
export function gridRowIndex(itemIndex, columns = 1) {
  const cols = Math.max(1, Math.floor(Number(columns) || 1));
  const index = Math.max(0, Math.floor(Number(itemIndex) || 0));
  return Math.floor(index / cols);
}

export function formatImportSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

export function isLargeImport(bytes) {
  return Number(bytes) > LARGE_IMPORT_BYTES;
}

export function getPickedAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

export function assetLooksLike(asset, ext, mimes) {
  const mime = String(asset?.mimeType || '').toLowerCase();
  const name = String(asset?.name || asset?.uri || '').toLowerCase();
  return mimes.includes(mime) || name.endsWith(ext);
}

export function isPngBuffer(buffer) {
  return (
    buffer
    && buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  );
}

export function splitKeywords(text) {
  return String(text || '')
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

// 正则作用范围的「数字 → 词条 key」映射。placement 本身是语言无关的数字
// （1/2/3/5/6，见 cardParser 的 normalizeRegexPlacement），所以这里只存 key：
// 文案随界面语言变，key 不变。
const REGEX_PLACEMENT_TEXT_KEYS = {
  1: 'character.editor.regex.scope.userInput',
  2: 'character.editor.regex.scope.aiOutput',
  3: 'character.editor.regex.scope.quickCommand',
  5: 'character.editor.regex.scope.worldInfo',
  6: 'character.editor.regex.scope.reasoning',
};

// 世界书条目「位置」的「数字 → 词条 key」映射。与上面的正则映射同理：position 是语言无关
// 的数字（0-7，见 cardParser 的 normalizeWorldPosition），文案随界面语言变。
// 这是 placementText 的**同族缺陷**：位置文案过去既是中文常量表、又会被插进模板渲染
// （editors.js），于是英文界面显示「位置：角色定义之前」；同一份中文还被写进卡片数据
// （worldInfo[].positionLabel）。此处收口成唯一实现，写入侧见 forge/*.js 的清空。
const WORLD_POSITION_TEXT_KEYS = {
  0: 'character.editor.world.positionText.beforeChar',
  1: 'character.editor.world.positionText.afterChar',
  2: 'character.editor.world.positionText.beforeAuthorNote',
  3: 'character.editor.world.positionText.afterAuthorNote',
  4: 'character.editor.world.positionText.atDepth',
  5: 'character.editor.world.positionText.beforeExample',
  6: 'character.editor.world.positionText.afterExample',
  7: 'character.editor.world.positionText.anchor',
};

// 世界书位置的展示文案——**唯一**实现（editors.js 走它）。参数语义与 placementText 对齐：
//  · position：语言无关的数字。
//  · strings.legacyLabel：旧卡落盘的中文 positionLabel，认不出数字时回落到它，
//    避免老条目在界面上变成空白（正是 placementText 的 legacyLabel 先例）。
//  · strings.positionFallback：认不出的数字用哪个模板（含 {key} 占位）。
// 认得出的数字**以词条为准**，legacyLabel 只兜底：position 才是权威字段。
export function positionText(position, strings = {}) {
  const numeric = Math.trunc(Number(position));
  const key = Number.isFinite(numeric) ? WORLD_POSITION_TEXT_KEYS[numeric] : undefined;
  const text = key ? tActive(key) : '';
  if (text) return text;
  const legacyLabel = String(strings.legacyLabel || '').trim();
  if (legacyLabel) return legacyLabel;
  const fallback = strings.positionFallback || tActive('character.editor.world.positionFallback');
  return fallback.replace('{key}', String(position));
}

// 正则作用范围的展示文案——**唯一**实现（CharacterDetailScreen 与 editors.js 都走它）。
//
// 修复背景：此前这里只把「认不出的范围」走词条，已知的 1/2/3/5/6 直接读
// cardParser 的中文常量表，于是英文界面照样显示「用户输入 / AI 输出」。
// 现在已知项也走 tActive，中文界面由 zh-CN 词条给同款文案，英文界面给英文。
//
// 参数：
//  · placement：语言无关的数字数组。
//  · strings.scopeFallback：认不出的数字用哪个模板（含 {key} 占位）。
//  · strings.legacyLabel：旧卡落盘的中文 placementLabel。历史版本把**中文文案**
//    写进了卡片数据（regexScripts[].placementLabel），随导出/分享传播。老卡若
//    只有这个字段而没有可用的 placement，就回落到它，避免这些条目在界面上变成空白。
export function placementText(placement, strings = {}) {
  const legacyLabel = String(strings.legacyLabel || '').trim();
  const scopeFallback = strings.scopeFallback || tActive('character.editor.regex.scopeFallback');
  const list = Array.isArray(placement) ? placement : [];
  const labels = list.map(item => {
    const key = REGEX_PLACEMENT_TEXT_KEYS[item];
    return key ? tActive(key) : '';
  });
  // 一项都没命中词条（placement 缺失 / 全是未知数字）→ 优先回落到旧卡的中文文案。
  // 判据是「没有任何一项认出」，而不是「数组为空」：[99] 这类同样走这条路。
  if (labels.every(label => !label)) {
    if (legacyLabel) return legacyLabel;
    return list.map(item => scopeFallback.replace('{key}', item)).join('、');
  }
  // 部分认得出：认得出的给词条，认不出的逐项给 scopeFallback（不静默丢弃）。
  return list.map((item, index) => labels[index] || scopeFallback.replace('{key}', item)).join('、');
}

export function hasCardContent(card) {
  if (!card) return false;
  if (card.name) return true;
  if (card.systemPrompt) return true;
  if (card.worldInfo?.length) return true;
  if (card.regexScripts?.length) return true;
  if (card.presets?.length) return true;
  const fields = card.fields || {};
  return Boolean(
    fields.description
    || fields.personality
    || fields.scenario
    || fields.firstMes
    || (fields.alternateGreetings && fields.alternateGreetings.length)
    || fields.mesExample
    || fields.creatorNotes
    || fields.postHistoryInstructions
  );
}

// 卡片数据里「语言相关文案」派生字段的清洗：positionLabel / placementLabel 存的都是
// **当时语言下的文案**（老卡里是中文），而权威字段是语言无关的 position / placement。
// 导入即落库，属于**保存路径**，与 cardForge/forge/assist.js 的 mergeEntryAssistPatch
// 同一口径（那里已在保存路径清这两个字段）：不清就会让旧中文随导出/分享继续传播，
// 英文界面照样显示中文。只在确实带值时才重建对象，干净卡片原样透传（不制造无谓 diff）。
function clearLanguageDerivedLabel(list, field) {
  return list.map(item => (item && item[field] ? { ...item, [field]: '' } : item));
}

export function buildCharacterPatch(card, strings = {}) {
  const fields = card.fields || {};
  return {
    id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: card.name || strings.defaultName || '导入角色',
    systemPrompt: fields.systemPrompt || '',
    systemPromptComposed: card.systemPrompt || '',
    description: fields.description || '',
    personality: fields.personality || '',
    scenario: fields.scenario || '',
    firstMes: fields.firstMes || '',
    alternateGreetings: Array.isArray(fields.alternateGreetings) ? fields.alternateGreetings : [],
    mesExample: fields.mesExample || '',
    creatorNotes: fields.creatorNotes || '',
    postHistoryInstructions: fields.postHistoryInstructions || '',
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    worldInfo: clearLanguageDerivedLabel(stripMemorySummaryEntries(card.worldInfo), 'positionLabel'),
    // 老卡透传时同样清掉中文派生文案（见 clearLanguageDerivedLabel）。
    regexScripts: clearLanguageDerivedLabel(
      Array.isArray(card.regexScripts) ? card.regexScripts : [],
      'placementLabel'
    ),
    presets: Array.isArray(card.presets) ? card.presets : [],
    // 透传隐式 AI 标识（与 cardForge/forge.js 一致），否则导入的 AI 生成卡丢失追溯信息。
    aigcMeta: card.aigcMeta && typeof card.aigcMeta === 'object' ? card.aigcMeta : null,
    voiceDisplay: ['text', 'voice-text', 'voice'].includes(card.voiceDisplay)
      ? card.voiceDisplay
      : 'text',
    cardExtensions: card.extensions && typeof card.extensions === 'object' && !Array.isArray(card.extensions)
      ? card.extensions
      : {},
    cardExtra: card.extra && typeof card.extra === 'object' && !Array.isArray(card.extra)
      ? card.extra
      : {},
  };
}


export function buildCharacterFormState(character) {
  const source = character && typeof character === 'object' ? character : {};
  return {
    name: String(source.name || ''),
    tags: Array.isArray(source.tags) ? source.tags : [],
    systemPrompt: String(source.systemPrompt || ''),
    description: String(source.description || ''),
    personality: String(source.personality || ''),
    scenario: String(source.scenario || ''),
    firstMes: String(source.firstMes || ''),
    alternateGreetings: Array.isArray(source.alternateGreetings) ? source.alternateGreetings : [],
    mesExample: String(source.mesExample || ''),
    worldInfo: ensureUniqueIds(Array.isArray(source.worldInfo) ? source.worldInfo : [], 'entry'),
    regexScripts: ensureUniqueIds(Array.isArray(source.regexScripts) ? source.regexScripts : [], 'regex'),
    presets: Array.isArray(source.presets) ? source.presets : [],
    avatarUri: String(source.avatarUri || ''),
    bgUri: String(source.bgUri || ''),
    voiceDisplay: ['text', 'voice-text', 'voice'].includes(source.voiceDisplay)
      ? source.voiceDisplay
      : 'text',
  };
}

export function characterFormSignature(character) {
  return JSON.stringify(buildCharacterFormState(character));
}

export function characterWithFormState(character, form) {
  const source = character && typeof character === 'object' ? character : {};
  const state = form || buildCharacterFormState(source);
  return {
    ...source,
    ...state,
    systemPromptComposed: buildSystemPrompt({
      description: state.description,
      personality: state.personality,
      scenario: state.scenario,
      systemPrompt: state.systemPrompt,
      postHistoryInstructions: source.postHistoryInstructions,
    }),
  };
}

export function worldEntryMeta(entry, strings = {}) {
  if (entry.constant) return strings.constant || '常驻';
  const keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean) : [];
  if (keys.length) return (strings.keywords || '关键词：{keys}').replace('{keys}', keys.join('、'));
  const content = String(entry.content || '').replace(/\s+/g, ' ').trim();
  return content ? content.slice(0, 40) : strings.noKeys || '未设置关键词';
}
