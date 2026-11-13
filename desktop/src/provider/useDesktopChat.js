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
import { resolveGroupMembers } from '../group/groupModel.js';

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
    refreshSessions,
    switchSession: switchSessionFn,
    switchCharacter,
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

  // 群聊会话（供「切换角色/群聊」面板列出）。与手机 ChatScreen.groupSessions 同口径。
  const groupSessions = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).filter(item => item && item.type === 'group'),
    [sessions]
  );
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

  // ---- 群聊成员解析（与手机 ChatScreen 的 groupCharacters 同口径）----
  // 共享层 requestGroupReply 只读 groupCharactersRef.current：空数组时它会直接拒绝并
  // 提示「没有成员」。此前桌面把它恒设为 []，群聊等于不可用；这里按活动会话的
  // members 解析角色，并跳过已被删除的成员（缺失成员由界面显式提示）。
  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(item => {
      if (item && item.id) map.set(item.id, item);
    });
    return map;
  }, [characters]);
  const { members: groupCharacters, missingIds: groupMissingIds } = useMemo(
    () => resolveGroupMembers(activeSession, characterMap),
    [activeSession, characterMap]
  );
  const groupCharactersRef = useRef(groupCharacters);
  groupCharactersRef.current = groupCharacters;
  const groupMissingIdsRef = useRef(groupMissingIds);
  groupMissingIdsRef.current = groupMissingIds;

  // ---- 其余桌面不支持的特性：保持稳定引用，避免 hook 依赖抖动 ----
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

  // ---- 桌面不支持的编排：no-op（保留参数位）----
  // 记忆总结由 ChatPane 的 useDesktopMemorySummary 实现（它需要角色/向量/会话范围
  // 判定，都在共享层 memorySummary 里）。这里经 ref 转发：useChatSend 在回复落盘后
  // 调它，而 hook 无法反向依赖面板里创建的实例。
  const autoSummarizeRef = useRef(null);
  const maybeAutoSummarize = useCallback(async list => {
    if (typeof autoSummarizeRef.current === 'function') {
      await autoSummarizeRef.current(list);
    }
  }, []);
  const autoBroadcastMessage = useCallback(() => {}, []);
  const synthesizeVoiceForReply = useCallback(() => {}, []);
  const syncProtectedAttachmentUris = useCallback(() => {}, []);
  const buildAssistantReply = useCallback((replyText) => {
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
    setGreetingReady,
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

  // 停止生成：手机版聊天输入区把「发送」换成「停止」，桌面此前只有发送按钮，
  // 长回复只能等它跑完。abort 走的是共享层同一个 abortRef（useSessionGuard），
  // 与手机上点停止是同一条路径（endSendOperation 收尾、已生成的部分照常落盘）。
  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, [abortRef]);

  return {
    t,
    stop,
    setGreetingReady,
    updateCharacter,
    refreshSessions,
    character,
    charactersRef,
    sessionsRef,
    switchSession: switchSessionFn,
    switchCharacter,
    characters,
    groupSessions,
    sendLockRef,
    userNameRef,
    autoSummarizeRef,
    messages,
    messagesRef,
    setMessages,
    ready,
    greetingReady,
    isSending,
    characterId,
    activeSessionId,
    activeSession,
    isGroup,
    refreshSessions,
    groupCharacters,
    groupMissingIds,
    chatOptions,
    characterName: String((character && character.name) || ''),
    input,
    onInputChange,
    sendText: send.sendText,
    sendMessage: send.sendMessage,
    regenerateMessage: send.regenerateMessage,
    editUserMessage: send.editUserMessage,
    modelFallbackNotice: send.modelFallbackNotice,
    // I1：运行中补充指令（本轮工具循环还在跑时，把新输入注入下一轮而不是排队等）。
    steeringAvailable: send.steeringAvailable,
    pushSteering: send.pushSteering,
    steeringNote: send.steeringNote,
    setSteeringNote: send.setSteeringNote,
    // 补充指令入队后要清掉草稿（否则重启会把已注入的那句当成未发草稿恢复）。
    persistDraftNow,
    contextBreakdown: send.contextBreakdown,
    branchesRefreshToken: send.branchesRefreshToken,
    requestReply: send.requestReply,
    attachments,
    attachmentsRef,
    setAttachments,
    captureSessionGuard,
    isSessionGuardCurrent,
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
