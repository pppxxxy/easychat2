// Model JSON parsing and whole-card draft patch application.

import { FORGE_FIELDS, FIELD_LABELS, MAX_PRESERVED_TEXT, MAX_FORGE_TAG_COUNT, clean } from './shared.js';
import { sanitizeWorldEntry, sanitizeRegexScript, sanitizePreset, sanitizeAdvancedArray } from './advanced.js';
import { createForgeDraft } from './draft.js';

// 从模型回复里抠出 JSON（容忍代码块包裹与前后多余文字），只取白名单字段
export function parseCardPatch(text) {
  const raw = String(text || '').trim().slice(0, MAX_PRESERVED_TEXT);
  if (!raw) return null;
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const patch = {};
    FORGE_FIELDS.forEach(key => {
      // null 是唯一的显式清空指令；字符串（含空串）只按普通值处理。
      if (typeof parsed[key] === 'string') patch[key] = parsed[key];
      else if (parsed[key] === null) patch[key] = null;
    });
    if (parsed.tags === null) {
      patch.tags = null;
    } else if (Array.isArray(parsed.tags)) {
      patch.tags = parsed.tags
        .map(item => clean(item, 40))
        .filter(Boolean)
        .slice(0, MAX_FORGE_TAG_COUNT);
    }
    // 高级字段只在模型确实给出非空数组时采纳：空数组不做清空语义，
    // 避免一次「没生成」把用户已有的世界书 / 正则 / 预设抹掉。
    const worldInfo = sanitizeAdvancedArray(parsed.worldInfo, sanitizeWorldEntry);
    if (worldInfo) patch.worldInfo = worldInfo;
    const regexScripts = sanitizeAdvancedArray(parsed.regexScripts, sanitizeRegexScript);
    if (regexScripts) patch.regexScripts = regexScripts;
    const presets = sanitizeAdvancedArray(parsed.presets, sanitizePreset);
    if (presets) patch.presets = presets;
    if (Object.keys(patch).length > 0) return patch;
  }
  return null;
}

export function mergeDraft(draft, patch, now = Date.now()) {
  const base = draft && typeof draft === 'object' ? draft : createForgeDraft();
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = { ...base };
  const changed = [];
  FORGE_FIELDS.forEach(key => {
    // 显式清空只认 null 哨兵。提示词要求模型回全量 JSON，模型给未改字段填空串
    // 是常见偷懒行为——空串若被当成清空指令，用户已写好的长字段会被一次性抹掉。
    if (source[key] === null) {
      if (clean(base[key], MAX_PRESERVED_TEXT) === '') return;
      next[key] = '';
      changed.push(`${FIELD_LABELS[key] || key}（已清空）`);
      return;
    }
    if (typeof source[key] !== 'string') return;
    const value = clean(source[key], MAX_PRESERVED_TEXT);
    if (!value) return;
    if (value === clean(base[key], MAX_PRESERVED_TEXT)) return;
    next[key] = value;
    changed.push(FIELD_LABELS[key] || key);
  });
  if (source.tags === null) {
    const baseTags = Array.isArray(base.tags) ? base.tags : [];
    if (baseTags.length > 0) {
      next.tags = [];
      changed.push('标签（已清空）');
    }
  } else if (Array.isArray(source.tags)) {
    const tags = source.tags.map(item => clean(item, 40)).filter(Boolean).slice(0, MAX_FORGE_TAG_COUNT);
    // 空数组同样不构成清空指令（理由同上）；只有显式 null 才清空标签。
    if (tags.length > 0 && tags.join('|') !== (Array.isArray(base.tags) ? base.tags.join('|') : '')) {
      next.tags = tags;
      changed.push('标签');
    }
  }
  // 高级内容：模型给了非空数组就整体替换（生成的是新角色卡内容），
  // 没给则保留草稿里原有条目（导入已有角色时不至于被生成覆盖掉）。
  const advanced = [
    ['worldInfo', '世界书', sanitizeWorldEntry],
    ['regexScripts', '正则脚本', sanitizeRegexScript],
    ['presets', '文本预设', sanitizePreset],
  ];
  advanced.forEach(([key, label, sanitizer]) => {
    const list = sanitizeAdvancedArray(source[key], sanitizer);
    if (!list) return;
    next[key] = list;
    changed.push(`${label}（${list.length} 条）`);
  });
  return { draft: next, changed, updatedAt: now };
}
