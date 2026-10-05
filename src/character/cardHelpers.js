// 角色卡导入/解析与表单态纯函数。从 src/CharacterScreen.js 原样外提（无行为变化）。
// 不含 React：只依赖 cardParser 的标签表/ID 工具与 buildSystemPrompt，便于单测。

import {
  buildSystemPrompt,
  ensureUniqueIds,
  REGEX_PLACEMENT_LABELS,
} from './cardParser.js';

export const NO_CARD_DATA_MESSAGE =
  '该图片不包含角色卡数据，请上传角色卡 JSON 文件或含数据的 PNG 图片。';
export const LARGE_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export const CHARACTER_LIST_COLLAPSE_LIMIT = 10;

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

export function placementText(placement, strings = {}) {
  const scopeFallback = strings.scopeFallback || '范围 {key}';
  return placement
    .map(item => REGEX_PLACEMENT_LABELS[item] || scopeFallback.replace('{key}', item))
    .join('、');
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
    worldInfo: Array.isArray(card.worldInfo) ? card.worldInfo : [],
    regexScripts: Array.isArray(card.regexScripts) ? card.regexScripts : [],
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
