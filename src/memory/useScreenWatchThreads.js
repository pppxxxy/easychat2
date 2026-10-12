// 看屏幕对话（screenWatch threads）的管理：加载 / 拆分（有内容 vs 空）/ 删除 / 一键清理。
// 从 MemoryScreen.js 原样外提（无行为变化）：不进「全部」视图，只在「屏幕对话」chip 下展示。
// 存储与纯逻辑仍在 screenWatch/threads.js 与 memory/memoryBuckets.js。
//
// 2026-10-12（合并 d1012d2）：对方在 MemoryScreen 内联版里给出的三处修复并入本 hook——
// ① 读失败与「没有」分开（threadsFailed 三态）；② 删除/清空失败必须弹提示（原先三处
// `.catch(() => {})`）；③ 清空空会话用 Promise.all 整体拒绝（逐条 catch 会吞掉失败条数）。

import { useCallback, useMemo, useState } from 'react';
import { Alert, Platform } from 'react-native';

import { screenThreadPreview, splitScreenThreads } from './memoryBuckets.js';
import { clearScreenWatchThreads, deleteScreenWatchThread, getScreenWatchThreads } from '../screenWatch/threads.js';

export default function useScreenWatchThreads({ t }) {
  const [threads, setThreads] = useState([]);
  const [threadsFailed, setThreadsFailed] = useState(false); // 屏幕对话读取失败（三态里的第三态，见 reloadThreads）

  const reloadThreads = useCallback(async () => {
    try {
      setThreads(await getScreenWatchThreads());
      setThreadsFailed(false);
    } catch (error) {
      // 读不到 ≠ 没有：threads.js 本身是三态（corrupt 先 backupCorruptValue 再抛）；
      // 旧实现在这里 setThreads([])，界面于是显示「没有屏幕对话」——把异常说成正常。
      setThreadsFailed(true);
    }
  }, []);

  // 删除/清空屏幕对话失败必须说出来（口径同 memory/useOrphanRecovery.js 的 scanOrphans / onRecover）——
  // 原先三处都 .catch(() => {})，用户确认删除后什么都没发生、也没有任何提示。
  const reportThreadFailure = useCallback(error => {
    Alert.alert(t('common.error.deleteFailed'), (error && error.message) || t('common.error.storageOrPermission'));
  }, [t]);

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
              .catch(reportThreadFailure);
          },
        },
      ]
    );
  }, [reloadThreads, reportThreadFailure, t]);

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
            // 逐条 catch 会吞掉部分失败：Promise.all 整体拒绝，失败条数与原因才透得出来。
            Promise.all(emptyThreads.map(thread => deleteScreenWatchThread(thread.id)))
              .then(() => reloadThreads())
              .catch(reportThreadFailure);
          },
        },
      ]
    );
  }, [emptyThreads, reloadThreads, reportThreadFailure, t]);

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
            clearScreenWatchThreads().then(() => reloadThreads()).catch(reportThreadFailure);
          },
        },
      ]
    );
  }, [reloadThreads, reportThreadFailure, t, threads.length]);

  return {
    threads,
    threadsFailed,
    activeThreads,
    emptyThreads,
    reloadThreads,
    handleDeleteThread,
    onThreadActions,
    handleClearEmptyThreads,
    handleClearAllThreads,
  };
}
