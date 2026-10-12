// 孤儿会话恢复：扫出「消息还在、会话没了」的对话，供用户挑角色恢复。
// 从 MemoryScreen.js 原样外提（无行为变化）：加载完成即扫一次；恢复后从列表移除该条。
// 存储读取在 storage/sessions.js（findOrphanSessions / restoreSession）。

import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { findOrphanSessions, restoreSession } from '../storage/sessions.js';
import { getUserProfile } from '../storage/personas.js';

export default function useOrphanRecovery({ loaded, refreshSessions, t }) {
  const [orphans, setOrphans] = useState([]);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [userName, setUserName] = useState('');

  const scanOrphans = useCallback(async () => {
    try {
      const [list, profile] = await Promise.all([
        findOrphanSessions(),
        getUserProfile().catch(() => null),
      ]);
      setOrphans(list);
      setUserName(String((profile && profile.userName) || '').trim());
    } catch (error) {
      setOrphans([]);
      Alert.alert(
        t('memory.scan.fail.title'),
        (error && error.message) || t('memory.scan.fail.body')
      );
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    scanOrphans();
  }, [loaded, scanOrphans]);

  const onRecover = useCallback(async (orphan, characterId) => {
    try {
      await restoreSession(orphan.sessionId, characterId);
      await refreshSessions();
      setOrphans(current => current.filter(item => item.sessionId !== orphan.sessionId));
      Alert.alert(t('memory.recover.success.title'), t('memory.recover.success.body'));
      return true;
    } catch (error) {
      Alert.alert(t('memory.recover.fail.title'), (error && error.message) || t('common.error.retryLater'));
      return false;
    }
  }, [refreshSessions, restoreSession]);

  return { orphans, recoverOpen, setRecoverOpen, userName, onRecover };
}
