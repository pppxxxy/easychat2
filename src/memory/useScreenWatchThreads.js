// 看屏幕对话（screenWatch threads）的管理：加载 / 拆分（有内容 vs 空）/ 删除 / 一键清理。
// 从 MemoryScreen.js 原样外提（无行为变化）：不进「全部」视图，只在「屏幕对话」chip 下展示。
// 存储与纯逻辑仍在 screenWatch/threads.js 与 memory/memoryBuckets.js。

import { useCallback, useMemo, useState } from 'react';
import { Alert, Platform } from 'react-native';

import { screenThreadPreview, splitScreenThreads } from './memoryBuckets.js';
import { clearScreenWatchThreads, deleteScreenWatchThread, getScreenWatchThreads } from '../screenWatch/threads.js';

export default function useScreenWatchThreads({ t }) {
  const [threads, setThreads] = useState([]);

  const reloadThreads = useCallback(async () => {
    try {
      setThreads(await getScreenWatchThreads());
    } catch (error) {
      setThreads([]);
    }
  }, []);

  const { active: activeThreads, empty: emptyThreads } = useMemo(
    () => splitScreenThreads(threads),
    [threads]
  );

  const handleDeleteThread = useCallback(thread => {
    if (!thread) return;
    const name = String(thread.characterName || '').trim() || t('common.characterFallback');
    Alert.alert(
      t('memory.screenWatch.delete.title'),
      t('memory.screenWatch.delete.body', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteScreenWatchThread(thread.id)
              .then(() => reloadThreads())
              .catch(() => {});
          },
        },
      ]
    );
  }, [reloadThreads, t]);

  // 长按屏幕对话行：与主列表一致的「长按出操作单」交互（这里只有删除）。
  const onThreadActions = useCallback(thread => {
    const name = String(thread.characterName || '').trim() || t('common.characterFallback');
    const buttons = [
      { text: t('common.delete'), style: 'destructive', onPress: () => handleDeleteThread(thread) },
    ];
    if (Platform.OS === 'ios') buttons.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(name, screenThreadPreview(thread) || undefined, buttons, { cancelable: true });
  }, [handleDeleteThread, t]);

  // 空会话（0 条 entry）不逐行展示，聚合成一行可一键清理的入口。
  const handleClearEmptyThreads = useCallback(() => {
    if (emptyThreads.length === 0) return;
    Alert.alert(
      t('memory.screenWatch.clearEmptyConfirm.title'),
      t('memory.screenWatch.clearEmptyConfirm.body', { count: emptyThreads.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            Promise.all(emptyThreads.map(thread => deleteScreenWatchThread(thread.id).catch(() => {})))
              .then(() => reloadThreads());
          },
        },
      ]
    );
  }, [emptyThreads, reloadThreads, t]);

  const handleClearAllThreads = useCallback(() => {
    if (threads.length === 0) return;
    Alert.alert(
      t('memory.screenWatch.clearAllConfirm.title'),
      t('memory.screenWatch.clearAllConfirm.body', { count: threads.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            clearScreenWatchThreads().then(() => reloadThreads()).catch(() => {});
          },
        },
      ]
    );
  }, [reloadThreads, t, threads.length]);

  return {
    threads,
    activeThreads,
    emptyThreads,
    reloadThreads,
    handleDeleteThread,
    onThreadActions,
    handleClearEmptyThreads,
    handleClearAllThreads,
  };
}
