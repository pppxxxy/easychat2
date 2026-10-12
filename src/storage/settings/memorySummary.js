// 记忆总结设置存储：开关、触发阈值与记忆长度。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

// 两线合并（2026-10-12）：两侧各加了自己需要的 import，**都要**——
// main 侧引入 DEFAULT_MEMORY_MAX_ENTRIES（长记忆保留上限），
// D 线把读路径改成 readJsonStatus 三态（+ backupCorruptValue 留副本 + tActive 报错）。
// `readJson` 已不再使用（读路径全部走三态），故不导入。
import { DEFAULT_MEMORY_MAX_ENTRIES } from '../../memory/memoryConstants.js';
import { backupCorruptValue, readJsonStatus } from '../io.js';
import { tActive } from '../../i18n/index.js';

const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';

// 记忆长度 = 关闭记忆总结时随请求发出的最近轮数（一轮 = 一条用户消息及其后续回复）。
// 默认 30；上限防止手输一个大数把整段历史都塞进请求（那正是关闭总结时该避免的）。
export const DEFAULT_MEMORY_LENGTH = 30;
export const MEMORY_LENGTH_MAX = 200;

const DEFAULT_MEMORY_SUMMARY = {
  enabled: true,
  threshold: 40,
  // 总结专用接口（'' = 用当前默认接口）与长记忆保留上限：M 系 m1011m10 引入。
  configId: '',
  maxEntries: DEFAULT_MEMORY_MAX_ENTRIES,
  // 记忆长度（Z 系 z1012z11 引入）：只在关闭总结时生效。
  historyRounds: DEFAULT_MEMORY_LENGTH,
};

export function normalizeMemorySummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const threshold = Math.trunc(Number(source && source.threshold));
  const maxEntries = Math.trunc(Number(source && source.maxEntries));
  const historyRounds = Math.trunc(Number(source && source.historyRounds));
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
    // 记忆长度：只在关闭总结时生效（开启时保持「摘要 + 全部历史」原状）。
    historyRounds: Number.isFinite(historyRounds) && historyRounds > 0
      ? Math.min(historyRounds, MEMORY_LENGTH_MAX)
      : DEFAULT_MEMORY_SUMMARY.historyRounds,
  };
}

// 三态读（读路径与写路径共用这一份判据）。为什么必须判形状：readJsonStatus 的 ok
// 只保证 JSON.parse 成功——null / 数组 / 原语同样是 ok（**第四态**），而
// normalizeMemorySummary 把「非对象」当成「用默认阈值」，界面看起来像「我没配过」。
// 形态与判据照 src/storage/settings/tts.js:46-59 与 settings/mcpServers.js:188-198。
async function readMemorySummaryStatus() {
  const stored = await readJsonStatus(MEMORY_SUMMARY_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (
      stored.value === null
      || typeof stored.value !== 'object'
      || Array.isArray(stored.value)
    ))
  ) {
    await backupCorruptValue(MEMORY_SUMMARY_KEY);
    return { status: 'corrupt' };
  }
  if (stored.status === 'missing') return { status: 'missing' };
  return { status: 'ok', value: stored.value };
}

// 读失败/形状坏时**抛错**而不是回落默认值：回落会让预设面板显示「记忆总结：默认阈值」，
// 用户随手改一次阈值并保存就整键覆盖掉损坏的原值（不可逆、无备份）。
export async function getMemorySummarySettings() {
  const status = await readMemorySummaryStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.memorySummarySettingsReadFailed'));
  if (status.status === 'missing') return normalizeMemorySummary(null);
  return normalizeMemorySummary(status.value);
}

export async function saveMemorySummarySettings(settings) {
  // 写路径守卫（变体①）：读不出原值就抛错中止，绝不用默认值整键覆盖。
  // 参考 src/storage/settings/tts.js:133-138（assertReadableForMutation）。
  const status = await readMemorySummaryStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.memorySummarySettingsReadFailed'));
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
