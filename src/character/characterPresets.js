function firstString(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return '';
}

function uniquePresetId(base, used) {
  const seed = String(base || '').trim() || `character-preset-${Date.now().toString(36)}`;
  if (!used.has(seed)) return seed;
  let index = 2;
  while (used.has(`${seed}-${index}`)) index += 1;
  return `${seed}-${index}`;
}

export function makeCharacterPresetId(list = [], now = Date.now()) {
  const used = new Set((Array.isArray(list) ? list : []).map(item => String(item && item.id || '')));
  return uniquePresetId(`character-preset-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, used);
}

export function normalizeCharacterPreset(raw, index = 0, used = new Set()) {
  const source = typeof raw === 'string' ? { prompt: raw } : (raw && typeof raw === 'object' ? raw : {});
  const prompt = firstString(source, ['prompt', 'content', 'text', 'system_prompt', 'systemPrompt', 'value']);
  if (!prompt) return null;
  const baseId = firstString(source, ['id', 'identifier', 'key']) || `character-preset-${index + 1}`;
  const id = uniquePresetId(baseId, used);
  used.add(id);
  return {
    id,
    name: firstString(source, ['name', 'title', 'label']) || `预设 ${index + 1}`,
    description: firstString(source, ['description', 'desc', 'note']),
    prompt,
    enabled: source.enabled !== false && source.disabled !== true,
  };
}

function normalizePresetEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return [raw];
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.prompts)) return raw.prompts;
  if (Array.isArray(raw.presets)) return raw.presets;
  if (Array.isArray(raw.items)) return raw.items;
  if (firstString(raw, ['prompt', 'content', 'text', 'system_prompt', 'systemPrompt', 'value'])) return [raw];
  return Object.entries(raw)
    .map(([id, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { id, ...value };
      }
      return { id, prompt: value };
    });
}

export function normalizeCharacterPresets(raw) {
  const entries = normalizePresetEntries(raw);
  const used = new Set();
  return entries
    .map((entry, index) => normalizeCharacterPreset(entry, index, used))
    .filter(Boolean);
}

function getPath(root, path) {
  return path.split('.').reduce((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return value[key];
  }, root);
}

export function extractCharacterPresets(source, data, extensions) {
  const paths = [
    'data.extensions.easychat2.character_presets',
    'data.extensions.easychat2.characterPresets',
    'data.extensions.character_presets',
    'data.extensions.characterPresets',
    'data.character_presets',
    'data.characterPresets',
    'data.presets',
    'extensions.easychat2.character_presets',
    'extensions.easychat2.characterPresets',
    'extensions.character_presets',
    'extensions.characterPresets',
    'extensions.presets',
    'character_presets',
    'characterPresets',
    'presets',
  ];
  for (const path of paths) {
    const value = getPath({ data, extensions, source }, path);
    const normalized = normalizeCharacterPresets(value);
    if (normalized.length > 0) return normalized;
  }
  return [];
}
