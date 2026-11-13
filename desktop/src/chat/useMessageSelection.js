// 消息多选与批量删除（桌面）：对应手机 ChatScreen 的「多选 → 全选 → 删除」链路。
//
// 判定全部复用共享层：
//   · toggleMessageSelection / selectableMessageIds（chat/messageSelection.js）；
//   · 删除计划由 chat/messageDeletionPlan.js 算出（含「删光 ≡ 清空」与「连续尾段归档」）；
//   · 记忆摘要失效走 memory/memorySummary.invalidateHistorySummaries；
//   · 向量索引按计划选整段清或按 id 清（storage/vector.js）。
// 本 hook 只负责按计划执行与状态复位，不重写任何一条判定。
import { useCallback, useRef, useState } from 'react';

import {
  selectableMessageIds,
  toggleMessageSelection,
} from '../../../src/chat/messageSelection.js';
import {
  isBuiltinAssistant,
  invalidateHistorySummaries,
  isSessionScopedMemory,
} from '../../../src/memory/memorySummary.js';
import { archiveBranch } from '../../../src/storage/sessionBranches.js';
import {
  removeVectorIndexForMessages,
  removeVectorIndexForSession,
} from '../../../src/storage/vector.js';
import { setSessionGreetingSelected } from '../../../src/storage/sessionList.js';
import { getVectorOwnerId } from '../../../src/vectorMemory/scope.js';
import { deletionConfirmBodyKey, planMessageDeletion } from '../chat/messageDeletionPlan.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';

export default function useMessageSelection({
  messages,
  messagesRef,
  setMessages,
  activeSession,
  activeSessionId,
  characterId,
  charactersRef,
  sessionsRef,
  updateCharacter,
  setGreetingReady,
  refreshSessions,
  isSending,
  ready,
  setQuoteTarget,
  errorRawRef,
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const busyRef = useRef(false);

  const start = useCallback(() => {
    setSelecting(true);
    setSelectedIds([]);
  }, []);

  const cancel = useCallback(() => {
    setSelecting(false);
    setSelectedIds([]);
  }, []);

  const toggle = useCallback(id => {
    setSelectedIds(current => toggleMessageSelection(current, id));
  }, []);

  const allIds = selectableMessageIds(messages);
  const allSelected = allIds.length > 0 && selectedIds.length === allIds.length;
  const toggleAll = useCallback(() => {
    setSelectedIds(current => (current.length === allIds.length ? [] : allIds));
  }, [allIds]);

  // 删除：按计划执行（记忆摘要失效 → 归档尾段 → 开场白复位 → 向量清理 → 替换消息）。
  const removeSelected = useCallback(() => {
    if (busyRef.current || isSending || !ready) return;
    const ids = selectedIds.slice();
    const plan = planMessageDeletion(messagesRef.current || [], ids);
    if (!plan) return;
    const sessionId = String(activeSessionId || '');
    const sessionVersionSnapshot = sessionId;

    Alert.alert(
      tRef.current('chat.deleteMessages.title'),
      tRef.current(deletionConfirmBodyKey(plan), { count: ids.length }),
      [
        { text: tRef.current('common.cancel'), style: 'cancel' },
        {
          text: tRef.current('common.delete'),
          style: 'destructive',
          onPress: async () => {
            busyRef.current = true;
            try {
              // 守卫：确认弹窗期间用户可能切走了会话。
              if (String(activeSessionId || '') !== sessionVersionSnapshot) return;
              // ① 记忆摘要失效：按删除后的消息重算边界（失败就中止，不留下摘要与消息错位）。
              if (activeSession) {
                const ownerId = String(activeSession.characterId || '');
                const latestCharacters = Array.isArray(charactersRef.current) ? charactersRef.current : [];
                const exists = latestCharacters.some(item => item.id === ownerId);
                const latestCharacter = latestCharacters.find(item => item.id === ownerId) || null;
                const scoped = isBuiltinAssistant(latestCharacter)
                  || !exists
                  || isSessionScopedMemory(sessionsRef.current, ownerId, undefined, activeSession.id);
                try {
                  await invalidateHistorySummaries({
                    session: activeSession,
                    messages: plan.remaining,
                    removedIds: plan.ids,
                    scoped,
                    character: latestCharacter,
                    updateCharacter,
                  });
                } catch (error) {
                  Alert.alert(
                    tRef.current('common.error.deleteFailed'),
                    tRef.current('chat.deleteMessages.syncFail.body')
                  );
                  return;
                }
              }
              if (String(activeSessionId || '') !== sessionVersionSnapshot) return;
              // ② 连续尾段先归档成分支（整段删除仍可回溯）。
              if (plan.archive) {
                await archiveBranch(sessionId, plan.archive.forkMessageId, plan.archive.messages)
                  .catch(() => {});
              }
              // ③ 删光 ≡ 旧「清空」：重置开场白选择（否则下次进会话卡在「未选开场白」）。
              if (plan.clearsAll && activeSession && activeSession.type !== 'group') {
                setGreetingReady(false);
                setSessionGreetingSelected(sessionId, false)
                  .then(() => Promise.resolve(refreshSessions()).catch(() => {}))
                  .catch(() => {});
              }
              // ④ 向量索引：整段清 vs 按 id 清。
              const ownerId = getVectorOwnerId(activeSession, characterId);
              if (ownerId) {
                if (plan.vector.mode === 'session') {
                  removeVectorIndexForSession(ownerId, sessionId).catch(() => {});
                } else {
                  removeVectorIndexForMessages(ownerId, sessionId, plan.vector.ids).catch(() => {});
                }
              }
              // ⑤ 替换时间线 + 清引用/错误缓存。
              setMessages(plan.remaining);
              if (plan.ids.length > 0 && errorRawRef && errorRawRef.current) {
                plan.ids.forEach(id => { delete errorRawRef.current[id]; });
              }
              setQuoteTarget(current => (
                current && plan.ids.includes(String(current.id || '')) ? null : current
              ));
              setSelectedIds([]);
              setSelecting(false);
            } finally {
              busyRef.current = false;
            }
          },
        },
      ]
    );
  }, [
    activeSession, activeSessionId, characterId, charactersRef, errorRawRef, isSending,
    messagesRef, ready, refreshSessions, selectedIds, sessionsRef, setGreetingReady,
    setMessages, setQuoteTarget, updateCharacter,
  ]);

  return {
    selecting,
    selectedIds,
    selectedCount: selectedIds.length,
    allSelected,
    allIds,
    start,
    cancel,
    toggle,
    toggleAll,
    removeSelected,
  };
}