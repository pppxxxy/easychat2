// 一起听歌播放器 hook：包装 expo-audio 1.1.1（已对照 node_modules 类型核实，不是 expo-av）。
// 关键事实：
// - createAudioPlayer(source, { updateInterval }) 建播放器；状态经 'playbackStatusUpdate' 事件推送；
//   currentTime/duration 单位是秒，这里统一换算成毫秒对外。
// - setAudioModeAsync({ shouldPlayInBackground, interruptionMode }) 是全局音频模式。
// - player.setActiveForLockScreen(true, metadata) 必须在播放前调用：Android 后台播放靠
//   前台服务撑着，缺它进程数分钟内会被系统回收，锁屏媒体控制同样依赖它。
// - 换曲用 player.replace(source)（复用同一播放器），卸载走 clearLockScreenControls + remove。

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

const UPDATE_INTERVAL_MS = 100;

const EMPTY_STATUS = { playing: false, positionMs: 0, durationMs: 0, loaded: false, finished: false };

function toScreenStatus(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    playing: source.playing === true,
    positionMs: Math.max(0, Math.round((Number(source.currentTime) || 0) * 1000)),
    durationMs: Math.max(0, Math.round((Number(source.duration) || 0) * 1000)),
    loaded: source.isLoaded === true,
    finished: source.didJustFinish === true,
  };
}

export function useMusicPlayer() {
  const playerRef = useRef(null);
  const uriRef = useRef('');
  // 当前倍速：换曲（player.replace）在部分平台上会把 rate 重置回 1，
  // 所以每次载入后都要按这个值重新应用一次。
  const rateRef = useRef(1);
  const [status, setStatus] = useState(EMPTY_STATUS);

  useEffect(() => {
    setAudioModeAsync({ shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
  }, []);

  useEffect(() => () => {
    const player = playerRef.current;
    playerRef.current = null;
    uriRef.current = '';
    if (!player) return;
    try {
      player.clearLockScreenControls();
    } catch (error) {}
    try {
      player.remove();
    } catch (error) {}
  }, []);

  const getOrCreatePlayer = useCallback(item => {
    if (playerRef.current) return playerRef.current;
    const player = createAudioPlayer({ uri: item.uri }, { updateInterval: UPDATE_INTERVAL_MS });
    player.addListener('playbackStatusUpdate', raw => {
      setStatus(toScreenStatus(raw));
    });
    playerRef.current = player;
    return player;
  }, []);

  // 变速不变调：保持音高（否则 0.5x 会变成一片闷响，1.5x 会变尖）。
  const applyRate = useCallback(player => {
    if (!player) return;
    const rate = rateRef.current;
    try {
      if (typeof player.setPlaybackRate === 'function') {
        player.setPlaybackRate(rate, 'medium');
      } else {
        player.playbackRate = rate;
      }
      player.shouldCorrectPitch = true;
    } catch (error) {}
  }, []);

  // 载入并立即播放。同一首歌重复调用视为恢复播放（seek 语义交给 seekToSeconds）。
  const load = useCallback((item, { autoPlay = true } = {}) => {
    if (!item || !item.uri) return;
    const player = getOrCreatePlayer(item);
    if (uriRef.current !== item.uri) {
      try {
        player.replace({ uri: item.uri });
      } catch (error) {}
      uriRef.current = item.uri;
      setStatus({ ...EMPTY_STATUS });
    }
    // 每次载入都重新应用倍速：replace 之后播放器的 rate 会回到 1。
    applyRate(player);
    try {
      // 锁屏媒体控制 + 前台服务保活；title 缺失时用文件名兜底。
      player.setActiveForLockScreen(true, { title: String(item.name || '正在播放') });
    } catch (error) {}
    if (autoPlay) {
      try {
        player.play();
      } catch (error) {}
    }
  }, [applyRate, getOrCreatePlayer]);

  // 设置倍速（0.25x ~ 4x）；播放器尚未创建时只记下来，载入时统一应用。
  const setRate = useCallback(rate => {
    const value = Math.max(0.25, Math.min(4, Number(rate) || 1));
    rateRef.current = value;
    applyRate(playerRef.current);
    return value;
  }, [applyRate]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    try {
      if (player.playing) player.pause();
      else player.play();
    } catch (error) {}
  }, []);

  const pause = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    try {
      player.pause();
    } catch (error) {}
  }, []);

  const seekToSeconds = useCallback(seconds => {
    const player = playerRef.current;
    if (!player) return Promise.resolve();
    const target = Math.max(0, Number(seconds) || 0);
    try {
      return Promise.resolve(player.seekTo(target)).catch(() => {});
    } catch (error) {
      return Promise.resolve();
    }
  }, []);

  const stop = useCallback(() => {
    const player = playerRef.current;
    uriRef.current = '';
    setStatus(EMPTY_STATUS);
    if (!player) return;
    try {
      player.pause();
      player.clearLockScreenControls();
    } catch (error) {}
  }, []);

  return { status, load, toggle, pause, seekToSeconds, setRate, stop };
}
