// 悬浮球头像设置存储叶子（FEAT-AC3）。
//
// 形态照 src/storage/settings/thinking.js（小叶子：解析 → 三态读 → 写路径守卫）
// 与 playerSettings.js（枚举校验 + 非法回退默认）。
//
// 三档（用户诉求）：
//   default   = App 图标（现状，默认）
//   character = 跟随当前角色头像（聊天 scope 生效；工作区 scope 回退 App 图标）
//   custom    = 用户自选的图片（落到 Documents/screenWatch/overlay-avatar.<ext>）
//
// 为什么 customUri 要落**专属稳定路径**而不是直接存相册/SAF 的 uri：
// 相册项可能被删、SAF 授权可能失效，那时头像会变成「有时能显示有时不能」。
// 复制到应用私有目录后，源被删也不波及（先例：cardForge/media.js 的
// pickForgeImage —— 同一套 copyAsync 到 documentDirectory 的做法）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, readJsonStatus } from '../io.js';
import { tActive } from '../../i18n/index.js';

export const OVERLAY_AVATAR_KEY = '@easychat2_overlay_avatar';

// 三档模式（唯一事实源，纯校验与 UI 选项都从这里派生）。
export const OVERLAY_AVATAR_MODES = ['default', 'character', 'custom'];

export const DEFAULT_OVERLAY_AVATAR = { mode: 'default', customUri: '' };

// customUri 长度上限：本地路径不该有这么长；超长视为脏数据（截断而不是整键丢弃）。
const CUSTOM_URI_MAX = 1024;

export function normalizeOverlayAvatar(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = String(source.mode || '');
  return {
    // 非法 mode 回退 default（与 thinking 的 level/display 同款：不认识就当没设置过）。
    mode: OVERLAY_AVATAR_MODES.includes(mode) ? mode : DEFAULT_OVERLAY_AVATAR.mode,
    customUri: String(source.customUri || '').trim().slice(0, CUSTOM_URI_MAX),
  };
}

// 三态读：把「没有这个键」与「读不到/结构非法」分开。
// 判形状的理由同 thinking.js：readJsonStatus 的 ok 只保证 JSON.parse 成功，
// null / 数组 / 原语同样是 ok，而 normalize 会把它们折叠成默认值——
// 界面看起来像「我从没设置过」，用户随手保存就整键覆盖掉损坏原值（不可逆）。
async function readOverlayAvatarStatus() {
  const stored = await readJsonStatus(OVERLAY_AVATAR_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (
      stored.value === null
      || typeof stored.value !== 'object'
      || Array.isArray(stored.value)
    ))
  ) {
    await backupCorruptValue(OVERLAY_AVATAR_KEY);
    return { status: 'corrupt' };
  }
  if (stored.status === 'missing') return { status: 'missing' };
  return { status: 'ok', value: stored.value };
}

// 读失败/形状坏时**抛错**而不是回落默认：回落 + 保存会静默抹掉损坏原值。
export async function getOverlayAvatarSettings() {
  const status = await readOverlayAvatarStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.overlayAvatarReadFailed'));
  if (status.status === 'missing') return normalizeOverlayAvatar(null);
  return normalizeOverlayAvatar(status.value);
}

export async function saveOverlayAvatarSettings(settings) {
  // 写路径守卫（变体①）：读不出原值就抛错中止，绝不用默认值整键覆盖。
  const status = await readOverlayAvatarStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.overlayAvatarReadFailed'));
  const normalized = normalizeOverlayAvatar(settings);
  await AsyncStorage.setItem(OVERLAY_AVATAR_KEY, JSON.stringify(normalized));
  return normalized;
}
