// 桌面聊天页的分支切换（读索引 -> 切换 -> 归档当前尾段）。
//
// 与 Android ChatScreen.onCheckoutBranch 同一份纪律：
//   · 分叉点失效（planCheckout.stale）就清理该分支并提示，不硬切；
//   · 切换前把「被替换掉的当前尾段」归档成分支，来回切不丢消息；
//   · 目标分支正文读成功后**删除它的归档**（消息已进入活动时间线）；
//   · 分支正文缺失（索引还在）删掉失效索引；损坏则保留待重试。
// 桌面差异：没有工作区回退、没有角色级记忆总结失效编排——那两项在共享层分别依赖
// workspace store 与角色世界书钩子，桌面首版不接（见 extension 页的说明）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { groupBranchesByFork, planCheckout } from '../../../src/chat/branchTree.js';
import {
  archiveBranch,
  deleteBranch,
  getBranch,
  getBranchIndexStatus,
  pruneStaleBranches,
} from '../../../src/storage/sessionBranches.js';
import { getVectorOwnerId } from '../../../src/vectorMemory/scope.js';
import { removeVectorIndexForSession } from '../../../src/storage/vector.js';
import { useApp } from '../../../src/context/AppContext.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';

export default function useDesktopBranches({ activeSessionId, setMessages, messagesRef, isSending, ready, refreshToken = 0 }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const { sessions, character } = useApp();
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const sessionIdRef = useRef('');
  sessionIdRef.current = String(activeSessionId || '');
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const characterRef = useRef(character);
  characterRef.current = character;
  const busyRef = useRef(false);

  const reload = useCallback(() => {
    const sessionId = String(activeSessionId || '');
    if (!sessionId) {
      setBranches([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    getBranchIndexStatus(sessionId)
      .then(result => {
        if (cancelled || sessionIdRef.current !== sessionId) return;
        setBranches(result && result.status === 'ok' && Array.isArray(result.branches) ? result.branches : []);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  useEffect(() => reload(), [reload, refreshToken]);

  // 切换分支：分叉点之前 + 目标尾段替换活动时间线；被替换的尾段归档。
  const checkout = useCallback(async branch => {
    if (!branch || !branch.id || busyRef.current) return false;
    if (isSending || !ready) return false;
    const sessionId = sessionIdRef.current;
    if (!sessionId) return false;
    busyRef.current = true;
    setCheckingOut(true);
    try {
      const loaded = await getBranch(sessionId, branch.id);
      if (loaded.status === 'corrupt') {
        Alert.alert(tRef.current('chat.branch.checkoutFailed.title'), tRef.current('chat.branch.checkoutFailed.body'));
        return false;
      }
      if (loaded.status !== 'ok' || !loaded.branch) {
        if (loaded.status === 'missing') await deleteBranch(sessionId, branch.id).catch(() => {});
        Alert.alert(tRef.current('chat.branch.stale.title'), tRef.current('chat.branch.stale.body'));
        reload();
        return false;
      }
      const active = Array.isArray(messagesRef.current) ? messagesRef.current : [];
      const plan = planCheckout(active, {
        id: branch.id,
        forkMessageId: branch.forkMessageId,
        messages: loaded.branch.messages,
      });
      if (plan.stale) {
        Alert.alert(tRef.current('chat.branch.stale.title'), tRef.current('chat.branch.stale.body'));
        await pruneStaleBranches(sessionId, new Set(active.map(item => String(item && item.id || '')))).catch(() => {});
        reload();
        return false;
      }
      if (plan.removedTail.length > 0) {
        await archiveBranch(sessionId, plan.forkMessageId, plan.removedTail).catch(() => {});
      }
      await deleteBranch(sessionId, branch.id).catch(() => {});
      const next = [...plan.prefix, ...plan.activated];
      // 分支回退会改变哪些消息还「存在」：该会话的向量索引前缀不再可信，整体作废
      // （与 Android checkout 同口径；下次发送时会重新索引）。
      const checkoutSession = sessionsRef.current.find(item => item.id === sessionId);
      const ownerId = getVectorOwnerId(checkoutSession, String((characterRef.current && characterRef.current.id) || ''));
      if (ownerId) await removeVectorIndexForSession(ownerId, sessionId).catch(() => {});
      setMessages(next);
      reload();
      return true;
    } catch (error) {
      Alert.alert(tRef.current('chat.branch.checkoutFailed.title'), tRef.current('chat.branch.checkoutFailed.body'));
      return false;
    } finally {
      busyRef.current = false;
      setCheckingOut(false);
    }
  }, [isSending, messagesRef, ready, reload, setMessages]);

  const remove = useCallback(async branch => {
    if (!branch || !branch.id || busyRef.current) return false;
    const sessionId = sessionIdRef.current;
    if (!sessionId) return false;
    try {
      await deleteBranch(sessionId, branch.id);
      reload();
      return true;
    } catch (error) {
      Alert.alert(tRef.current('chat.branch.deleteFailed.title'), tRef.current('chat.branch.deleteFailed.body'));
      return false;
    }
  }, [reload]);

  const branchesByFork = useMemo(() => groupBranchesByFork(branches), [branches]);

  return { branches, branchesByFork, loading, checkingOut, reload, checkout, remove };
}