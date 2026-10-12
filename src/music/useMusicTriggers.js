import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { saveMusicTriggers } from './library.js';
import {
  collectTriggersToCross,
  isSeekJump,
  makeTriggerId,
  resolveFiredIdsAtPosition,
} from './triggers.js';

// 时间轴打点域：打点持久化 + 越过打点请求评论 + seek 后重新武装已触发集合。
// 从 MusicScreen 原样搬出（行为不变），依赖 current/positionMs/generate/setItems/t 注入。
export default function useMusicTriggers({ current, positionMs, generate, setItems, t }) {
  // 时间轴触发：正常推进时越过打点即请求评论；seek（>2.5s 跳变）落定后按新位置
  // 重算已触发集合——回跳重播自动重新武装，已放过的历史不回放补触发。
  const firedRef = useRef(new Set());
  const firedSongRef = useRef('');
  const lastPositionRef = useRef(0);
  useEffect(() => {
    if (!current) {
      firedSongRef.current = '';
      lastPositionRef.current = 0;
      return;
    }
    if (firedSongRef.current !== current.id) {
      firedSongRef.current = current.id;
      firedRef.current = new Set();
      lastPositionRef.current = positionMs;
      return;
    }
    const previousMs = lastPositionRef.current;
    if (positionMs === previousMs) return;
    lastPositionRef.current = positionMs;
    if (isSeekJump(previousMs, positionMs)) {
      firedRef.current = resolveFiredIdsAtPosition(current.triggers, positionMs);
      return;
    }
    collectTriggersToCross(current.triggers, previousMs, positionMs).forEach(trigger => {
      if (firedRef.current.has(trigger.id)) return;
      firedRef.current.add(trigger.id);
      generate({ kind: 'trigger', atMs: trigger.atMs, note: trigger.note });
    });
  }, [current, positionMs, generate]);

  const persistTriggers = useCallback(async (songId, triggers) => {
    try {
      const updated = await saveMusicTriggers(songId, triggers);
      setItems(list => list.map(item => (item.id === updated.id ? updated : item)));
      // 打点列表变了：按当前进度重算已触发集合，避免沿用旧的 fired 集合漏触发。
      firedRef.current = resolveFiredIdsAtPosition(updated.triggers, positionMs);
      return updated;
    } catch (error) {
      Alert.alert(t('music.save.failed.title'), t('music.save.failed.body'));
      return null;
    }
  }, [positionMs, setItems, t]);

  const addTriggerHere = useCallback(() => {
    if (!current) return;
    const atMs = positionMs;
    const next = [
      ...current.triggers.filter(item => item.atMs !== atMs),
      { id: makeTriggerId(), atMs, note: '' },
    ];
    persistTriggers(current.id, next);
  }, [current, persistTriggers, positionMs]);

  const removeTrigger = useCallback(triggerId => {
    if (!current) return;
    persistTriggers(current.id, current.triggers.filter(item => item.id !== triggerId));
  }, [current, persistTriggers]);

  return { addTriggerHere, removeTrigger };
}
