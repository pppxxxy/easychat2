// 记忆总结设置存储：开关与触发阈值。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, readJsonStatus } from '../io.js';
import { tActive } from '../../i18n/index.js';

const MEMORY_SUMMARY_KEY = '@easychat2_memory_summary';

const DEFAULT_MEMORY_SUMMARY = { enabled: true, threshold: 40 };

function normalizeMemorySummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const threshold = Math.trunc(Number(source && source.threshold));
  return {
    enabled: source ? source.enabled === true : DEFAULT_MEMORY_SUMMARY.enabled,
    threshold: Number.isFinite(threshold) && threshold > 0
      ? threshold
      : DEFAULT_MEMORY_SUMMARY.threshold,
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
