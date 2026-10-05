// 一起听歌的播放设置：归一化、顺序/随机下一首、倍速显示 + 存储往返 + 接线断言。
//
// 这一批的三件事：播放方式四档（播完停止 / 单曲循环 / 歌单顺序 / 歌单随机）、
// 倍速五档、以及把「左右三角」从 ±15 秒归还给上一首 / 下一首（跳时间改用 -15 / +15）。
//
// 加载方式照 bookReaderSettings 的做法：playerSettings 会 import storage/io，
// 而 io 依赖 expo-file-system 这类原生模块，Node 里直接 import 会 ERR_MODULE_NOT_FOUND；
// 因此用 babel 转译 + Module._load 打桩加载，测的是同一份真实实现。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const settingsPath = path.resolve('src/music/playerSettings.js');
const transformed = babel.transformSync(fs.readFileSync(settingsPath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: settingsPath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === '../storage/io.js') return ioStub;
  return originalLoad.call(this, request, parent, isMain);
};
let settings;
try {
  const runtime = new Module(settingsPath);
  runtime.filename = settingsPath;
  runtime.paths = Module._nodeModulePaths(path.dirname(settingsPath));
  runtime._compile(transformed, settingsPath);
  settings = runtime.exports;
} finally {
  Module._load = originalLoad;
}

const {
  DEFAULT_MUSIC_PLAYER_SETTINGS,
  MUSIC_PLAY_MODES,
  MUSIC_RATES,
  formatMusicRate,
  getMusicPlayerSettings,
  nextMusicPlayMode,
  nextMusicRate,
  nextSequentialIndex,
  normalizeMusicPlayerSettings,
  pickShuffleIndex,
  saveMusicPlayerSettings,
} = settings;

test('播放方式与倍速：档位齐全，非法值回落默认', () => {
  assert.deepEqual(MUSIC_PLAY_MODES, ['stop', 'repeatOne', 'sequential', 'shuffle']);
  assert.deepEqual(MUSIC_RATES, [0.5, 0.75, 1, 1.5, 2]);
  assert.deepEqual(DEFAULT_MUSIC_PLAYER_SETTINGS, { playMode: 'stop', rate: 1 });

  assert.equal(normalizeMusicPlayerSettings(null).playMode, 'stop', '默认播完停止（原行为）');
  assert.equal(normalizeMusicPlayerSettings({ playMode: 'nope' }).playMode, 'stop');
  assert.equal(normalizeMusicPlayerSettings({ playMode: 'shuffle' }).playMode, 'shuffle');
  // 倍速只认五个档位：1.25 这类没列出的值回落 1x（否则会存进一个界面上选不回来的数）
  assert.equal(normalizeMusicPlayerSettings({ rate: 1.25 }).rate, 1);
  assert.equal(normalizeMusicPlayerSettings({ rate: 1.5 }).rate, 1.5);
  assert.equal(normalizeMusicPlayerSettings({ rate: '0.5' }).rate, 0.5);
  assert.equal(normalizeMusicPlayerSettings({}).rate, 1);
});

test('循环切换：播放方式四档、倍速五档，都能转回起点', () => {
  let mode = 'stop';
  const seen = [];
  for (let index = 0; index < MUSIC_PLAY_MODES.length; index += 1) {
    seen.push(mode);
    mode = nextMusicPlayMode(mode);
  }
  assert.deepEqual(seen, ['stop', 'repeatOne', 'sequential', 'shuffle']);
  assert.equal(mode, 'stop', '转一圈回到起点');

  let rate = 1;
  const rates = [1];
  for (let index = 0; index < MUSIC_RATES.length - 1; index += 1) {
    rate = nextMusicRate(rate);
    rates.push(rate);
  }
  assert.deepEqual(rates, [1, 1.5, 2, 0.5, 0.75]);
  assert.equal(nextMusicRate(rate), 1, '转一圈回到 1x');
  assert.equal(nextMusicRate(9), 1, '不在档位里的值回落 1x');
});

test('顺序播放：末首接回第一首，空歌单返回 -1', () => {
  assert.equal(nextSequentialIndex(3, 0), 1);
  assert.equal(nextSequentialIndex(3, 2), 0, '最后一首接回第一首');
  assert.equal(nextSequentialIndex(1, 0), 0, '只有一首时停在它自己');
  assert.equal(nextSequentialIndex(0, 0), -1, '空歌单没有下一首');
});

test('随机播放：不重复当前这首，单曲歌单只能返回自己', () => {
  assert.equal(pickShuffleIndex(0, 0), -1);
  assert.equal(pickShuffleIndex(1, 0), 0);

  // 五首歌、当前第 3 首：取样 200 次，既不该出现当前这首，也应覆盖到其余四首
  const hits = new Set();
  for (let index = 0; index < 200; index += 1) {
    const picked = pickShuffleIndex(5, 2);
    assert.notEqual(picked, 2, '随机下一首不能是当前这首');
    assert.ok(picked >= 0 && picked < 5, '下标必须落在歌单范围内');
    hits.add(picked);
  }
  assert.equal(hits.size, 4, '其余四首都能被随机到');

  // 边界：random 逼近 0 / 1 时不越界
  assert.equal(pickShuffleIndex(5, 0, () => 0.999999), 4);
  assert.equal(pickShuffleIndex(5, 4, () => 0), 0);
});

test('倍速显示：整数不带小数，0.75 保留两位', () => {
  assert.equal(formatMusicRate(1), '1x');
  assert.equal(formatMusicRate(2), '2x');
  assert.equal(formatMusicRate(0.5), '0.5x');
  assert.equal(formatMusicRate(0.75), '0.75x');
  assert.equal(formatMusicRate(1.5), '1.5x');
  assert.equal(formatMusicRate(0), '1x', '非法值显示 1x');
  assert.equal(formatMusicRate(undefined), '1x');
});

test('存储往返：保存后读回一致，局部更新不打回默认，损坏数据回落默认', async () => {
  assert.deepEqual(await getMusicPlayerSettings(), DEFAULT_MUSIC_PLAYER_SETTINGS);
  const saved = await saveMusicPlayerSettings({ playMode: 'shuffle', rate: 1.5 });
  assert.deepEqual(saved, { playMode: 'shuffle', rate: 1.5 });
  assert.deepEqual(await getMusicPlayerSettings(), { playMode: 'shuffle', rate: 1.5 });

  const patched = await saveMusicPlayerSettings({ rate: 2 });
  assert.deepEqual(patched, { playMode: 'shuffle', rate: 2 }, '只改倍速不应把播放方式打回默认');

  store.set('@easychat2_music_player', '{not json');
  assert.deepEqual(await getMusicPlayerSettings(), DEFAULT_MUSIC_PLAYER_SETTINGS, '损坏数据回落默认');
});

test('播放控件：左右三角是上一首/下一首，跳时间交给 -15 / +15', () => {
  const screen = read('src/music/MusicScreen.js');
  // 需求 3：三角改成切歌
  assert.ok(screen.includes('handlePrevTrack') && screen.includes('handleNextTrack'), '上一首/下一首处理');
  assert.ok(screen.includes('name="play-skip-back"'), '上一首用 skip 图标');
  assert.ok(screen.includes('name="play-skip-forward"'), '下一首用 skip 图标');
  assert.ok(screen.includes('SEEK_STEP_SECONDS'), '跳时间步长常量');
  assert.ok(screen.includes('styles.seekButton'), '跳时间有自己的按钮样式');
  assert.ok(!screen.includes('name="play-back"'), '原来的 ±15 三角图标已让位给切歌');
  // 需求 1：四种播放方式 + 播完处理
  assert.ok(screen.includes('PLAY_MODE_META'), '播放方式图标与文案表');
  assert.ok(screen.includes('cyclePlayMode'), '点击循环切换');
  assert.ok(screen.includes("playMode === 'repeatOne'"), '单曲循环分支');
  assert.ok(screen.includes('nextSequentialIndex(items.length, currentIndex)'), '顺序下一首');
  assert.ok(screen.includes('pickShuffleIndex(items.length, currentIndex)'), '随机下一首');
  assert.ok(screen.includes('status.finished'), '播完触发');
  assert.ok(screen.includes('finishedHandledRef'), '防重入（结束会多次推送状态）');
  assert.ok(screen.includes('getMusicPlayerSettings') && screen.includes('saveMusicPlayerSettings'),
    '播放方式与倍速都要持久化');
  // 需求 2：倍速
  assert.ok(screen.includes('cycleRate') && screen.includes('formatMusicRate'), '倍速切换与显示');
  const player = read('src/music/useMusicPlayer.js');
  assert.ok(player.includes('setPlaybackRate'), '走 expo-audio 的倍速 API');
  assert.ok(player.includes('shouldCorrectPitch = true'), '变速不变调');
  assert.ok(/applyRate\(player\);/.test(player), '每次载入后重新应用倍速（replace 会重置 rate）');
  assert.ok(player.includes('setRate'), '对外暴露 setRate');
});
