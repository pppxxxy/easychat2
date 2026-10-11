// 记忆总结设置存储：开关、触发阈值与记忆长度。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { readJson } from '../io.js';

const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';

// 记忆长度 = 关闭记忆总结时随请求发出的最近轮数（一轮 = 一条用户消息及其后续回复）。
// 默认 30；上限防止手输一个大数把整段历史都塞进请求（那正是关闭总结时该避免的）。
export const DEFAULT_MEMORY_LENGTH = 30;
export const MEMORY_LENGTH_MAX = 200;

const DEFAULT_MEMORY_SUMMARY = {
  enabled: true,
  threshold: 40,
  historyRounds: DEFAULT_MEMORY_LENGTH,
};

export function normalizeMemorySummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const threshold = Math.trunc(Number(source && source.threshold));
  const historyRounds = Math.trunc(Number(source && source.historyRounds));
  return {
    enabled: source ? source.enabled === true : DEFAULT_MEMORY_SUMMARY.enabled,
    threshold: Number.isFinite(threshold) && threshold > 0
      ? threshold
      : DEFAULT_MEMORY_SUMMARY.threshold,
    historyRounds: Number.isFinite(historyRounds) && historyRounds > 0
      ? Math.min(historyRounds, MEMORY_LENGTH_MAX)
      : DEFAULT_MEMORY_SUMMARY.historyRounds,
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

// 局部更新：读现值 → 合并补丁 → 归一化写回。
//
// 存在的理由：这三个字段由两个互不知晓的界面编辑（设置页的角色预设面板只编辑
// 开关与阈值，聊天页「总结」面板还编辑记忆长度）。若各自直接整体写，缺失字段会被
// 归一化回默认值——表现为「在聊天页改完记忆长度，回设置页切一下开关就被重置成 30」。
// 新写入方一律走这个函数（对照 patchAppearanceSettings 的同款理由）。
export async function patchMemorySummarySettings(patch) {
  const current = await getMemorySummarySettings();
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const normalized = normalizeMemorySummary(merged);
  await AsyncStorage.setItem(MEMORY_SUMMARY_KEY, JSON.stringify(normalized));
  return normalized;
}
