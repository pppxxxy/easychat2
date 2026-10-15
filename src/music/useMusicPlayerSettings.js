import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_MUSIC_CLIP, getMusicClipSettings, saveMusicClipSettings } from '../storage/settings.js';
import {
  getMusicPlayerSettings,
  nextMusicPlayMode,
  nextMusicRate,
  saveMusicPlayerSettings,
} from './playerSettings.js';
import * as playerService from './playerService.js';

// 播放设置域：播放方式（单曲/顺序/随机）、倍速、音频片段（时长/采样率）。
// 全局持久化，打开时读一次、改动即写（失败不阻断播放）。从 MusicScreen 原样搬出。
//
// FEAT-AC2：playMode 变更必须**同步进 playerService** —— 播完续接的判定在服务层
// （它得在页面不在场时也能续接，那正是本轮的目的）。这里单向推送：页内改 → 服务生效。
export default function useMusicPlayerSettings({ setRate }) {
  const [clipSettings, setClipSettings] = useState(DEFAULT_MUSIC_CLIP);
  // 播放方式与倍速：全局持久化，打开时读一次、改动即写（失败不阻断播放）。
  const [playMode, setPlayMode] = useState('stop');
  const [rate, setRateState] = useState(1);

  useEffect(() => {
    let cancelled = false;
    getMusicPlayerSettings()
      .then(settings => {
        if (cancelled) return;
        setPlayMode(settings.playMode);
        setRateState(settings.rate);
        setRate(settings.rate);
        // 读到的播放方式同步进服务：否则「页面上是顺序播放、服务层却以为 stop」，
        // 播完不会续接（页面不在场时尤其明显）。
        playerService.setPlayMode(settings.playMode);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [setRate]);

  const cyclePlayMode = useCallback(() => {
    setPlayMode(current => {
      const next = nextMusicPlayMode(current);
      saveMusicPlayerSettings({ playMode: next }).catch(() => {});
      playerService.setPlayMode(next);
      return next;
    });
  }, []);

  const cycleRate = useCallback(() => {
    setRateState(current => {
      const next = nextMusicRate(current);
      setRate(next);
      saveMusicPlayerSettings({ rate: next }).catch(() => {});
      return next;
    });
  }, [setRate]);

  // 读取「音频片段」设置（时长/采样率）；改动即时保存。
  useEffect(() => {
    let cancelled = false;
    getMusicClipSettings()
      .then(settings => {
        if (!cancelled) setClipSettings(settings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const updateClipSettings = useCallback(patch => {
    setClipSettings(previous => {
      const next = { ...previous, ...patch };
      saveMusicClipSettings(next).catch(() => {});
      return next;
    });
  }, []);

  return { playMode, rate, clipSettings, cyclePlayMode, cycleRate, updateClipSettings };
}
