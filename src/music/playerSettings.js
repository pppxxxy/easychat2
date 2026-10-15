// 一起听歌的播放设置：播放方式 + 播放倍速。全局一份（不分歌），
// 与阅读器的 readerSettings 同构；读取失败回退默认，不阻断播放。
//
// FEAT-AC2 拆分：**值域与纯函数**搬去 ./playerSettingsPure.js（零依赖、Node 直测），
// 本文件只留「读写存储」这一层，并把纯层原样 re-export —— 既有引用点
//（MusicScreen / useMusicPlayerSettings / 测试）一个都不用改。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { readJsonStatus } from '../storage/io.js';
import {
  MUSIC_PLAYER_SETTINGS_KEY,
  normalizeMusicPlayerSettings,
} from './playerSettingsPure.js';

// 纯层原样 re-export：既有引用点（MusicScreen / useMusicPlayerSettings / 测试）
// 一个都不用改——拆分对它们透明。
export {
  DEFAULT_MUSIC_PLAYER_SETTINGS,
  MUSIC_PLAYER_SETTINGS_KEY,
  MUSIC_PLAY_MODES,
  MUSIC_RATES,
  formatMusicRate,
  nextMusicPlayMode,
  nextMusicRate,
  nextSequentialIndex,
  normalizeMusicPlayerSettings,
  pickShuffleIndex,
} from './playerSettingsPure.js';

// 读设置 → { status, settings }，把「没有这个键」与「读不到/结构非法」分开。
// 以前这里用 readJson(key, DEFAULT)：读失败也返回默认值，面板一保存就把默认值
// 写回，用户的播放方式与倍速被静默抹掉（不可逆）。
// 口径同 src/storage/worldMap.js:34-40「读失败就抛错中止：绝不用空列表覆盖已有地图」，
// 但**读路径行为保持不变**：读失败仍回退默认给 UI，不阻断播放。
// 默认值一律经 normalize(null) 现造（不把 DEFAULT_MUSIC_PLAYER_SETTINGS 这个模块级
// 常量按引用交出去，调用方改了它就等于改了全局默认）。
// 损坏值的备份不在这里重复做：本模块的写路径已改为直接拒绝，损坏原值原地保留，
// 不存在被默认值覆盖的风险（备份只在「即将覆盖」时才有意义）。
async function readMusicPlayerSettingsStatus() {
  const stored = await readJsonStatus(MUSIC_PLAYER_SETTINGS_KEY);
  const fallback = normalizeMusicPlayerSettings(null);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok'
      && (stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)))
  ) {
    return { status: 'corrupt', settings: fallback };
  }
  if (stored.status === 'missing') return { status: 'ok', settings: fallback };
  return { status: 'ok', settings: normalizeMusicPlayerSettings(stored.value) };
}

export async function getMusicPlayerSettings() {
  const result = await readMusicPlayerSettingsStatus();
  return result.settings;
}

export async function saveMusicPlayerSettings(patch) {
  const result = await readMusicPlayerSettingsStatus();
  // 读失败**拒绝写回**：此时拿到的只能是默认值，写回等于把用户存的设置抹成默认。
  // 错误码写法同 src/screenWatch/threads.js:99（调用方目前 catch 后静默，不面向用户）。
  if (result.status === 'corrupt') throw new Error('music-player-settings-read-failed');
  const next = normalizeMusicPlayerSettings({ ...result.settings, ...(patch || {}) });
  await AsyncStorage.setItem(MUSIC_PLAYER_SETTINGS_KEY, JSON.stringify(next));
  return next;
}
