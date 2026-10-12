// 采样设置存储：maxTokens/temperature/topP/topK 的白名单与钳制。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, readJsonStatus } from '../io.js';
import { tActive } from '../../i18n/index.js';

const SAMPLING_KEY = '@easychat2_sampling';

export const SAMPLING_FIELDS = {
  maxTokens: { min: 1, max: 128000, integer: true, default: 8024 },
  temperature: { min: 0, max: 2, integer: false, default: 1 },
  topP: { min: 0, max: 1, integer: false, default: 1 },
  topK: { min: 0, max: 50, integer: true, default: 0 },
};

function clampSamplingField(name, raw) {
  const rule = SAMPLING_FIELDS[name];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = source.enabled === true;
  const rawValue = source.value;
  const isEmpty = rawValue === null || rawValue === undefined || rawValue === '';
  const parsed = isEmpty ? NaN : Number(rawValue);
  let value = Number.isFinite(parsed) ? parsed : rule.default;
  if (rule.integer) value = Math.round(value);
  value = Math.min(rule.max, Math.max(rule.min, value));
  return { enabled, value };
}

function normalizeSampling(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.keys(SAMPLING_FIELDS).forEach(name => {
    result[name] = clampSamplingField(name, source[name]);
  });
  return result;
}

// 三态读（读路径与写路径共用这一份判据）。为什么必须判形状：readJsonStatus 的 ok
// 只保证 JSON.parse 成功——null / 数组 / 原语同样是 ok（**第四态**），而
// normalizeSampling 会把它折叠成四个字段的全默认值，界面看起来像「我从没配过采样参数」。
// 形态与判据照 src/storage/settings/tts.js:46-59 与 settings/mcpServers.js:188-198。
async function readSamplingStatus() {
  const stored = await readJsonStatus(SAMPLING_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (
      stored.value === null
      || typeof stored.value !== 'object'
      || Array.isArray(stored.value)
    ))
  ) {
    await backupCorruptValue(SAMPLING_KEY);
    return { status: 'corrupt' };
  }
  if (stored.status === 'missing') return { status: 'missing' };
  return { status: 'ok', value: stored.value };
}

// 读失败/形状坏时**抛错**而不是回落默认值：回落会让设置页显示「没配过」，
// 用户随手改一个字段并保存就整键覆盖掉损坏的原值（不可逆、无备份）。
export async function getSamplingSettings() {
  const status = await readSamplingStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.samplingSettingsReadFailed'));
  if (status.status === 'missing') return normalizeSampling(null);
  return normalizeSampling(status.value);
}

export async function saveSamplingSettings(settings) {
  // 写路径守卫（变体①）：读不出原值就抛错中止，绝不用默认值整键覆盖。
  // 参考 src/storage/settings/tts.js:133-138（assertReadableForMutation）。
  const status = await readSamplingStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.samplingSettingsReadFailed'));
  const normalized = normalizeSampling(settings);
  await AsyncStorage.setItem(SAMPLING_KEY, JSON.stringify(normalized));
  return normalized;
}
