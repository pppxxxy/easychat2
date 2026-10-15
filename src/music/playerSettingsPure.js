// 一起听歌播放设置的**纯逻辑层**（零依赖，Node 直测）。
//
// 为什么从 playerSettings.js 拆出来：那个文件 import AsyncStorage 与 storage/io
//（后者依赖 expo-file-system），在 Node 里 import 不了 → 依赖它的模块全都无法单测。
// 而 FEAT-AC2 的音乐工具 schema 要用到播放方式四档、倍速五档与「下一首是谁」的判定，
// 于是它必须能 import 这些常量而不拉进原生依赖（M2.5 的 overlayThreadParse.js、
// FIX-7 的 modelCapabilities.js 都是同一个原因拆出来的）。
//
// 拆法：**值域与纯函数留在这里；读写存储留在 playerSettings.js**（它再原样 re-export
// 本文件的全部导出，既有引用点一个都不用改）。

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

/**
 * FEAT-AC2：播完之后的**续接决策**（纯函数，服务层与单测共用）。
 *
 * 返回 { kind, index? }：
 *   · kind='seek0'  —— 回到开头重播（单曲循环）
 *   · kind='next'   —— 切到 index
 *   · kind='stop'   —— 停住但保留当前曲目
 *
 * 为什么把它抽成纯函数：这是「后台连播」的全部判定逻辑，也是 FEAT-AC2 真正的风险面
 *（验收第 6 条专门验它）。抽出来就能在 Node 里把四种播放方式 × 边界（单曲/空列表）
 * 全测一遍，而不必真机放歌。
 */
export function decideAfterFinish({ playMode, length, currentIndex }) {
  const count = Math.max(0, Math.floor(Number(length)) || 0);
  if (count === 0) return { kind: 'stop' };
  const mode = MUSIC_PLAY_MODES.includes(playMode) ? playMode : 'stop';
  if (mode === 'repeatOne') return { kind: 'seek0' };
  if (mode === 'sequential') return { kind: 'next', index: nextSequentialIndex(count, currentIndex) };
  if (mode === 'shuffle') return { kind: 'next', index: pickShuffleIndex(count, currentIndex) };
  return { kind: 'stop' };
}
