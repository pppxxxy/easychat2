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

  const beginSendOperation = useCallback(() => {
    if (sendLockRef.current) return null;
    const controller = new AbortController();
    const token = {
      id: ++sendOperationRef.current,
      controller,
      // 记下发起时的会话：收尾时即便已经切走，也能注销对的那一条。
      sessionId: String(activeSessionIdRef.current || ''),
    };
    sourceChangedRef.current = false;
    sendLockRef.current = token;
    abortRef.current = controller;
    // L 系骨架：把「这个会话正在跑」登记到应用级登记表，供运行中角色面板读取/取消。
    // 控制器仍由本 hook 持有并驱动；登记表只存引用（控制器一被中止就自动注销）。
    sessionRuns.start(token.sessionId, {
      controller,
      characterId: activeCharacterIdRef.current,
    });
    setIsSending(true);
    return token;
  }, []);

  const endSendOperation = useCallback(token => {
    if (!token || sendLockRef.current !== token) return;
    if (abortRef.current === token.controller) abortRef.current = null;
    sendLockRef.current = null;
    sessionRuns.finish(token.sessionId);
    setIsSending(false);
  }, []);

  const invalidateSessionOperations = useCallback(() => {
    sessionVersionRef.current += 1;
    openingRequestRef.current += 1;
    if (openingAbortControllerRef.current) {
      openingAbortControllerRef.current.abort();
      openingAbortControllerRef.current = null;
    }
    sendLockRef.current = null;
    if (abortRef.current) {
      abortRef.current.abort();
    }
    inlineImageControllerRef.current?.abort();
    // 会话失效：登记表里该会话的运行一并注销。上面的 abort 已触发自动注销，这里是
    // 显式兜底，覆盖「abortRef 已为 null 但登记仍在」的边界情况。
    sessionRuns.cancel(String(activeSessionIdRef.current || ''));

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
  };
}
