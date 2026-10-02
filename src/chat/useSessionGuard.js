// 从 ChatScreen.js 原样外提（无行为变化）：会话操作守卫。
// 集中管理发送锁、AbortController、操作序号与会话版本号，供发送/切换/失效
// 三类流程共用。captureSessionGuard 依赖的 activeSessionIdRef /
// activeCharacterIdRef 仍由 ChatScreen 持有，以参数传入（ref 对象引用稳定）。

import { useCallback, useRef, useState } from 'react';

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
    const token = { id: ++sendOperationRef.current, controller };
    sourceChangedRef.current = false;
    sendLockRef.current = token;
    abortRef.current = controller;
    setIsSending(true);
    return token;
  }, []);

  const endSendOperation = useCallback(token => {
    if (!token || sendLockRef.current !== token) return;
    if (abortRef.current === token.controller) abortRef.current = null;
    sendLockRef.current = null;
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
