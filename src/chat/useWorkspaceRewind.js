// 分支回退时联动回退工作区文件（Z 系采纳 #7）。
//
// 外提为 hook：ChatScreen 已到行数上限（架构棘轮），把「读设置 → 建 store → 规划 →
// 确认 → 恢复」整段收进这里，聊天页只留一行调用。
//
// 只在**真的会影响文件**时打扰用户（分叉点之后没写过文件 = 不弹框）。

import { useCallback } from 'react';
import { Alert } from 'react-native';

import { useTranslation } from '../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { createWorkspaceStore } from '../workspace/native.js';
import { planWorkspaceRewindForStore, rewindWorkspaceFiles } from '../workspace/rewind.js';

export default function useWorkspaceRewind({ messagesRef, sessionsRef }) {
  const { t } = useTranslation();
  return useCallback(async ({ sessionId, forkMessageId }) => {
    const id = String(sessionId || '');
    if (!id) return;
    // 分叉时刻 = 分叉点消息的时间戳（回退到「那一刻」的工作区状态）。
    const forkMessage = (messagesRef.current || []).find(
      item => String((item && item.id) || '') === String(forkMessageId || '')
    );
    const forkAt = Number(forkMessage && forkMessage.timestamp) || 0;
    if (!forkAt) return;
    const session = (sessionsRef.current || []).find(item => item && item.id === id);
    const characterId = String((session && session.characterId) || '');
    if (!characterId) return;
    let store = null;
    try {
      store = createWorkspaceStore(await getWorkspaceSettings());
    } catch (error) {
      return;
    }
    const plan = await planWorkspaceRewindForStore({ store, characterId, targetAt: forkAt }).catch(() => null);
    if (!plan || plan.restores.length === 0) return;
    Alert.alert(
      t('chat.branch.rewindWorkspace.title'),
      t('chat.branch.rewindWorkspace.body', { count: plan.restores.length }),
      [
        { text: t('chat.branch.rewindWorkspace.skip'), style: 'cancel' },
        {
          text: t('chat.branch.rewindWorkspace.confirm'),
          onPress: () => { rewindWorkspaceFiles({ store, characterId, targetAt: forkAt }).catch(() => {}); },
        },
      ]
    );
  }, [messagesRef, sessionsRef, t]);
}
