// 记忆总结设置存储：开关与触发阈值。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_MEMORY_MAX_ENTRIES } from '../../memory/memoryConstants.js';
import { readJson } from '../io.js';

const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';

const DEFAULT_MEMORY_SUMMARY = {
  enabled: true,
  threshold: 40,
  configId: '',
  maxEntries: DEFAULT_MEMORY_MAX_ENTRIES,
};

function normalizeMemorySummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const threshold = Math.trunc(Number(source && source.threshold));
  const maxEntries = Math.trunc(Number(source && source.maxEntries));
  return {
    enabled: source ? source.enabled === true : DEFAULT_MEMORY_SUMMARY.enabled,
    threshold: Number.isFinite(threshold) && threshold > 0
      ? threshold
      : DEFAULT_MEMORY_SUMMARY.threshold,
    // 总结接口：'' = 用当前默认接口；否则用指定接口配置的 id。
    configId: String((source && source.configId) || ''),
    // 长记忆保留上限（条）：超出淘汰最旧的。
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0
      ? maxEntries
      : DEFAULT_MEMORY_SUMMARY.maxEntries,
  };
}

export async function getMemorySummarySettings() {
  const raw = await readJson(MEMORY_SUMMARY_KEY, null);
  return normalizeMemorySummary(raw);
}

export async function saveMemorySummarySettings(settings) {
  const normalized = normalizeMemorySummary(settings);
  await AsyncStorage.setItem(MEMORY_SUMMARY_KEY, JSON.stringify(normalized));
  return normalized;
}
