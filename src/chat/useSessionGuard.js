// 从 ChatScreen.js 原样外提（无行为变化）：会话操作守卫。
// 集中管理发送锁、AbortController、操作序号与会话版本号，供发送/切换/失效
// 三类流程共用。captureSessionGuard 依赖的 activeSessionIdRef /
// activeCharacterIdRef 仍由 ChatScreen 持有，以参数传入（ref 对象引用稳定）。

import { useCallback, useRef, useState } from 'react';

import { sessionRuns } from '../agent/runtime/sessionRuns.js';

export default function useSessionGuard({ activeSessionIdRef, activeCharacterIdRef }) {
  const abortRef = useRef(null);
  const sendLockRef = useRef(null);
  const sourceChangedRef = useRef(false);
  const sendOperationRef = useRef(0);
  const switchOperationRef = useRef(0);
  const openingRequestRef = useRef(0);
  const openingAbortControllerRef = useRef(null);
  const sessionVersionRef = useRef(0);
  // 配图生成是另一种「发送中」操作：会话失效时同样要中断。
  const inlineImageControllerRef = useRef(null);
  const captureSessionGuard = useCallback(() => ({
    sessionId: activeSessionIdRef.current,
    characterId: activeCharacterIdRef.current,
    version: sessionVersionRef.current,
  }), []);
  const isSessionGuardCurrent = useCallback(guard => (
    !guard
    || (
      activeSessionIdRef.current === guard.sessionId
      && activeCharacterIdRef.current === guard.characterId
      && sessionVersionRef.current === guard.version
    )
  ), []);
  const [isSending, setIsSending] = useState(false);

  // 界面上的发送锁/控制器只反映「当前活动会话」的运行。切会话后（活动会话变了）调用
  // 本函数重新对齐：切到一个没有运行的会话就解锁，切回一个仍在后台跑的会话就重新上锁。
  const syncActiveRun = useCallback(() => {
    const run = sessionRuns.get(String(activeSessionIdRef.current || ''));
    sendLockRef.current = run ? run.token : null;
    abortRef.current = run ? run.controller : null;
    setIsSending(Boolean(run));
  }, []);

  const beginSendOperation = useCallback(() => {
    const sessionId = String(activeSessionIdRef.current || '');
    // 准入按**会话**判定：同一会话同一时刻只允许一个运行（登记表是唯一准入源）。
    // 别的会话在后台跑不影响这里发起新会话的发送。
    if (sessionRuns.has(sessionId)) return null;
    const controller = new AbortController();
    const token = {
      id: ++sendOperationRef.current,
      controller,
      // 记下发起时的会话：收尾时即便已经切走，也能注销对的那一条。
      sessionId,
    };
    // 登记到应用级登记表：面板据此显示/取消运行；令牌挂在 run 上，切回该会话时用它恢复锁。
    // 控制器仍由本 hook 持有并驱动（中止时登记表自动注销）。
    const run = sessionRuns.start(sessionId, {
      controller,
      characterId: activeCharacterIdRef.current,
      token,
    });
    if (!run) return null;
    sourceChangedRef.current = false;
    sendLockRef.current = token;
    abortRef.current = controller;
    setIsSending(true);
    return token;
  }, []);

  const endSendOperation = useCallback(token => {
    if (!token) return;
    sessionRuns.finish(token.sessionId);
    // 只重算「当前活动会话」的界面状态：结束的是后台会话时，不能误清当前会话的锁。
    syncActiveRun();
  }, [syncActiveRun]);

  // 会话切换时的失效：推进版本号，让飞行中回复的界面写入失效（isSessionGuardCurrent 转 false），
  // 但**不中止**正在跑的运行——它继续在后台跑完，结果落回它自己的会话（见 useChatSend 的
  // 后台落库分支）。这里只把界面上的锁/控制器摘掉，避免新会话被旧运行的锁挡住；
  // 切回时由 syncActiveRun 重新对齐。真正的中止只有两条路：用户点停止（abort 控制器）
  // 与运行中面板取消（sessionRuns.cancel）。
  const invalidateSessionOperations = useCallback(() => {
    sessionVersionRef.current += 1;
    openingRequestRef.current += 1;
    if (openingAbortControllerRef.current) {
      openingAbortControllerRef.current.abort();
      openingAbortControllerRef.current = null;
    }
    inlineImageControllerRef.current?.abort();
    sendLockRef.current = null;
    abortRef.current = null;
    setIsSending(false);
  }, []);

  return {
    isSending,
    setIsSending,
    abortRef,
    sendLockRef,
    sourceChangedRef,
    switchOperationRef,
    openingRequestRef,
    openingAbortControllerRef,
    sessionVersionRef,
    inlineImageControllerRef,
    captureSessionGuard,
    isSessionGuardCurrent,
    beginSendOperation,
    endSendOperation,
    invalidateSessionOperations,
    syncActiveRun,
  };
}
