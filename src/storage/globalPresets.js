// 全局预设存储领域。从 src/storage.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import GLOBAL_PRESETS from '../settings/presets.js';
import { tActive } from '../i18n/index.js';
import { backupCorruptValue, readJsonStatus } from './io.js';

const GLOBAL_PRESETS_KEY = '@easychat2_global_presets';
const PRESET_LIST_KEY = '@easychat2_preset_list';

function normalizePreset(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.id !== 'string' || !source.id.trim()
    || typeof source.name !== 'string' || !source.name.trim()
    || typeof source.prompt !== 'string' || !source.prompt.trim()) {
    throw new Error(tActive('error.presets.invalid'));
  }
  return {
    id: source.id.trim(),
    name: source.name.trim(),
    description: String(source.description || '').trim(),
    prompt: source.prompt.trim(),
  };
}

function normalizePresetList(presets) {
  if (!Array.isArray(presets)) throw new Error(tActive('error.presets.listInvalid'));
  const list = presets.map(normalizePreset);
  if (new Set(list.map(preset => preset.id)).size !== list.length) {
    throw new Error(tActive('error.presets.duplicateId'));
  }
  return list;
}

export async function getGlobalPresets() {
  const stored = await readJsonStatus(PRESET_LIST_KEY);
  if (stored.status === 'missing') return GLOBAL_PRESETS.map(normalizePreset);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(PRESET_LIST_KEY);
    return GLOBAL_PRESETS.map(normalizePreset);
  }
  try {
    return normalizePresetList(stored.value);
  } catch (error) {
    // 结构不合法时尽量保留可用项，而不是整份丢弃（原始值已备份）
    const list = Array.isArray(stored.value) ? stored.value : [];
    const kept = [];
    const seen = new Set();
    list.forEach(item => {
      try {
        const preset = normalizePreset(item);
        if (seen.has(preset.id)) return;
        seen.add(preset.id);
        kept.push(preset);
      } catch (entryError) {}
    });
    await backupCorruptValue(PRESET_LIST_KEY);
    return kept.length > 0 ? kept : GLOBAL_PRESETS.map(normalizePreset);
  }
}

export async function saveGlobalPresets(presets) {
  const list = normalizePresetList(presets);
  await AsyncStorage.setItem(PRESET_LIST_KEY, JSON.stringify(list));
  return list;
}

function normalizeEnabledMap(source, presets) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const enabled = {};
  presets.forEach(preset => {
    enabled[preset.id] = raw[preset.id] === true;
  });
  return enabled;
}

async function readGlobalPresetSettings() {
  const stored = await readJsonStatus(GLOBAL_PRESETS_KEY);
  if (stored.status === 'missing') return {};
  const enabled = stored.status === 'ok' ? stored.value : null;
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) {
    // 这里抛错会连累 getEnabledGlobalPresetPrompts，而后者位于发送消息的
    // Promise.all 中 —— 一个损坏的开关文件会导致“聊天完全发不出去”。
    // 改为退回空开关并备份原始值。
    await backupCorruptValue(GLOBAL_PRESETS_KEY);
    return {};
  }
  return enabled;
}

export async function createGlobalPresetId(presets) {
  const enabled = await readGlobalPresetSettings();
  const used = new Set([...presets.map(preset => preset.id), ...Object.keys(enabled)]);
  const base = `preset-${Date.now()}`;
  let id = base;
  let suffix = 0;
  while (used.has(id)) {
    suffix += 1;
    id = `${base}-${suffix}`;
  }
  return id;
}

export async function getGlobalPresetSettings() {
  const [raw, presets] = await Promise.all([
    readGlobalPresetSettings(),
    getGlobalPresets(),
  ]);
  return normalizeEnabledMap(raw, presets);
}

export async function saveGlobalPresetSettings(enabled) {
  const presets = await getGlobalPresets();
  const normalized = normalizeEnabledMap(enabled, presets);
  await AsyncStorage.setItem(GLOBAL_PRESETS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function getEnabledGlobalPresetPrompts() {
  const presets = await getGlobalPresets();
  const raw = await readGlobalPresetSettings();
  const enabled = normalizeEnabledMap(raw, presets);
  return presets.filter(preset => enabled[preset.id]).map(preset => preset.prompt);
}