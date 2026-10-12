// 一起听歌的播放设置：播放方式 + 播放倍速。全局一份（不分歌），
// 与阅读器的 readerSettings 同构；读取失败回退默认，不阻断播放。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { readJsonStatus } from '../storage/io.js';

export const MUSIC_PLAYER_SETTINGS_KEY = '@easychat2_music_player';

// stop       = 播完停止（原行为）
// repeatOne  = 单曲循环
// sequential = 歌单顺序播放（播完自动下一首，最后一首接回第一首）
// shuffle    = 歌单随机播放（尽量不重复当前这首）
export const MUSIC_PLAY_MODES = ['stop', 'repeatOne', 'sequential', 'shuffle'];

// 倍速档位：点击在档位间循环。
export const MUSIC_RATES = [0.5, 0.75, 1, 1.5, 2];

export const DEFAULT_MUSIC_PLAYER_SETTINGS = { playMode: 'stop', rate: 1 };

export function normalizeMusicPlayerSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = String(source.playMode || '');
  const rate = Number(source.rate);
  return {
    playMode: MUSIC_PLAY_MODES.includes(mode) ? mode : DEFAULT_MUSIC_PLAYER_SETTINGS.playMode,
    rate: MUSIC_RATES.includes(rate) ? rate : DEFAULT_MUSIC_PLAYER_SETTINGS.rate,
  };
}

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

// 下一档（循环）：供「点一下换一档」的交互用。
export function nextMusicPlayMode(mode) {
  const index = MUSIC_PLAY_MODES.indexOf(mode);
  return MUSIC_PLAY_MODES[(index + 1) % MUSIC_PLAY_MODES.length];
}

export function nextMusicRate(rate) {
  const index = MUSIC_RATES.indexOf(Number(rate));
  if (index < 0) return DEFAULT_MUSIC_PLAYER_SETTINGS.rate;
  return MUSIC_RATES[(index + 1) % MUSIC_RATES.length];
}

// 歌单顺序播放的下一首：末首接回第一首。
export function nextSequentialIndex(length, currentIndex) {
  const count = Math.max(0, Math.floor(Number(length)) || 0);
  if (count === 0) return -1;
  const current = Math.min(count - 1, Math.max(0, Math.floor(Number(currentIndex)) || 0));
  return (current + 1) % count;
}

// 随机下一首：在「除当前这首之外」的候选里等概率取一首，
// 歌单只有一首时只能返回它自己（此时等价于单曲循环）。
export function pickShuffleIndex(length, currentIndex, random = Math.random) {
  const count = Math.max(0, Math.floor(Number(length)) || 0);
  if (count === 0) return -1;
  if (count === 1) return 0;
  const current = Math.min(count - 1, Math.max(0, Math.floor(Number(currentIndex)) || 0));
  const roll = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * (count - 1));
  const index = roll >= current ? roll + 1 : roll;
  return Math.min(count - 1, Math.max(0, index));
}

// 倍速显示：1 -> "1x"，0.75 -> "0.75x"。
export function formatMusicRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return '1x';
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, '')}x`;
}
