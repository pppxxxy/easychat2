// 思考设置存储：思考开关/档位/展示方式。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, readJsonStatus } from '../io.js';
import { tActive } from '../../i18n/index.js';

const THINKING_KEY = '@easychat2_thinking';

const DEFAULT_THINKING = { enabled: false, level: 'medium', display: 'fold' };
export const THINKING_LEVELS = ['low', 'medium', 'high'];
export const THINKING_DISPLAYS = ['open', 'fold', 'off'];

function normalizeThinking(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled === true,
    level: THINKING_LEVELS.includes(source.level) ? source.level : DEFAULT_THINKING.level,
    display: THINKING_DISPLAYS.includes(source.display) ? source.display : DEFAULT_THINKING.display,
  };
}

// 三态读（读路径与写路径共用这一份判据）。为什么必须判形状：readJsonStatus 的 ok
// 只保证 JSON.parse 成功——null / 数组 / 原语同样是 ok（**第四态**），而
// normalizeThinking 会把它折叠成「全默认值」，界面看起来像「我没开过思考」。
// 形态与判据照 src/storage/settings/tts.js:46-59（getTtsSettings）与
// src/storage/settings/mcpServers.js:188-198（readMcpServersStatus）。
async function readThinkingStatus() {
  const stored = await readJsonStatus(THINKING_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (
      stored.value === null
      || typeof stored.value !== 'object'
      || Array.isArray(stored.value)
    ))
  ) {
    await backupCorruptValue(THINKING_KEY);
    return { status: 'corrupt' };
  }
  if (stored.status === 'missing') return { status: 'missing' };
  return { status: 'ok', value: stored.value };
}

// 读失败/形状坏时**抛错**而不是回落默认值：回落会让设置页显示「我没开过」，
// 用户随手打开开关并保存就整键覆盖掉损坏的原值 —— 不可逆丢失且没有任何备份。
// 抛错让面板停用保存并提示「设置未能读出，已中止保存以免覆盖」。
export async function getThinkingSettings() {
  const status = await readThinkingStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.thinkingSettingsReadFailed'));
  if (status.status === 'missing') return normalizeThinking(null);
  return normalizeThinking(status.value);
}

export async function saveThinkingSettings(settings) {
  // 写路径守卫（变体①）：读不出原值就抛错中止，绝不用默认值整键覆盖。
  // 参考 src/storage/settings/tts.js:133-138（assertReadableForMutation）：
  // 面板的 `!loaded` 守卫只挡得住「本次没读成功就保存」，挡不住别处触发的写。
  const status = await readThinkingStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.thinkingSettingsReadFailed'));
  const normalized = normalizeThinking(settings);
  await AsyncStorage.setItem(THINKING_KEY, JSON.stringify(normalized));
  return normalized;
}
