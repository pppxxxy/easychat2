// FEAT-AC2 P0-1：一起听歌的**播放器单例服务**。
//
// 为什么必须有这个文件（本轮的立项理由）：
// 此前播放器活在 useMusicPlayer 的 useRef 里，而那个 hook 全仓唯一使用点是
// MusicScreen —— **播放器随音乐页生灭**。人在别的页面/别的 app（悬浮窗的主场景）时
// 根本没有播放器实例，工具想驱动也没东西可抓。
// 本服务把播放器 + 队列（playAt / 自动续接 / playMode / rate）搬成**模块级单例**：
// 页面挂载 = 订阅，卸载 = 退订，**不销毁播放**。
//
// 分层（与 FEAT-AC1 同一套纪律）：
//   · 本文件是**脏层**（碰 expo-audio 原生模块）；
//   · 队列判定（播完切谁）在 ./playerSettingsPure.js 的 decideAfterFinish —— 纯函数可直测。
//
// 与页面的耦合边界（迁移时逐个核对过的三处，见任务书 P0-1）：
//   ① durationMs 首播回填 —— 留在页面（它要写存储），服务只提供 status。
//   ② 打点触发器的 fired 集合 —— 留在页面（useMusicTriggers）。
//   ③ 开场评论 openingDoneRef —— 留在页面（它要调 generate）。
// 服务只管「放什么、放到哪、播完去哪」，不碰评论与打点。

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
// 锁屏/通知栏媒体标题的兜底文案走 i18n：它是**系统界面可见**的，
// 硬编码中文会在英文系统的通知栏里显示中文。用 tActive 同步取词（非 hook 上下文也可用）。
import { tActive } from '../i18n/index.js';
import {
  DEFAULT_MUSIC_PLAYER_SETTINGS,
  decideAfterFinish,
  normalizeMusicPlayerSettings,
} from './playerSettingsPure.js';

const UPDATE_INTERVAL_MS = 100;

const EMPTY_STATUS = { playing: false, positionMs: 0, durationMs: 0, loaded: false, finished: false };

function toServiceStatus(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    playing: source.playing === true,
    positionMs: Math.max(0, Math.round((Number(source.currentTime) || 0) * 1000)),
    durationMs: Math.max(0, Math.round((Number(source.duration) || 0) * 1000)),
    loaded: source.isLoaded === true,
    finished: source.didJustFinish === true,
  };
}

// ---------- 单例状态 ----------
let player = null;
let currentItem = null;
// 队列 = 当前播放上下文（曲库全量或某个歌单的曲目列表），顺序即歌单顺序。
let queue = [];
let playMode = DEFAULT_MUSIC_PLAYER_SETTINGS.playMode;
let rate = DEFAULT_MUSIC_PLAYER_SETTINGS.rate;
let status = EMPTY_STATUS;
let audioModeConfigured = false;

// 订阅者：页面挂载即订阅（拿到 status 推送），卸载退订。**不影响播放**。
const subscribers = new Set();
// 播完的防重入：一次结束会因多次状态推送重复触发（原实现用 ref，搬来模块级）。
let finishedHandled = false;

function emit() {
  for (const listener of [...subscribers]) {
    try {
      listener(status, snapshot());
    } catch (error) {
      // 单个订阅者抛错不该影响其余订阅者与播放本身。
    }
  }
}

/** 当前状态快照（工具与页面都用这个形状，避免两处各拼一份）。 */
export function snapshot() {
  const index = queue.findIndex(item => item.id === (currentItem && currentItem.id));
  return {
    current: currentItem ? { id: currentItem.id, name: currentItem.name } : null,
    status: { ...status },
    playMode,
    rate,
    queueLength: queue.length,
    // 队列余量：还有几首没放（不含当前）。stop 模式下这个数没有实际意义，如实给数。
    remaining: index >= 0 ? queue.length - index - 1 : 0,
  };
}

/** 订阅状态推送（返回退订函数）。页面挂载时调，卸载时调返回的函数。 */
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  subscribers.add(listener);
  // 立即推一次当前状态：新挂载的页面要马上显示正确进度，而不是等下一次事件。
  try {
    listener(status, snapshot());
  } catch (error) {}
  return () => { subscribers.delete(listener); };
}

function ensureAudioMode() {
  if (audioModeConfigured) return;
  audioModeConfigured = true;
  setAudioModeAsync({ shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
}

function getOrCreatePlayer(item) {
  if (player) return player;
  player = createAudioPlayer({ uri: item.uri }, { updateInterval: UPDATE_INTERVAL_MS });
  player.addListener('playbackStatusUpdate', raw => {
    status = toServiceStatus(raw);
    emit();
    if (!status.finished) {
      finishedHandled = false;
    } else if (!finishedHandled) {
      // 播完续接：判定逻辑在纯层（decideAfterFinish），这里只负责执行。
      finishedHandled = true;
      handleFinished();
    }
  });
  return player;
}

// 变速不变调：保持音高（否则 0.5x 会变成一片闷响，1.5x 会变尖）。
function applyRate() {
  if (!player) return;
  try {
    if (typeof player.setPlaybackRate === 'function') {
      player.setPlaybackRate(rate, 'medium');
    } else {
      player.playbackRate = rate;
    }
    player.shouldCorrectPitch = true;
  } catch (error) {}
}

/**
 * 载入并播放某首歌。**同 uri 重复调用视为恢复播放**（不重播，与旧 hook 口径一致）。
 * @param {object} item 曲目（需要 id/name/uri）
 * @param {{ autoPlay?: boolean, index?: number }} options
 */
export function load(item, { autoPlay = true } = {}) {
  if (!item || !item.uri) return;
  ensureAudioMode();
  const sameTrack = currentItem && currentItem.id === item.id && currentItem.uri === item.uri;
  const instance = getOrCreatePlayer(item);
  if (!sameTrack) {
    try {
      instance.replace({ uri: item.uri });
    } catch (error) {}
    status = { ...EMPTY_STATUS };
    finishedHandled = false;
  }
  currentItem = { id: item.id, name: item.name, uri: item.uri };
  // 每次载入都重新应用倍速：replace 之后播放器的 rate 会回到 1。
  applyRate();
  try {
    // 锁屏媒体控制 + 前台服务保活；title 缺失时用 i18n 的「正在播放」兜底
    // （系统通知栏/锁屏直接显示这个标题，必须随界面语言）。
    instance.setActiveForLockScreen(true, {
      title: String(item.name || tActive('music.player.nowPlayingFallback')),
    });
  } catch (error) {}
  if (autoPlay) {
    try {
      instance.play();
    } catch (error) {}
  }
  emit();
  return snapshot();
}

/** 设置整个队列（曲库全量或某歌单的曲目）。 */
export function setQueue(items) {
  queue = Array.isArray(items) ? items.filter(item => item && item.id && item.uri) : [];
  emit();
  return queue.length;
}

/** 按队列下标切歌（会环绕：-1 取末首，越界回到开头）。 */
export function playAt(index, { autoPlay = true } = {}) {
  if (queue.length === 0) return null;
  const bounded = ((Math.floor(Number(index)) || 0) % queue.length + queue.length) % queue.length;
  const item = queue[bounded];
  if (!item) return null;
  load(item, { autoPlay });
  return item;
}

/** 当前曲目在队列里的下标（找不到按 0，与页面旧口径一致）。 */
export function currentIndex() {
  const index = queue.findIndex(item => item.id === (currentItem && currentItem.id));
  return index >= 0 ? index : 0;
}

/** 播完后的续接执行（判定在纯层）。 */
function handleFinished() {
  const decision = decideAfterFinish({
    playMode,
    length: queue.length,
    currentIndex: currentIndex(),
  });
  if (decision.kind === 'seek0') {
    // 先回到开头再重播：播放位置停在末尾时直接 play 会立刻再次触发 finished。
    // seek 之后延迟一帧再 load，避免与本次 finished 事件重入。
    seekToSeconds(0).then(() => load(currentItem)).catch(() => {});
    return;
  }
  if (decision.kind === 'next') {
    playAt(decision.index);
    return;
  }
  // stop：停住但保留当前曲目，用户可直接再点播放从头听。
  stop();
}

export function play() {
  if (!player) return;
  try {
    player.play();
  } catch (error) {}
}

export function pause() {
  if (!player) return;
  try {
    player.pause();
  } catch (error) {}
}

/** 切换播放/暂停（页面点当前曲目时用）。 */
export function toggle() {
  if (!player) return;
  try {
    if (player.playing) player.pause();
    else player.play();
  } catch (error) {}
}

export function seekToSeconds(seconds) {
  if (!player) return Promise.resolve();
  const target = Math.max(0, Number(seconds) || 0);
  try {
    return Promise.resolve(player.seekTo(target)).catch(() => {});
  } catch (error) {
    return Promise.resolve();
  }
}

export function setRate(value) {
  rate = Math.max(0.25, Math.min(4, Number(value) || 1));
  applyRate();
  emit();
  return rate;
}

export function getRate() {
  return rate;
}

export function setPlayMode(mode) {
  const normalized = normalizeMusicPlayerSettings({ playMode: mode }).playMode;
  playMode = normalized;
  emit();
  return playMode;
}

export function getPlayMode() {
  return playMode;
}

/** 停住但**保留当前曲目**（用户可直接再播放）。与 release 不同：不销毁播放器。 */
export function stop() {
  if (!player) {
    status = EMPTY_STATUS;
    return;
  }
  try {
    player.pause();
    player.clearLockScreenControls();
  } catch (error) {}
  status = { ...EMPTY_STATUS };
  emit();
}

/**
 * 彻底释放播放器（**只在确认不再需要播放时调用**，例如 app 退出或用户明确停止并关闭）。
 *
 * 注意与 stop 的区别：stop 是「停住但保留」（页面卸载走的是订阅退订，**不调这个**）——
 * 这正是本轮要修的「播放器随屏生灭」：页面卸载只退订，播放继续。
 */
export function release() {
  const instance = player;
  player = null;
  currentItem = null;
  queue = [];
  status = EMPTY_STATUS;
  finishedHandled = false;
  if (!instance) return;
  try {
    instance.clearLockScreenControls();
  } catch (error) {}
  try {
    instance.remove();
  } catch (error) {}
}

/** 测试可见：重置单例内部状态（不碰原生模块）。 */
export function __resetForTests() {
  subscribers.clear();
  player = null;
  currentItem = null;
  queue = [];
  playMode = DEFAULT_MUSIC_PLAYER_SETTINGS.playMode;
  rate = DEFAULT_MUSIC_PLAYER_SETTINGS.rate;
  status = EMPTY_STATUS;
  finishedHandled = false;
  audioModeConfigured = false;
}
