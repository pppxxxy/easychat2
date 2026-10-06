// 整卡归一化：把任意第三方卡片 JSON 收敛成应用内部形态，并保留未消费字段。纯函数。
import { extractCharacterPresets } from '../characterPresets.js';
import { isValidAigcMeta } from '../../aigc/attribution.js';
import { tActive } from '../../i18n/index.js';

import { isPlainObject } from './normalizeUtils.js';
import { extractRegexScripts } from './regexScripts.js';
import { buildSystemPrompt, extractStandardFields } from './standardFields.js';
import { extractWorldInfo } from './worldInfo.js';

export function ensureUniqueIds(items, prefix) {
  const seen = new Set();
  return items.map((item, index) => {
    const rawId = item && item.id;
    let id = rawId === null || rawId === undefined || String(rawId).trim() === ''
      ? `${prefix}-${index}`
      : String(rawId);
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
    return id === rawId ? item : { ...item, id };
  });
}

const CONSUMED_EXTENSION_KEYS = new Set([
  'regex_scripts',
  'regexScripts',
  'worldInfo',
  'worldbook',
  'character_book',
  'easychat2',
]);

const KNOWN_CARD_DATA_KEYS = new Set([
  'spec',
  'spec_version',
  'data',
  'avatar',
  'chat',
  'json',
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'alternate_greetings',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'character_book',
  'extensions',
  'group_only_greetings',
]);

function collectPassthroughExtensions(extensions) {
  const output = {};
  if (!isPlainObject(extensions)) return output;
  Object.keys(extensions).forEach(key => {
    if (CONSUMED_EXTENSION_KEYS.has(key)) return;
    output[key] = extensions[key];
  });
  return output;
}

function collectPassthroughExtra(base) {
  const output = {};
  if (!isPlainObject(base)) return output;
  Object.keys(base).forEach(key => {
    if (KNOWN_CARD_DATA_KEYS.has(key)) return;
    output[key] = base[key];
  });
  return output;
}

export function normalizeCard(raw) {
  const source = Array.isArray(raw) ? raw.find(isPlainObject) : raw;
  if (!isPlainObject(source)) {
    throw new Error(tActive('error.cardParser.invalidObject'));
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
  const presets = extractCharacterPresets(source, data, extensions);
  // 隐式 AI 标识：导出时写在 extensions.easychat2.aigc_meta。不读回来的话，
  // 「导入 → 再导出」会丢掉该标识，角色页的「本卡由 AI 生成」徽标消失、追溯链断裂。
  const easychat2 = isPlainObject(extensions.easychat2) ? extensions.easychat2 : {};
  const aigcMeta = isValidAigcMeta(easychat2.aigc_meta) ? easychat2.aigc_meta : null;
  return {
    name: fields.name,
    fields,
    systemPrompt: buildSystemPrompt(fields),
    worldInfo,
    regexScripts,
    presets,
    aigcMeta,
    // 应用能识别的是上面这些字段；其余第三方扩展与顶层字段原样带回，
    // 导出时再写回，避免 card forge / 重新导出把作者信息、talkativeness 等丢掉。
    extensions: collectPassthroughExtensions(extensions),
    extra: collectPassthroughExtra(isPlainObject(source.data) ? source.data : source),
  };
}
