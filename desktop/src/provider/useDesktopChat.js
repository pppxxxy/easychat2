// 桌面聊天编排：把共享层的 useSessionMessages / useChatSend 接起来。
//
// 与 ChatScreen 的关系：ChatScreen 是「移动端界面 + 大量特性（附件/贴纸/语音/工具/
// 群聊/多选）」的宿主；桌面首版只保留核心聊天闭环，因此这里按 ChatScreen 的口径
// 搭建**同形**的脚手架，但把桌面不支持的能力收敛成 no-op / 空集合：
// - 附件与贴纸：S4 接入（当前一律空）；
// - 语音合成/自动播报：桌面无语音（capabilities.voicePlayback=false）；
// - 工作区/工具/群聊：capabilities 关闭，listToolsForMode 自然返回空；
// - 记忆总结：S5 前保持 no-op（不影响发送/落盘语义）。
//
// 刻意保留的语义（design.md Requirement 2.5）：配置指纹校验、迟到回复丢弃、
// 串行落盘、草稿恢复——这些都在两个 hook 内部，本文件只负责把宿主状态准备好。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApp } from '../../../src/context/AppContext.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { buildAssistantReplyParts } from '../../../src/chat/assistantReply.js';
import { getInput, setInput, useInput } from '../../../src/chat/inputStore.js';
import useChatSend from '../../../src/chat/useChatSend.js';
import useSessionGuard from '../../../src/chat/useSessionGuard.js';
import useSessionMessages from '../../../src/chat/useSessionMessages.js';
import { getChatOptions } from '../../../src/storage/settings.js';

const DEFAULT_CHAT_OPTIONS = {
  streaming: true,
  fullWidth: false,
  richHtml: true,
  keepDraft: false,
  timeAware: false,
  bubbleStyle: 'rounded',
  autoCompact: true,
};

export default function useDesktopChat() {
  const { t } = useTranslation();
  const {
    character,
    characters,
    sessions,
    activeSessionId,
    loaded,
    updateCharacter,
  } = useApp();

  const characterId = character.id || '';
  const activeCharacterIdRef = useRef(characterId);
  const activeSessionIdRef = useRef(activeSessionId);
  activeCharacterIdRef.current = characterId;
  activeSessionIdRef.current = activeSessionId;
  const sessionsRef = useRef(sessions);
  const charactersRef = useRef(characters);
  sessionsRef.current = sessions;
  charactersRef.current = characters;

  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const isGroup = activeSession?.type === 'group';
  const isGroupRef = useRef(isGroup);
  isGroupRef.current = isGroup;
  const sessionOwnerMissing = !isGroup
    && !!activeSession
    && !characters.some(item => item.id === String(activeSession.characterId || ''));
  const sessionTransitionPending = !isGroup
    && !!activeSession
    && String(activeSession.characterId || '') !== String(characterId);

  // ---- 桌面不支持的特性：保持稳定引用，避免 hook 依赖抖动 ----
  const groupCharactersRef = useRef([]);
  const memberProfilesRef = useRef({ sessionId: '', profiles: {} });
  const stickersRef = useRef([]);
  const attachmentsRef = useRef([]);
  const [attachments, setAttachments] = useState([]);
  const [quoteTarget, setQuoteTarget] = useState(null);
  const pendingAttachmentUrisRef = useRef(new Set());
  const errorRawRef = useRef({});
  const atBottomRef = useRef(true);
  const userNameRef = useRef('');
  const [userAvatar, setUserAvatar] = useState('');
  const inlineImageEnabledRef = useRef(false);
  const generateInlineImageRef = useRef(null);
  const recordTurnRef = useRef(null);

  const {
    isSending,
    setIsSending,
    abortRef,
    sendLockRef,
    sourceChangedRef,
    openingRequestRef,
    openingAbortControllerRef,
    sessionVersionRef,
    captureSessionGuard,
    isSessionGuardCurrent,
    beginSendOperation,
    endSendOperation,
    syncActiveRun,
  } = useSessionGuard({ activeSessionIdRef, activeCharacterIdRef });

  // ---- 聊天选项（与 Android 同源）----
  const [chatOptions, setChatOptions] = useState(DEFAULT_CHAT_OPTIONS);
  const chatOptionsRef = useRef(chatOptions);
  chatOptionsRef.current = chatOptions;
  useEffect(() => {
    getChatOptions().then(setChatOptions).catch(() => {});
  }, []);

  // ---- 会话切换复位（桌面只有引用需要清）----
  const resetSessionUi = useCallback(() => {
    setQuoteTarget(null);
  }, []);
  const onProfileLoaded = useCallback(profile => {
    setUserAvatar((profile && profile.avatarUri) || '');
  }, []);

  // ---- 滚动 ----
  const scrollRef = useRef(null);
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, []);
  const autoScrollToBottom = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);
  const onMessagesScroll = useCallback(event => {
    const node = event.currentTarget;
    atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 32;
  }, []);

  // ---- 桌面不支持的编排：no-op（保留参数位，S4/S5 再接线）----
  const maybeAutoSummarize = useCallback(async () => {}, []);
  const autoBroadcastMessage = useCallback(() => {}, []);
  const synthesizeVoiceForReply = useCallback(() => {}, []);
  const syncProtectedAttachmentUris = useCallback(() => {}, []);
  const buildAssistantReply = useCallback((replyText) => {
    const opts = chatOptionsRef.current || {};
    const result = buildAssistantReplyParts({
      replyText,
      stickers: stickersRef.current,
      downloadEnabled: false,
      sticker: { enabled: false },
    });
    return result.parts;
  }, []);

  // ---- 会话消息编排（共享层）----
  const {
    onInputChange,
    persistDraftNow,
    draftTextRef,
    messages,
    setMessages,
    messagesRef,
    ready,
    greetingReady,
  } = useSessionMessages({
    activeSessionId,
    loaded,
    sessionOwnerMissing,
    messageRefreshTick: 0,
    characterId,
    character,
    activeSessionIdRef,
    activeCharacterIdRef,
    sessionsRef,
    isGroupRef,
    groupCharactersRef,
    userNameRef,
    attachmentsRef,
    pendingAttachmentUrisRef,
    errorRawRef,
    atBottomRef,
    sendLockRef,
    abortRef,
    sessionVersionRef,
    openingRequestRef,
    openingAbortControllerRef,
    syncActiveRun,
    chatOptions,
    chatOptionsRef,
    resetSessionUi,
    onProfileLoaded,
  });

  // ---- 发送编排（共享层）----
  const send = useChatSend({
    beginSendOperation,
    endSendOperation,
    captureSessionGuard,
    isSessionGuardCurrent,
    sendLockRef,
    abortRef,
    sourceChangedRef,
    sessionVersionRef,
    openingRequestRef,
    isSending,
    isSwitching: false,
    ready,
    greetingReady,
    messageSelectionOpen: false,
    sessionTransitionPending,
    sessionOwnerMissing,
    messages,
    attachments,
    quoteTarget,
    character,
    characters,
    charactersRef,
    chatOptions,
    activeCharacterIdRef,
    activeSessionIdRef,
    sessionsRef,
    isGroupRef,
    groupCharactersRef,
    attachmentsRef,
    errorRawRef,
    memberProfilesRef,
    activeSessionRef,
    stickersRef,
    chatOptionsRef,
    inlineImageEnabledRef,
    generateInlineImageRef,
    recordTurnRef,
    draftTextRef,
    messagesRef,
    atBottomRef,
    characterId,
    updateCharacter,
    persistDraftNow,
    syncProtectedAttachmentUris,
    scrollToBottom,
    autoScrollToBottom,
    maybeAutoSummarize,
    autoBroadcastMessage,
    synthesizeVoiceForReply,
    buildAssistantReply,
    setMessages,
    setIsSending,
    setInput,
    setAttachments,
    setQuoteTarget,
  });

  // 桌面 Composer 订阅输入 store（与 ChatComposer 同源）。
  const input = useInput();

  return {
    t,
    messages,
    messagesRef,
    ready,
    greetingReady,
    isSending,
    input,
    onInputChange,
    sendText: send.sendText,
    regenerateMessage: send.regenerateMessage,
    editUserMessage: send.editUserMessage,
    modelFallbackNotice: send.modelFallbackNotice,
    contextBreakdown: send.contextBreakdown,
    requestReply: send.requestReply,
    scrollRef,
    onMessagesScroll,
    scrollToBottom,
    autoScrollToBottom,
    userAvatar,
    quoteTarget,
    setQuoteTarget,
    errorRawRef,
    getInput,
  };
}
