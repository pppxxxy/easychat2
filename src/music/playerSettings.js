// 一起听歌的播放设置：播放方式 + 播放倍速。全局一份（不分歌），
// 与阅读器的 readerSettings 同构；读取失败回退默认，不阻断播放。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { readJson } from '../storage/io.js';

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

export async function getMusicPlayerSettings() {
  const stored = await readJson(MUSIC_PLAYER_SETTINGS_KEY, DEFAULT_MUSIC_PLAYER_SETTINGS);
  return normalizeMusicPlayerSettings(stored);
}

export async function saveMusicPlayerSettings(patch) {
  const current = await getMusicPlayerSettings().catch(() => DEFAULT_MUSIC_PLAYER_SETTINGS);
  const next = normalizeMusicPlayerSettings({ ...current, ...(patch || {}) });
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
