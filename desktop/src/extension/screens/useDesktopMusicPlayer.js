// 音乐播放器（桌面）：把 <audio> 元素包装成「上/下一首、前后 15 秒、倍速、播放模式」。
//
// 判定全部复用共享纯函数（music/playerSettingsPure.js，手机 MusicScreen 同源）：
//   · MUSIC_PLAY_MODES / nextMusicPlayMode   播放模式轮换（停止/单曲/顺序/随机）
//   · MUSIC_RATES / nextMusicRate            倍速轮换
//   · decideAfterFinish                      播完之后做什么（seek0 / next / stop）
//   · formatMusicRate                        倍速显示文案
// 桌面这层只负责「把这些判定作用到 HTMLAudioElement 上」——不再写一份模式逻辑，
// 否则两端播放行为会各自漂移。
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MUSIC_PLAY_MODES,
  decideAfterFinish,
  formatMusicRate,
  nextMusicPlayMode,
  nextMusicRate,
} from '../../../../src/music/playerSettingsPure.js';
import {
  getMusicPlayerSettings,
  saveMusicPlayerSettings,
} from '../../../../src/music/playerSettings.js';

const SEEK_STEP_SECONDS = 15;

export default function useDesktopMusicPlayer({ items, onDurationKnown }) {
  const audioRef = useRef(null);
  const [playingId, setPlayingId] = useState('');
  const [settings, setSettings] = useState({ playMode: 'stop', rate: 1 });
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  // 播完后的「下一首」要读到最新列表与索引：用 ref 避免闭包读到旧值。
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const playingIdRef = useRef(playingId);
  playingIdRef.current = playingId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let alive = true;
    getMusicPlayerSettings()
      .then(value => { if (alive) setSettings(value); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const persist = useCallback(patch => {
    // 本地先改（界面立刻响应），落盘失败不回滚——播放模式丢了不影响听歌。
    setSettings(current => ({ ...current, ...patch }));
    saveMusicPlayerSettings(patch).catch(() => {});
  }, []);

  const playAt = useCallback(index => {
    const list = itemsRef.current || [];
    const item = list[index];
    const node = audioRef.current;
    if (!item || !node) return;
    node.src = item.url;
    node.playbackRate = settingsRef.current.rate || 1;
    node.play()
      .then(() => setPlayingId(item.id))
      .catch(() => setPlayingId(''));
  }, []);

  const toggle = useCallback((item, url) => {
    const node = audioRef.current;
    if (!node || !item || !url) return;
    if (playingIdRef.current === item.id) {
      node.pause();
      setPlayingId('');
      return;
    }
    node.src = url;
    node.playbackRate = settingsRef.current.rate || 1;
    node.play()
      .then(() => setPlayingId(item.id))
      .catch(() => setPlayingId(''));
  }, []);

  const pause = useCallback(() => {
    const node = audioRef.current;
    if (node) node.pause();
    setPlayingId('');
  }, []);

  const seekBy = useCallback(deltaSeconds => {
    const node = audioRef.current;
    if (!node) return;
    const max = Number(node.duration) || 0;
    const next = Math.min(Math.max(0, (Number(node.currentTime) || 0) + deltaSeconds), max || 0);
    try {
      node.currentTime = next;
    } catch (error) {}
  }, []);

  const seekTo = useCallback(ratio => {
    const node = audioRef.current;
    if (!node) return;
    const max = Number(node.duration) || 0;
    if (!max) return;
    try {
      node.currentTime = Math.min(Math.max(0, ratio), 1) * max;
    } catch (error) {}
  }, []);

  const step = useCallback(direction => {
    const list = itemsRef.current || [];
    if (list.length === 0) return;
    const index = list.findIndex(item => item.id === playingIdRef.current);
    const nextIndex = (index + direction + list.length) % list.length;
    playAt(nextIndex);
  }, [playAt]);

  const cycleMode = useCallback(() => {
    persist({ playMode: nextMusicPlayMode(settingsRef.current.playMode) });
  }, [persist]);

  const cycleRate = useCallback(() => {
    const rate = nextMusicRate(settingsRef.current.rate);
    persist({ rate });
    // 立即作用到正在播的音频：用户切倍速就该马上听到变化。
    const node = audioRef.current;
    if (node) node.playbackRate = rate;
  }, [persist]);

  // 播完：交给共享 decideAfterFinish 决定 seek0 / next / stop。
  const handleEnded = useCallback(() => {
    const list = itemsRef.current || [];
    const index = list.findIndex(item => item.id === playingIdRef.current);
    const decision = decideAfterFinish({
      playMode: settingsRef.current.playMode,
      length: list.length,
      currentIndex: index,
    });
    if (decision.kind === 'seek0') {
      const node = audioRef.current;
      if (node) {
        node.currentTime = 0;
        node.play().catch(() => {});
      }
      return;
    }
    if (decision.kind === 'next') {
      playAt(decision.index);
      return;
    }
    setPlayingId('');
  }, [playAt]);

  const handleTimeUpdate = useCallback(() => {
    const node = audioRef.current;
    if (!node) return;
    setPosition(Number(node.currentTime) || 0);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const node = audioRef.current;
    if (!node) return;
    const seconds = Number(node.duration) || 0;
    setDuration(seconds);
    if (seconds > 0 && typeof onDurationKnown === 'function') {
      onDurationKnown(Math.round(seconds * 1000));
    }
  }, [onDurationKnown]);

  return {
    audioRef,
    playingId,
    settings,
    position,
    duration,
    playModeLabel: settings.playMode,
    playModeIndex: MUSIC_PLAY_MODES.indexOf(settings.playMode),
    rateLabel: formatMusicRate(settings.rate),
    toggle,
    pause,
    step,
    seekBy,
    seekTo,
    cycleMode,
    cycleRate,
    seekStepSeconds: SEEK_STEP_SECONDS,
    handlers: {
      onEnded: handleEnded,
      onTimeUpdate: handleTimeUpdate,
      onLoadedMetadata: handleLoadedMetadata,
    },
  };
}
