import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Sharing from 'expo-sharing';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isConfigChangedError, sendChatMessage } from './api.js';
import {
   deleteLocalImage,
   deleteTemporaryImage,
    isImage,
    isTextLike,
    isVisionImage,
  persistImageAttachment,
  pickAttachment,
  pickStickerImage,
  readTextAttachment,
   getImageDimensions,
   getImageFileInfo,
   getImageMime,
   getPendingStickerImage,
   MAX_IMAGE_ATTACHMENTS,
   takePhoto,
   validateImageSize,
} from './attachments.js';
import { createMediaMessage, STICKER_MESSAGE_KIND } from './chatMedia.js';
import { extractStickerDirectives, resolveStickerNames } from './stickerDirectives.js';
import { createStickerImage, deleteStickerImage } from './stickerImages.js';
import { getCachedDisplayText } from './displayTextCache.js';
import { isGreetingMessage, listGreetingCandidates } from './cardGreetings.js';
import {
  removeMessagesByIds,
  selectableMessageIds,
  toggleMessageSelection,
} from './messageSelection.js';
import {
  applySummary,
  invalidateHistorySummaries,
  isSessionScopedMemory,
  selectManualSummarizable,
  selectSummarizable,
  shouldSummarize,
} from './memorySummary.js';
import {
} from './chat/replyFlow.js';
import { useApp } from './context/AppContext.js';
import CharacterEditForm from './CharacterEditForm.js';
import GreetingPickerModal from './GreetingPickerModal.js';
import GroupEditForm from './GroupEditForm.js';
import DisclaimerModal from './disclaimer.js';
import {
  MENTION_PREFIX,
} from './groupChat.js';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine.js';
import ScrollScrubber from './ScrollScrubber.js';
import { maskSecrets } from './secrets.js';
import { hideVariantStatusBar } from './speechText.js';
import { recordDiagnostic } from './diagnostics.js';
import {
  getApiConfigs,
  getActiveLocalModel,
  getChatOptions,
  getImageGenSettings,
  getLocalModelSettings,
  getInlineImageSettings,
  getMemorySummarySettings,
  getStickers,
  getThinkingSettings,
  getTranscriptionSettings,
  getUserProfile,
  setProtectedChatImageUris,
  getTtsSettings,
  getMomentsSettings,
  getAffinityStatus,
  saveAffinity,
  updateMoments,
  saveSticker,
  deleteStickers,
  reorderStickers,
  setSessionGreetingSelected,
  getVectorMemoryConfig,
  removeVectorIndexForMessage,
  removeVectorIndexForMessages,
  removeVectorIndexForSession,
} from './storage.js';

import {
} from './vectorMemory/index.js';
import { getVectorOwnerId } from './vectorMemory/scope.js';
import { useTheme } from './theme/ThemeContext.js';
import { generateImage } from './imageGen/index.js';
import ModelLogsModal from './localModel/ModelLogsModal.js';
import { getLocalModelMediaCapabilities } from './localModel/modelState.js';
import { getImageProvider } from './imageGen/providers.js';
import useChatTts from './chat/useChatTts.js';
import useSessionGuard from './chat/useSessionGuard.js';
import useSessionMessages from './chat/useSessionMessages.js';
import useSessionSwitch from './chat/useSessionSwitch.js';
import useChatSend from './chat/useChatSend.js';
import MessageList from './chat/MessageList.js';
import useChatModelThinking from './chat/useChatModelThinking.js';
import { evaluateTurn, clampAffinity } from './moments/affinity.js';
import { shouldTrigger, buildMomentText, appendMoment } from './moments/moments.js';
import { runHousemateReactions } from './moments/runHousemateReactions.js';
import {
  buildScenePrompt,
  normalizeScenePrompt,
  selectReplySegment,
} from './inlineImagePrompt.js';

import {
  AI_DISCLAIMER_TEXT,
  ASSISTANT_ID,
  NEAR_BOTTOM_THRESHOLD,
  USER_ID,
  MESSAGE_WINDOW_INITIAL,
  MESSAGE_WINDOW_STEP,
  MESSAGE_WINDOW_STEP_SCROLL,
} from './chat/chatConstants.js';
import {
  buildInlineImagePrompt,
  buildQuotePayload,
} from './chat/chatHelpers.js';
import { createChatStyles } from './chat/chatStyles.js';
import useScrollScrubber from './chat/useScrollScrubber.js';
import useChatSearch from './chat/useChatSearch.js';
import SelectionTextModal from './chat/SelectionTextModal.js';
import SwitcherModal from './chat/SwitcherModal.js';
import MentionPickerModal from './chat/MentionPickerModal.js';
import ModelPanelModal from './chat/ModelPanelModal.js';
import ThinkingPanelModal from './chat/ThinkingPanelModal.js';
import StickerPanelModal from './chat/StickerPanelModal.js';
import StickerNamePromptModal from './chat/StickerNamePromptModal.js';
import MoreMenuModal from './chat/MoreMenuModal.js';
import ChatSettingsModal from './chat/ChatSettingsModal.js';
import VoiceSettingsModal from './chat/VoiceSettingsModal.js';
import TranscriptionPanel from './TranscriptionPanel.js';
import FullScreenInputModal from './chat/FullScreenInputModal.js';
import ChatSearchBar from './chat/ChatSearchBar.js';
import ChatTopBar from './chat/ChatTopBar.js';
import ChatComposer from './chat/ChatComposer.js';
import useChatRecorder from './chat/useChatRecorder.js';
import AttachmentMenuModal from './chat/AttachmentMenuModal.js';
import {
  isUnsupportedTranscriptionError,
  resolveTranscription,
  transcribeAudio,
} from './transcription.js';
export default function ChatScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const scrollRef = useRef(null);
  const errorRawRef = useRef({});
  const {
    character,
    characters,
    activeId,
    loaded,
    switchCharacter,
    activeSessionId,
    sessions,
    ensureCharacterSession,
    updateCharacter,
    refreshSessions,
    switchSession,
    messageRefreshTick,
    pendingTarget,
    consumePendingTarget,
  } = useApp();
  const characterId = character.id || 'default';
  const activeCharacterIdRef = useRef(characterId);
  const activeSessionIdRef = useRef(activeSessionId);
  activeCharacterIdRef.current = characterId;
  activeSessionIdRef.current = activeSessionId;
  const sessionsRef = useRef(sessions);
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  sessionsRef.current = sessions;
  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const memberProfilesRef = useRef({ sessionId: '', profiles: {} });
  const isGroup = activeSession?.type === 'group';
   const sessionOwnerMissing = !isGroup
     && !!activeSession
     && !characters.some(item => item.id === String(activeSession.characterId || ''));
   const sessionTransitionPending = !isGroup
     && !!activeSession
     && String(activeSession.characterId || '') !== String(characterId);
  const greetingCandidates = useMemo(
    () => listGreetingCandidates(character),
    [character.firstMes, character.alternateGreetings]
  );
  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(item => {
      map.set(item.id, item);
    });
    return map;
  }, [characters]);
  const groupCharacters = useMemo(() => {
    if (!activeSession || activeSession.type !== 'group') return [];
    return (activeSession.members || [])
      .map(id => characterMap.get(id))
      .filter(Boolean);
  }, [activeSession, characterMap]);
  const groupCharactersRef = useRef(groupCharacters);
  groupCharactersRef.current = groupCharacters;
  const groupSessions = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).filter(item => item && item.type === 'group'),
    [sessions]
  );
  const groupSessionName = useCallback(session => {
    const map = characterMap;
    const memberNames = (session.members || [])
      .map(id => (map.get(id) || {}).name)
      .filter(Boolean);
    return String(session.name || '').trim() || memberNames.join('、') || '群聊';
  }, [characterMap]);
  const isGroupRef = useRef(isGroup);
  isGroupRef.current = isGroup;
  const summarizingRef = useRef(false);
  const autoSummaryAttemptRef = useRef({ sessionId: '', signature: '' });
  const messageOffsetsRef = useRef({});
  const atBottomRef = useRef(true);
  const {
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
  } = useSessionGuard({ activeSessionIdRef, activeCharacterIdRef });
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const inputSelectionRef = useRef({ start: 0, end: 0 });
  const [inputFocused, setInputFocused] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const selectedMessageIdSet = useMemo(
    () => new Set(selectedMessageIds),
    [selectedMessageIds]
  );
  const messageSelectionOpen = selectedMessageIds.length > 0;
   const [isSwitching, setIsSwitching] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const [transcriptionPanelOpen, setTranscriptionPanelOpen] = useState(false);
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [characterEditOpen, setCharacterEditOpen] = useState(false);
  const [groupEditOpen, setGroupEditOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [userAvatar, setUserAvatar] = useState('');
  const userNameRef = useRef('');
  const [selectionText, setSelectionText] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const {
    modelPanelOpen,
    setModelPanelOpen,
    apiConfigs,
    modelSourceId,
    setModelSourceId,
    openModelPanel,
    applyModelSelection,
    thinkingOpen,
    setThinkingOpen,
    thinkingEnabled,
    thinkingLevel,
    thinkingSupported,
    thinkingDisplay,
    setThinkingDisplay,
    openThinkingPanel,
    applyThinking,
    localModels,
    activeLocalModelId,
    loadingLocalModelId,
    activateLocalModel,
    deactivateLocalModel,
    localLogsOpen,
    setLocalLogsOpen,
  } = useChatModelThinking({ isSending, sendLockRef });
   const [attachments, setAttachments] = useState([]);
   const attachmentsRef = useRef([]);
   attachmentsRef.current = attachments;
   const attachmentPickerLockRef = useRef(false);
   const [attachmentLoading, setAttachmentLoading] = useState(false);
   const pendingAttachmentUrisRef = useRef(new Set());
   const syncProtectedAttachmentUris = useCallback(() => {
     setProtectedChatImageUris([
       ...attachmentsRef.current
         .filter(item => item && item.kind === 'image')
         .map(item => item.uri),
       ...pendingAttachmentUrisRef.current,
     ]);
   }, []);
   useEffect(() => {
     syncProtectedAttachmentUris();
   }, [attachments, syncProtectedAttachmentUris]);
   useEffect(() => () => {
     setProtectedChatImageUris([]);
   }, []);
   const [stickerPanelOpen, setStickerPanelOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  // 拍照/图片附件要求当前来源支持识图；进入附件菜单前刷新一次，用于禁用不可用项。
  const [attachmentVisionEnabled, setAttachmentVisionEnabled] = useState(false);
  const [stickers, setStickers] = useState([]);
  const stickersRef = useRef([]);
  stickersRef.current = stickers;
  const stickerLoadRef = useRef(0);
   const [stickerNamePrompt, setStickerNamePrompt] = useState(null);
   const [stickerNameDraft, setStickerNameDraft] = useState('');
   const [stickerSaving, setStickerSaving] = useState(false);
   const stickerSaveLockRef = useRef(false);
   const stickerPickerLockRef = useRef(false);
   const pendingStickerResultRef = useRef(null);
  const [chatOptions, setChatOptions] = useState({ streaming: true, fullWidth: false, richHtml: true, keepDraft: false, timeAware: false });
  const chatOptionsRef = useRef(chatOptions);
  chatOptionsRef.current = chatOptions;

  // 会话切换时的 UI 复位（附件清理、引用/表情面板/多选等），由 useSessionMessages
  // 在加载 effect 的原时序位置调用；输入框清空由 hook 自己完成。
  const resetSessionUi = useCallback(() => {
    const draftAttachments = attachmentsRef.current;
    draftAttachments.forEach(item => {
      if (item.kind === 'image') deleteLocalImage(item.uri);
    });
    attachmentsRef.current = [];
    setProtectedChatImageUris([]);
    setFullScreenText('');
    setQuoteTarget(null);
    setAttachments([]);
    setStickerPanelOpen(false);
    setStickerNamePrompt(current => {
      if (current && current.uri) deleteTemporaryImage(current.uri);
      return null;
    });
    setStickerNameDraft('');
    setIsSwitching(false);
    setSelectedMessageIds([]);
  }, []);

  // 用户资料（头像）读回后由 hook 通知，状态仍归 ChatScreen。
  const onProfileLoaded = useCallback(profile => {
    setUserAvatar((profile && profile.avatarUri) || '');
  }, []);

  // 打开附件菜单时刷新识图能力：在线来源的 supportsVision 与本地模型的多模态，
  // 任一可用即视为支持。读盘失败按「不支持」处理（菜单里会给出原因提示）。
  useEffect(() => {
    if (!attachmentMenuOpen) return;
    let cancelled = false;
    (async () => {
      let vision = false;
      try {
        const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
          getApiConfigs(),
          getLocalModelSettings().catch(() => null),
          getActiveLocalModel().catch(() => null),
        ]);
        const current = configs.find(item => item.id === activeId) || configs[0];
        vision = !!(current && current.supportsVision === true)
          || !!getLocalModelMediaCapabilities(localSettings, localItem).vision;
      } catch (error) {}
      if (!cancelled) setAttachmentVisionEnabled(vision);
    })();
    return () => {
      cancelled = true;
    };
  }, [attachmentMenuOpen]);

  const {
    input,
    setInput,
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
    messageRefreshTick,
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
    setIsSending,
    chatOptions,
    chatOptionsRef,
    resetSessionUi,
    onProfileLoaded,
  });
  const [greetingPicker, setGreetingPicker] = useState(null);
  const [inlineImageSettings, setInlineImageSettings] = useState({
    enabled: false,
    providerId: '',
    stylePrefix: '',
    size: '832*1216',
    maxPromptChars: 400,
    imagePosition: 'end',
  });
   const inlineImageBusyRef = useRef(false);

  const {
    ttsSettings,
    setTtsSettings,
    toggleBroadcast,
    broadcastMessage,
    autoBroadcastMessage,
    synthesizeVoice,
  } = useChatTts();
  // 语音录制：仅在单聊且非群聊时提供入口。转录判定按会话缓存（见 transcriptionSupportedRef）。
  const recorder = useChatRecorder();
  const transcriptionSupportedRef = useRef({}); // sessionId -> false 表示该来源已确认不支持转写
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [fullScreenOpen, setFullScreenOpen] = useState(false);
  const [fullScreenText, setFullScreenText] = useState('');
  const [focusedMessageId, setFocusedMessageId] = useState('');
   const [quoteTarget, setQuoteTarget] = useState(null);
   const navigation = useNavigation();

   const closeStickerNamePrompt = useCallback(() => {
     const source = stickerNamePrompt;
     setStickerNamePrompt(null);
     setStickerNameDraft('');
     if (source && source.uri) deleteTemporaryImage(source.uri);
   }, [stickerNamePrompt]);


  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd?.({ animated: true });
    });
  }, []);

  const autoScrollToBottom = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  const onMessagesScroll = useCallback(({ nativeEvent }) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    atBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
  }, []);

  const rawTextById = useMemo(() => {
    const map = new Map();
    (Array.isArray(messages) ? messages : []).forEach(message => {
      if (message && message.id) map.set(message.id, String(message.text ?? ''));
    });
    return map;
  }, [messages]);
  const renderedMessages = useMemo(
    () => messages.map((message, index) => {
      if (!message) return message;
      if (message.pending) {
        if (message.role !== ASSISTANT_ID) return message;
        const text = hideVariantStatusBar(message.text);
        return text === message.text ? message : { ...message, text };
      }
      const depth = messages.length - 1 - index;
      if (message.role === ASSISTANT_ID) {
        const speaker = message.speakerId ? characterMap.get(message.speakerId) : null;
        const scripts = sessionOwnerMissing
          ? []
          : speaker?.regexScripts || character.regexScripts;
        const text = getCachedDisplayText(
          message,
          scripts,
          REGEX_PLACEMENT.AI_OUTPUT,
          depth,
          () => applyRegexScripts(
            hideVariantStatusBar(message.text),
            scripts,
            REGEX_PLACEMENT.AI_OUTPUT,
            { mode: 'display', depth }
          )
        );
        return text === message.text ? message : { ...message, text };
      }
      if (message.role === USER_ID) {
        const scripts = sessionOwnerMissing ? [] : character.regexScripts;
        const text = getCachedDisplayText(
          message,
          scripts,
          REGEX_PLACEMENT.USER_INPUT,
          depth,
          () => applyRegexScripts(
            message.text,
            scripts,
            REGEX_PLACEMENT.USER_INPUT,
            { mode: 'display', depth }
          )
        );
        return text === message.text ? message : { ...message, text };
      }
      return message;
    }),
    [messages, character.regexScripts, characterMap, sessionOwnerMissing]
  );
  const renderedMessagesRef = useRef([]);
  renderedMessagesRef.current = renderedMessages;
  // 列表窗口化：默认只挂载尾部消息，向上翻历史时手动/自动扩窗（见 MessageList 与
  // scrollToMessage）。切会话时重置回默认窗口。
  const [messageWindowSize, setMessageWindowSize] = useState(MESSAGE_WINDOW_INITIAL);
  const expandMessageWindow = useCallback((step = MESSAGE_WINDOW_STEP) => {
    setMessageWindowSize(current => {
      const total = renderedMessagesRef.current.length;
      if (total <= 0) return current;
      return Math.min(total, current + step);
    });
  }, []);

  const regenerableIds = useMemo(() => {
    const ids = new Set();
    let hasUser = false;
    for (const item of messages) {
      if (!item) continue;
      if (item.role === USER_ID) {
        hasUser = true;
      } else if (item.role === ASSISTANT_ID && hasUser) {
        ids.add(item.id);
      }
    }
    return ids;
  }, [messages]);

  // 当前角色 id 变化时必须同步 ref。加载 effect 只依赖 [activeSessionId, loaded]，
  // 当角色变了而会话尚未切过去（例如 activeId 失效被解析回初始卡）时它不会触发，
  // ref 就会停留在旧角色，导致动态归属、迟到回复判定与实际界面角色不一致。
  useEffect(() => {
    activeCharacterIdRef.current = characterId;
  }, [characterId]);

  useEffect(() => {
    autoSummaryAttemptRef.current = { sessionId: '', signature: '' };
    setMessageWindowSize(MESSAGE_WINDOW_INITIAL);
  }, [activeSessionId]);

  useEffect(() => {
    const available = new Set(
      (Array.isArray(messages) ? messages : [])
        .map(message => String(message && message.id || ''))
        .filter(Boolean)
    );
    setSelectedMessageIds(current => {
      const next = current.filter(id => available.has(id));
      return next.length === current.length ? current : next;
    });
  }, [messages]);


  // 角色与会话必须成对：导入/新建角色、或历史遗留的错配状态下，只要当前会话不属于当前角色，
  // 就切到该角色自己的会话。否则界面会继续显示上一个角色的对话，新消息还会写进那段会话。
  useEffect(() => {
    if (!loaded) return;
    if (isGroup) return;
    if (!activeSessionId || !activeSession) return;
    const sessionOwnerId = String(activeSession.characterId || '');
    if (!characters.some(item => item.id === sessionOwnerId)) return;
    if (sessionOwnerId === characterId) return;
    if (!characters.some(item => item.id === characterId)) return;
    ensureCharacterSession(characterId).catch(() => {});
  }, [activeSession, activeSessionId, characterId, characters, ensureCharacterSession, isGroup, loaded]);

  // 卸载时中断进行中的发送（保存重试计时器的清理已随 useSessionMessages 外提）。
  useEffect(() => () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const onStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const openGreetingPicker = useCallback((purpose = 'new') => {
    // 用 messagesRef 读取当前消息：回调不该因为流式回复更新 messages 而换引用，
    // 否则会给每个 MessageBubble 传新的 onReselectGreeting，击穿 React.memo。
    const current = messagesRef.current.find(item => isGreetingMessage(item, activeSessionIdRef.current));
    const template = String((current && (current.greetingTemplate || current.text)) || '');
    const foundIndex = greetingCandidates.findIndex(item => item.text === template);
    const initialSelectedIndex = current
      ? (foundIndex >= 0 ? foundIndex : (greetingCandidates.length > 0 ? 0 : -1))
      : (greetingCandidates.length > 0 ? 0 : -1);
    setGreetingPicker({
      purpose,
      candidates: greetingCandidates,
      initialSelectedIndex,
    });
  }, [greetingCandidates]);


  const scrollToMessage = useCallback(id => {
    const attempt = tries => {
      const offset = messageOffsetsRef.current[id];
      if (typeof offset === 'number') {
        scrollRef.current?.scrollTo?.({ y: Math.max(0, offset - 80), animated: true });
      } else if (tries > 0) {
        // 目标可能在窗口外：扩窗后等布局回填 offsets 再重试
        expandMessageWindow(MESSAGE_WINDOW_STEP_SCROLL);
        setTimeout(() => attempt(tries - 1), 120);
      }
    };
    setTimeout(() => attempt(6), 60);
  }, [expandMessageWindow]);

  const onMessageLayout = useCallback((id, event) => {
    messageOffsetsRef.current[id] = event.nativeEvent.layout.y;
  }, []);

  const {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    activeMatchIndex,
    setActiveMatchIndex,
    searchMatches,
    goToMatch,
    closeSearch,
  } = useChatSearch({ messages, scrollToMessage, setFocusedMessageId });

  const {
    switcherOpen,
    setSwitcherOpen,
    onSwitch,
    onSwitchGroup,
    confirmGreeting,
    onNewChat,
  } = useSessionSwitch({
    input,
    fullScreenText,
    attachments,
    quoteTarget,
    stickerPanelOpen,
    stickerNamePrompt,
    stickerNameDraft,
    isSwitching,
    isSending,
    ready,
    sessionOwnerMissing,
    sessionTransitionPending,
    greetingPicker,
    setGreetingPicker,
    messages,
    setIsSending,
    setInput,
    setFullScreenText,
    setAttachments,
    setQuoteTarget,
    setStickerPanelOpen,
    setStickerNamePrompt,
    setStickerNameDraft,
    setIsSwitching,
    setSearchOpen,
    setSearchQuery,
    setActiveMatchIndex,
    setFocusedMessageId,
    setSelectionText,
    setGreetingReady,
    setMessages,
    attachmentsRef,
    activeCharacterIdRef,
    activeSessionIdRef,
    switchOperationRef,
    sessionVersionRef,
    abortRef,
    errorRawRef,
    sessionsRef,
    isGroupRef,
    groupCharactersRef,
    userNameRef,
    invalidateSessionOperations,
    closeStickerNamePrompt,
    openGreetingPicker,
    switchCharacter,
    switchSession,
    ensureCharacterSession,
    refreshSessions,
    updateCharacter,
  });

  useEffect(() => {
    if (!ready || !pendingTarget) return;
    if (pendingTarget.sessionId !== activeSessionId) return;
    const exists = messages.some(message => message.id === pendingTarget.messageId);
    consumePendingTarget();
    if (!exists) return;
    setFocusedMessageId(pendingTarget.messageId);
    scrollToMessage(pendingTarget.messageId);
  }, [ready, pendingTarget, activeSessionId, messages, consumePendingTarget, scrollToMessage]);

  useEffect(() => {
    if (!navigation) return undefined;
    const load = () => {
      getChatOptions()
        .then(options => setChatOptions(options))
        .catch(() => {});
      getThinkingSettings()
        .then(settings => setThinkingDisplay(settings.display))
        .catch(() => {});
      getInlineImageSettings()
        .then(settings => setInlineImageSettings(settings))
        .catch(() => {});
      getTtsSettings()
        .then(settings => setTtsSettings(settings))
        .catch(() => {});
      const stickerRequest = ++stickerLoadRef.current;
      getStickers()
        .then(list => {
          if (stickerRequest === stickerLoadRef.current) setStickers(list);
        })
        .catch(() => {});
    };
    load();
    const unsubscribe = navigation.addListener('focus', load);
    return unsubscribe;
  }, [navigation]);

  const {
    scrubberOpen,
    setScrubberOpen,
    scrubberMessages,
    scrubberPreviews,
    onScrubberSeek,
    onScrubberToStart,
    onScrubberToEnd,
  } = useScrollScrubber({
    messages,
    characterName: character.name,
    scrollRef,
    messageOffsetsRef,
    scrollToMessage,
  });

  const runSummarize = useCallback(async (session, list, manual) => {
    if (summarizingRef.current) return;
    const picked = manual
      ? selectManualSummarizable(list, session.summarizedUpTo)
      : selectSummarizable(list, session.summarizedUpTo);
    if (picked.length === 0) {
      if (manual) Alert.alert('无法总结', '当前没有新的可总结消息。');
      return;
    }
    summarizingRef.current = true;
    setSummarizing(true);
    try {
      const userProfile = await getUserProfile();
      const sessionCharacterId = String(session.characterId || character.id || '');
      const sessionCharacter = (Array.isArray(characters) ? characters : [])
        .find(item => item.id === sessionCharacterId) || character;
       const characterExists = (Array.isArray(characters) ? characters : [])
         .some(item => item.id === sessionCharacterId);
       // 自动总结在启用向量记忆后降级为会话级（跨会话召回交给向量）；
       // 手动总结是用户显式操作，仍按原有作用域判定，允许写入世界书。
       let vectorEnabled = false;
       try {
         const vectorConfig = await getVectorMemoryConfig();
         vectorEnabled = vectorConfig.enabled === true;
       } catch (error) {}
       const scopeOverride = !manual && vectorEnabled;
       const scoped = !characterExists
         || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, session, list, scopeOverride);
       let expectedConfigId = '';
       let expectedConfigFingerprint = '';
       try {
         const { configs, activeId } = await getApiConfigs();
         const current = configs.find(item => item.id === activeId) || configs[0];
         expectedConfigId = String(current?.id || '');
         expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
       } catch (error) {}
       const result = await applySummary({
        session,
        character: sessionCharacter,
        messages: picked,
        updateCharacter,
         userName: userProfile.userName,
         scoped,
         expectedConfigId,
          expectedConfigFingerprint,
          getCurrentCharacter: () => charactersRef.current.find(
            item => item.id === sessionCharacterId
          ) || sessionCharacter,
          getCurrentScope: () => {
            const latestCharacterExists = (Array.isArray(charactersRef.current) ? charactersRef.current : [])
              .some(item => item.id === sessionCharacterId);
             return !latestCharacterExists
               || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, session, list, scopeOverride);
          },
        });
      await refreshSessions().catch(() => {});
      if (result.skipped) {
        if (manual) Alert.alert('总结完成', '本轮没有提取出可保存的新记忆。');
        return;
      }
      if (manual) {
        Alert.alert(
          '已完成',
          result.scoped
            ? '记忆已压缩为本会话上下文，不再写入世界书。'
            : '记忆总结已写入角色世界书。'
        );
      }
    } catch (error) {
      if (manual) {
        Alert.alert('记忆总结失败', '请稍后重试。');
      } else if (__DEV__) {
        console.warn('[memorySummary] automatic summary failed', error);
      }
    } finally {
      summarizingRef.current = false;
      setSummarizing(false);
    }
  }, [character, characters, updateCharacter, refreshSessions]);

  const maybeAutoSummarize = useCallback(async list => {
    if (summarizingRef.current) return;
    const session = sessionsRef.current.find(
      item => item.id === activeSessionIdRef.current
    );
    if (!session) return;
    let settings = null;
    try {
      settings = await getMemorySummarySettings();
    } catch (error) {
      return;
    }
    if (!shouldSummarize({ session, messages: list, settings })) return;
    const candidates = selectSummarizable(list, session.summarizedUpTo);
    const signature = `${session.id}:${settings.enabled}:${settings.threshold}:${candidates.map(item => item.id).join('|')}`;
    if (
      autoSummaryAttemptRef.current.sessionId === session.id
      && autoSummaryAttemptRef.current.signature === signature
    ) return;
    autoSummaryAttemptRef.current = { sessionId: session.id, signature };
    await runSummarize(session, list, false);
  }, [runSummarize]);

  const onSummarize = useCallback(() => {
    if (summarizingRef.current || isSending || !ready) return;
    if (isGroupRef.current) {
      Alert.alert('群聊暂不支持', '记忆总结仅适用于单聊会话。');
      return;
    }
    const session = sessionsRef.current.find(
      item => item.id === activeSessionIdRef.current
    );
    if (!session) {
      Alert.alert('无法总结', '当前没有可总结的会话。');
      return;
    }
    const picked = selectManualSummarizable(messages, session.summarizedUpTo);
    if (picked.length === 0) {
      Alert.alert('无法总结', '当前没有新的可总结消息。');
      return;
    }
    Alert.alert(
      '开始记忆总结？',
      `将总结当前会话的 ${picked.length} 条消息，本次操作不受自动开关和阈值限制。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始总结',
          onPress: () => runSummarize(session, messages, true),
        },
      ]
    );
  }, [isSending, ready, messages, runSummarize]);

  const buildAssistantReply = useCallback(replyText => {
    const list = Array.isArray(stickersRef.current) ? stickersRef.current : [];
    const names = resolveStickerNames(list);
    const { text, stickers: hitNames } = extractStickerDirectives(replyText || '', names);
    const byName = new Map(list.map(item => [item.name, item]));
    const now = Date.now();
    const items = [];
    const body = String(text || '').trim();
    if (body) {
      items.push({ id: `${now}-assistant`, role: ASSISTANT_ID, text: body, timestamp: now });
    }
    hitNames.forEach((name, index) => {
      const sticker = byName.get(name);
      if (!sticker) return;
      items.push(createMediaMessage({
        id: `${now}-assistant-sticker-${index}`,
        kind: STICKER_MESSAGE_KIND,
        role: ASSISTANT_ID,
        uri: sticker.uri,
        mime: sticker.mime,
        name,
        stickerName: name,
        stickerId: sticker.id,
        width: sticker.width,
        height: sticker.height,
        timestamp: now + index + 1,
      }));
    });
    // createMediaMessage 固定 role:'user'（用户发表情包用），助手表情包需覆盖为 assistant。
    return items.map(item => (item.kind === STICKER_MESSAGE_KIND ? { ...item, role: ASSISTANT_ID } : item));
  }, []);

  const synthesizeVoiceForReply = useCallback((replyParts, replyText) => {
    const displayMode = character.voiceDisplay;
    if (displayMode !== 'voice-text' && displayMode !== 'voice') return;
    if (isGroupRef.current) return;
    const target = (replyParts || []).find(item => item.role === ASSISTANT_ID && !item.kind);
    if (!target || !target.id) return;
    synthesizeVoice(target.id, replyText).then(audio => {
      if (!audio) return;
      setMessages(current => current.map(item => (
        item.id === target.id && !item.audio
          ? { ...item, audio, voiceMode: displayMode }
          : item
      )));
    });
  }, [character.voiceDisplay, synthesizeVoice]);

  const generateInlineImageRef = useRef(null);
  const inlineImageEnabledRef = useRef(false);
  const recordTurnRef = useRef(null);

  const {
    sendMessage,
    sendText,
    onRegenerateMessage,
    onEditUserMessage,
  } = useChatSend({
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
    isSwitching,
    ready,
    greetingReady,
    messageSelectionOpen,
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

  const onSelectText = useCallback(text => {
    setSelectionText(String(text || ''));
  }, []);

  const onQuoteMessage = useCallback(message => {
    if (!message || !message.id) return;
    const isUserMessage = message.role === USER_ID;
    const speakerName = String(message.speakerName || '').trim();
    const name = isUserMessage
      ? (userNameRef.current || '我')
      : (speakerName || String(character?.name || '').trim());
    const payload = buildQuotePayload(message, name);
    if (!payload) return;
    setQuoteTarget(payload);
  }, [character]);

  const onPressQuoteBlock = useCallback(quote => {
    if (!quote || !quote.id) return;
    // 用 messagesRef 查询存在性：若依赖 messages，流式回复期间每个 token 都会让
    // 这个回调换引用，进而击穿 MessageBubble 的 React.memo，导致全体历史气泡
    // 每 token 全量重渲染并重跑 Markdown 解析。
    const exists = messagesRef.current.some(item => item.id === quote.id);
    if (!exists) {
      Alert.alert('原消息已删除', '无法定位到被引用的消息。');
      return;
    }
    setFocusedMessageId(quote.id);
    scrollToMessage(quote.id);
  }, [scrollToMessage]);

  const startMessageSelection = useCallback(messageId => {
    if (!messageId || !ready || isSending) return;
    setSelectedMessageIds(current => {
      const id = String(messageId);
      if (current.includes(id)) return current;
      return current.length > 0 ? [...current, id] : [id];
    });
    setSearchOpen(false);
    setMoreOpen(false);
  }, [isSending, ready]);

  // 传给 MessageBubble 的稳定引用：把「按消息 id 分派」的包装放在这里，渲染处
  // 不再内联箭头函数（内联箭头每次渲染都是新引用，会击穿 React.memo）。
  const onReselectGreeting = useCallback(() => {
    openGreetingPicker('reselect');
  }, [openGreetingPicker]);

  const toggleSelectedMessage = useCallback(messageId => {
    if (!messageId || !ready || isSending) return;
    setSelectedMessageIds(current => toggleMessageSelection(current, messageId));
  }, [isSending, ready]);

  const cancelMessageSelection = useCallback(() => {
    setSelectedMessageIds([]);
  }, []);

  // 全选 / 取消全选：把可进入多选的消息整体选中或清空。生成中的占位消息不可选，
  // 与消息 Pressable 的 disabled 判定一致（见 selectableMessageIds）。
  const selectableIds = useMemo(
    () => selectableMessageIds(messages),
    [messages]
  );
  const allMessagesSelected = selectableIds.length > 0
    && selectedMessageIds.length === selectableIds.length;
  const toggleSelectAllMessages = useCallback(() => {
    if (!ready || isSending) return;
    setSelectedMessageIds(current => {
      const next = selectableMessageIds(messagesRef.current);
      return current.length === next.length ? [] : next;
    });
  }, [isSending, ready]);

  const confirmDeleteSelectedMessages = useCallback(() => {
    const ids = selectedMessageIds.slice();
    if (ids.length === 0 || !ready || isSending) return;
    const sessionId = activeSessionIdRef.current;
    const sessionVersion = sessionVersionRef.current;
    const session = sessionsRef.current.find(item => item.id === sessionId);
    const messagesAfter = removeMessagesByIds(messagesRef.current, ids);
    // 删光当前会话的全部消息时，语义等同旧「清空」：额外重置开场白选择并清理整段
    // 向量索引（而非逐条删除）。这样移除输入区的「清空」按钮后，用户用「全选 + 删除」
    // 仍能得到与清空一致的收尾。
    const clearsAll = messagesRef.current.length > 0 && messagesAfter.length === 0;
    Alert.alert(
      '删除消息',
      clearsAll
        ? `确定删除全部 ${ids.length} 条消息吗？这会同时重置本会话的开场白与记忆摘要。`
        : `确定删除选中的 ${ids.length} 条消息吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            if (
              sessionVersionRef.current !== sessionVersion
              || activeSessionIdRef.current !== sessionId
            ) return;
            try {
              if (session) {
                const sessionCharacterId = String(session.characterId || '');
                const latestCharacters = Array.isArray(charactersRef.current) ? charactersRef.current : [];
                const characterExists = latestCharacters.some(item => item.id === sessionCharacterId);
                const scoped = !characterExists
                  || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, session, messagesRef.current);
                const latestCharacter = latestCharacters.find(item => item.id === sessionCharacterId)
                  || character;
                await invalidateHistorySummaries({
                  session,
                  messages: messagesAfter,
                  removedIds: ids,
                  scoped,
                  character: latestCharacter,
                  updateCharacter,
                });
              }
            } catch (error) {
              Alert.alert('删除失败', '总结数据未能同步，请稍后重试。');
              return;
            }
            if (
              sessionVersionRef.current !== sessionVersion
              || activeSessionIdRef.current !== sessionId
            ) return;
            sessionVersionRef.current += 1;
            if (clearsAll && !isGroupRef.current) {
              setGreetingReady(false);
              setSessionGreetingSelected(sessionId, false)
                .then(() => refreshSessions())
                .catch(() => {});
            }
            const vectorOwnerId = getVectorOwnerId(session, characterId);
            if (vectorOwnerId) {
              if (clearsAll) {
                removeVectorIndexForSession(vectorOwnerId, sessionId).catch(error => {
                  if (__DEV__) console.warn('[vector] clear cleanup failed', error);
                });
              } else {
                removeVectorIndexForMessages(vectorOwnerId, sessionId, ids).catch(error => {
                  if (__DEV__) console.warn('[vector] message cleanup failed', error);
                });
              }
            }
            setMessages(current => removeMessagesByIds(current, ids));
            ids.forEach(id => {
              delete errorRawRef.current[id];
              delete messageOffsetsRef.current[id];
            });
            setSelectedMessageIds([]);
            setFocusedMessageId(current => (
              ids.includes(current) ? '' : current
            ));
            setQuoteTarget(current => (
              current && ids.includes(String(current.id || '')) ? null : current
            ));
            if (clearsAll) {
              setInput('');
              draftTextRef.current = '';
              persistDraftNow(sessionId, '');
            }
          },
        },
      ]
    );
  }, [character, characterId, characters, isSending, persistDraftNow, ready, refreshSessions, removeVectorIndexForMessages, removeVectorIndexForSession, selectedMessageIds, setSessionGreetingSelected, updateCharacter]);

  // 生成配图用的场景描述：取回复对应位置的段落，交给模型转写成一句画面描述。
  // 转写失败（无配置 / 请求错误 / 空结果）时回退用该段原文，保证配图流程不中断。
  const resolveInlineImageScene = useCallback(async ({ messageId, replyText, position, signal }) => {
    const segment = selectReplySegment(replyText, position);
    if (!segment) return '';
    const sceneCharacter = charactersRef.current.find(
      item => String(item && item.id || '') === activeCharacterIdRef.current
    );
    const charName = String((sceneCharacter && sceneCharacter.name) || '').trim() || '角色';
    const userName = String(userNameRef.current || '').trim() || '用户';
    // 找到这条助手消息之前最近的一条用户消息，作为转写的上下文。
    const list = Array.isArray(messagesRef.current) ? messagesRef.current : [];
    const assistantIndex = list.findIndex(item => String(item && item.id || '') === String(messageId || ''));
    const before = assistantIndex >= 0 ? list.slice(0, assistantIndex) : list;
    let userText = '';
    for (let index = before.length - 1; index >= 0; index -= 1) {
      const item = before[index];
      if (item && item.role === 'user' && String(item.text || '').trim()) {
        userText = String(item.text || '').trim();
        break;
      }
    }
    try {
      const { configs, activeId } = await getApiConfigs();
      const config = configs.find(item => item.id === activeId) || configs[0];
      if (!config) return segment;
      const raw = await sendChatMessage([
        { role: 'system', content: '你负责把一段角色对话转写成一句画面描述，只输出描述本身。' },
        { role: 'user', content: buildScenePrompt({ segment, userText, charName, userName }) },
      ], {
        stream: false,
        signal,
        expectedConfigId: String(config.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(config),
      });
      if (signal && signal.aborted) return segment;
      // 空响应返回的是占位文本，不是画面：直接用原文兜底。
      if (!raw || String(raw).trim() === EMPTY_REPLY_TEXT) return segment;
      const scene = normalizeScenePrompt(raw);
      return scene || segment;
    } catch (error) {
      // 场景转写是增值步骤：失败就用原文兜底，不打断配图。
      return segment;
    }
  }, []);

  const generateInlineImage = useCallback(async (messageId, sourceText) => {
    if (inlineImageBusyRef.current) {
      Alert.alert('配图生成中', '请稍后重试。');
      return;
    }
    const settings = inlineImageSettings;
    const providerId = settings.providerId || '';
    if (!providerId) {
      Alert.alert('未配置生图服务', '请到「设置 → 对话配图」选择生图服务并填写密钥。');
      return;
    }
    const provider = getImageProvider(providerId);

    let genConfig = null;
    try {
      const stored = await getImageGenSettings();
      genConfig = (stored.providers && stored.providers[providerId]) || null;
    } catch (error) {
      genConfig = null;
    }
    if (!genConfig || !String(genConfig.baseUrl || provider.baseUrl || '').trim()) {
      Alert.alert('未配置生图服务', '请到「设置 → 对话配图」填写服务地址与密钥。');
      return;
    }

     const controller = new AbortController();
     const sessionId = activeSessionIdRef.current;
     inlineImageControllerRef.current = controller;
     inlineImageBusyRef.current = true;
     setMessages(current => current.map(item => (

      item.id === messageId ? { ...item, inlineImage: { status: 'loading' } } : item
    )));
    try {
      // 先把「角色说完这段话后所处的画面」转写成生图提示词；失败回退用回复段落本身。
      const sceneText = await resolveInlineImageScene({
        messageId,
        replyText: sourceText,
        position: settings.imagePosition,
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeSessionIdRef.current !== sessionId) return;
      const prompt = buildInlineImagePrompt(
        sceneText,
        settings.stylePrefix,
        settings.maxPromptChars
      );
      if (!prompt) {
        throw new Error('没有可用的配图提示词');
      }
      const response = await generateImage({
        provider,
        config: genConfig,
         prompt,
         size: settings.size,
         signal: controller.signal,
       });
       if (controller.signal.aborted || activeSessionIdRef.current !== sessionId) return;
       const first = response.images[0] || null;

      setMessages(current => current.map(item => (
        item.id === messageId
          ? {
            ...item,
            inlineImage: first ? { status: 'done', ...first } : { status: 'error', message: '未获取到图片' },
          }
          : item
      )));
     } catch (error) {
       if (!controller.signal.aborted && activeSessionIdRef.current === sessionId) {
         setMessages(current => current.map(item => (
           item.id === messageId
             ? { ...item, inlineImage: { status: 'error', message: (error && error.message) || '配图生成失败' } }
             : item
         )));
       }
     } finally {
       if (inlineImageControllerRef.current === controller) {
         inlineImageControllerRef.current = null;
         inlineImageBusyRef.current = false;
       }

    }
  }, [inlineImageSettings, resolveInlineImageScene]);

  // 角色语音形态（需求 5）：回复 settle 后按角色卡 voiceDisplay 合成语音并挂到消息。
  // 合成由 useChatTts.synthesizeVoice 完成（失败静默返回 null，降级仅文字）。
  // 挂载按消息 id 匹配：切走会话后 id 匹配不到则无害跳过；仍在列表内则随快照落盘。

  const sendTextRef = useRef(sendText);
  const recordTurnQueueRef = useRef(Promise.resolve());
  useEffect(() => {
    generateInlineImageRef.current = generateInlineImage;
    inlineImageEnabledRef.current = inlineImageSettings.enabled;
  }, [generateInlineImage, inlineImageSettings.enabled]);
  useEffect(() => {
    sendTextRef.current = sendText;
  }, [sendText]);

  const onSlashCommand = useCallback((command, token, sourceMessageId = '') => {
    if (
      sourceMessageId
      && !messagesRef.current.some(message => String(message && message.id || '') === String(sourceMessageId))
    ) return;
    const execute = () => {
      if (
        sourceMessageId
        && !messagesRef.current.some(message => String(message && message.id || '') === String(sourceMessageId))
      ) return;
      const result = sendTextRef.current?.(String(command || '').replace(/^\/send\s+/, ''));
      if (result && typeof result.catch === 'function') {
        result.catch(error => {
          if (!isConfigChangedError(error)) {
            Alert.alert('发送失败', maskSecrets((error && error.message) || '请稍后重试。'));
          }
        });
      }
    };
    if (!sourceMessageId) {
      execute();
      return;
    }
    Alert.alert(
      '确认卡片操作',
      `将发送：${maskSecrets(String(command || '').slice(0, 500))}`,
      [
        { text: '取消', style: 'cancel' },
        { text: '发送', onPress: execute },
      ],
    );
  }, []);

  const removeAttachment = useCallback(id => {
     if (isSending || sendLockRef.current) return;
     const target = attachments.find(item => item.id === id);
     if (target && target.kind === 'image') deleteLocalImage(target.uri);
     setAttachments(current => {
       const next = current.filter(item => item.id !== id);
       attachmentsRef.current = next;
       return next;
     });
     syncProtectedAttachmentUris();
   }, [attachments, isSending, syncProtectedAttachmentUris]);

  const addAttachment = useCallback(async kind => {
    const sessionGuard = captureSessionGuard();
    if (
      !isSessionGuardCurrent(sessionGuard)
      || isSending
      || isSwitching
      || sessionTransitionPending
      || sendLockRef.current
      || attachmentLoading
      || attachmentPickerLockRef.current
      || !ready
      || messageSelectionOpen
    ) return;
    attachmentPickerLockRef.current = true;
    setAttachmentLoading(true);
    let durableUri = '';
    let picked = null;
    try {
      // 拍照走相机，其余走系统文件选择器。两者产出同一形状，后续校验与落盘复用。
      picked = kind === 'camera' ? await takePhoto() : await pickAttachment();
      if (picked && picked.denied) {
        Alert.alert(
          '需要相机权限',
          '拍照需要访问相机。请在系统「设置 → 应用 → EasyChat2 → 权限」中开启相机权限后重试。'
        );
        return;
      }
      if (!picked) return;
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (kind === 'text') {
        if (!isTextLike(picked.name, picked.mime)) {
          deleteTemporaryImage(picked.uri);
          Alert.alert('不支持的文件', '当前仅支持纯文本类文档。');
          return;
        }
        const text = await readTextAttachment(picked.uri);
        if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        deleteTemporaryImage(picked.uri);
        setAttachments(current => {
          const next = [...current, {
            id: `${Date.now()}-${current.length}`,
            kind: 'text',
            name: picked.name,
            text,
          }];
          attachmentsRef.current = next;
          return next;
        });
        return;
      }
       if (!isImage(picked.name, picked.mime)) {
         deleteTemporaryImage(picked.uri);
         Alert.alert('不支持的文件', '请选择图片文件。');
         return;
       }
       if (!isVisionImage(picked.name, picked.mime)) {
         deleteTemporaryImage(picked.uri);
         Alert.alert('不支持的图片格式', '请选择 PNG、JPEG、WebP 或 GIF 图片。');
         return;
       }
       const fileInfo = await getImageFileInfo(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (!fileInfo.exists) throw new Error('图片不存在');
      const size = fileInfo.size || picked.size;
      validateImageSize({ size });
      if (isSending || isSwitching || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      const dimensions = picked.width && picked.height
        ? { width: picked.width, height: picked.height }
        : await getImageDimensions(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      validateImageSize({ size, width: dimensions.width, height: dimensions.height });
      if (attachmentsRef.current.filter(item => item.kind === 'image').length >= MAX_IMAGE_ATTACHMENTS) {
        deleteTemporaryImage(picked.uri);
        Alert.alert('图片过多', `一次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
        return;
      }
      const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
        getApiConfigs(),
        getLocalModelSettings().catch(() => null),
        getActiveLocalModel().catch(() => null),
      ]);
      const current = configs.find(item => item.id === activeId) || configs[0];
      const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
      if ((!current || current.supportsVision !== true) && !localMedia.vision) {
        deleteTemporaryImage(picked.uri);
        Alert.alert('不支持识图', '当前来源未标记为支持识图，请在设置中确认模型能力。');
        return;
      }
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      durableUri = await persistImageAttachment(picked.uri, picked.mime, picked.name);
      deleteTemporaryImage(picked.uri);
      pendingAttachmentUrisRef.current.add(durableUri);
      syncProtectedAttachmentUris();
      const mime = getImageMime(picked.name, picked.mime);
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        pendingAttachmentUrisRef.current.delete(durableUri);
        syncProtectedAttachmentUris();
        deleteLocalImage(durableUri);
        return;
      }
      setAttachments(list => {
        const next = [...list, {
          id: `${Date.now()}-${list.length}`,
          kind: 'image',
          name: picked.name,
          uri: durableUri,
          mime,
          size,
          width: dimensions.width,
          height: dimensions.height,
        }];
        attachmentsRef.current = next;
        return next;
      });
      pendingAttachmentUrisRef.current.delete(durableUri);
      syncProtectedAttachmentUris();
    } catch (error) {
      if (durableUri) {
        pendingAttachmentUrisRef.current.delete(durableUri);
        syncProtectedAttachmentUris();
        deleteLocalImage(durableUri);
      }
      if (picked && picked.uri) deleteTemporaryImage(picked.uri);
      Alert.alert(
        '文件读取失败',
        ['文件过大', '图片过大', '图片分辨率过大', '图片总大小过大'].includes(error && error.message)
          ? '文件过大，请选择更小的文件。'
          : '请重试。'
       );
     } finally {
       attachmentPickerLockRef.current = false;
       setAttachmentLoading(false);
     }
   }, [attachmentLoading, captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, messageSelectionOpen, ready, sessionTransitionPending, syncProtectedAttachmentUris]);

  const pickAttachmentMenu = useCallback(() => {
    setAttachmentMenuOpen(true);
  }, []);

  const selectAttachmentKind = useCallback(kind => {
    setAttachmentMenuOpen(false);
    addAttachment(kind);
  }, [addAttachment]);

  const openStickerNamePrompt = useCallback(source => {
    if (!source || !source.uri) return;
    setStickerNameDraft('');
    setStickerNamePrompt({
      uri: String(source.uri),
      mime: String(source.mime || 'image/jpeg'),
      name: String(source.name || ''),
       width: Number(source.width) || 0,
       height: Number(source.height) || 0,
       size: Number(source.size) || 0,
       sessionId: activeSessionIdRef.current,
       sessionVersion: sessionVersionRef.current,
     });
  }, []);

  const confirmDeleteImageMessage = useCallback(messageId => {
    if (!messageId) return;
    const sessionId = activeSessionIdRef.current;
    const sessionVersion = sessionVersionRef.current;
    const session = sessionsRef.current.find(item => item.id === sessionId);
    Alert.alert('删除图片消息', '确定删除这张图片消息吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          if (
            activeSessionIdRef.current !== sessionId
            || sessionVersionRef.current !== sessionVersion
          ) return;
          sessionVersionRef.current += 1;
          const vectorOwnerId = getVectorOwnerId(session, characterId);
          if (vectorOwnerId) {
            removeVectorIndexForMessage(vectorOwnerId, sessionId, messageId).catch(error => {
              if (__DEV__) console.warn('[vector] image cleanup failed', error);
            });
          }
          setMessages(current => removeMessagesByIds(current, [messageId]));
          setSelectedMessageIds(current => current.filter(id => id !== messageId));
          setFocusedMessageId(current => current === messageId ? '' : current);
        },
      },
    ]);
  }, [characterId, removeVectorIndexForMessage]);

  const confirmStickerName = useCallback(async () => {
    if (stickerSaveLockRef.current) return;
    const source = stickerNamePrompt;
    const name = String(stickerNameDraft || '').trim();
     if (!source || !name) {
       if (source) Alert.alert('请输入名称', '表情包需要一个名称，方便模型理解。');
       return;
     }
     if (
       String(source.sessionId || '') !== String(activeSessionIdRef.current)
       || Number(source.sessionVersion) !== Number(sessionVersionRef.current)
     ) {
       deleteTemporaryImage(source.uri);
       setStickerNamePrompt(null);
       setStickerNameDraft('');
       return;
     }
     stickerSaveLockRef.current = true;
     setStickerSaving(true);
     let processedUri = '';
     let sourceConsumed = false;
    try {
       const processed = await createStickerImage(source.uri, source.width, source.height);
       processedUri = processed.uri;
       if (
         String(source.sessionId || '') !== String(activeSessionIdRef.current)
         || Number(source.sessionVersion) !== Number(sessionVersionRef.current)
       ) {
         deleteStickerImage(processedUri);
         processedUri = '';
         sourceConsumed = true;
         return;
       }
       const saved = await saveSticker({
        id: `sticker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        uri: processed.uri,
        mime: processed.mime,
        width: processed.width,
        height: processed.height,
        createdAt: Date.now(),
      });
      stickerLoadRef.current += 1;
      setStickers(current => [saved, ...current.filter(item => item.id !== saved.id)]);
       setStickerNamePrompt(null);
       setStickerNameDraft('');
       setStickerPanelOpen(true);
       sourceConsumed = true;
    } catch (error) {
      if (processedUri) deleteStickerImage(processedUri);
      Alert.alert('保存表情包失败', (error && error.message) || '请稍后重试。');
     } finally {
       if (sourceConsumed && source && source.uri) deleteTemporaryImage(source.uri);
       stickerSaveLockRef.current = false;
       setStickerSaving(false);
     }
  }, [deleteStickerImage, deleteTemporaryImage, saveSticker, stickerNameDraft, stickerNamePrompt]);

  const addStickerFromPicker = useCallback(async () => {
    const sessionGuard = captureSessionGuard();
    if (!isSessionGuardCurrent(sessionGuard)
      || stickerSaving
      || isSending
      || isSwitching
      || stickerPickerLockRef.current) return;
    stickerPickerLockRef.current = true;
    let picked = null;
    try {
       picked = await pickStickerImage();
       if (!picked) return;
       if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
         deleteTemporaryImage(picked.uri);
         return;
       }
      if (!isImage(picked.name, picked.mime)) {
        deleteTemporaryImage(picked.uri);
        Alert.alert('不支持的文件', '请选择一张图片。');
        return;
      }
      const fileInfo = await getImageFileInfo(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (!fileInfo.exists) throw new Error('图片不存在');
      const size = fileInfo.size || picked.size;
      validateImageSize({ size });
      const dimensions = picked.width && picked.height
        ? { width: picked.width, height: picked.height }
        : await getImageDimensions(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      validateImageSize({ size, width: dimensions.width, height: dimensions.height });
      openStickerNamePrompt({
        uri: picked.uri,
        mime: picked.mime || 'image/jpeg',
        name: picked.name,
        width: dimensions.width,
        height: dimensions.height,
        size,
      });
    } catch (error) {
      if (picked && picked.uri) deleteTemporaryImage(picked.uri);
      Alert.alert('选择图片失败', (error && error.message) || '请重试。');
    } finally {
      stickerPickerLockRef.current = false;
    }
  }, [captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, openStickerNamePrompt, sessionTransitionPending, stickerSaving]);

  useEffect(() => {
    if (!ready || stickerSaving || stickerNamePrompt || stickerPickerLockRef.current) return undefined;
     stickerPickerLockRef.current = true;
      const sessionGuard = captureSessionGuard();
      let cancelled = false;
      let picked = null;
     (async () => {
       picked = pendingStickerResultRef.current || await getPendingStickerImage();
       pendingStickerResultRef.current = null;
       if (!picked) return;
       if (cancelled || !isSessionGuardCurrent(sessionGuard) || isSwitching) {
         pendingStickerResultRef.current = picked;
         return;
       }
        if (!isImage(picked.name, picked.mime)) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        const fileInfo = await getImageFileInfo(picked.uri);
        if (!fileInfo.exists) throw new Error('图片不存在');
        const size = fileInfo.size || picked.size;
        validateImageSize({ size });
        const dimensions = picked.width && picked.height
          ? { width: picked.width, height: picked.height }
          : await getImageDimensions(picked.uri);
        if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        validateImageSize({ size, width: dimensions.width, height: dimensions.height });
       if (cancelled || !isSessionGuardCurrent(sessionGuard) || isSwitching) {
         pendingStickerResultRef.current = picked;
         return;
       }
       openStickerNamePrompt({
         uri: picked.uri,
         mime: picked.mime || 'image/jpeg',
         name: picked.name,
         width: dimensions.width,
         height: dimensions.height,
         size,
       });
     })().catch(error => {
       if (picked && picked.uri) deleteTemporaryImage(picked.uri);
       if (!cancelled) Alert.alert('选择图片失败', (error && error.message) || '请重试。');
     }).finally(() => {
      stickerPickerLockRef.current = false;
    });
    return () => {
      cancelled = true;
      stickerPickerLockRef.current = false;
    };
  }, [captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, openStickerNamePrompt, ready, sessionTransitionPending, stickerNamePrompt, stickerSaving]);

  const saveImage = useCallback(async image => {
    if (!image || !image.uri) return;
    try {
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (!available) throw new Error('当前设备不支持保存图片');
      await Sharing.shareAsync(String(image.uri), {
        mimeType: String(image.mime || 'image/jpeg'),
        dialogTitle: '保存图片',
        UTI: 'public.image',
      });
    } catch (error) {
      Alert.alert('保存图片失败', (error && error.message) || '请稍后重试。');
    }
  }, []);

  const openImageActions = useCallback((image, messageId) => {
    if (!image || !image.uri) return;
    Alert.alert('图片操作', image.stickerName ? `「${image.stickerName}」` : '选择图片操作', [
      { text: '取消', style: 'cancel' },
      { text: '保存', onPress: () => saveImage(image) },
      { text: '保存为表情包', onPress: () => openStickerNamePrompt(image) },
      { text: '删除消息', style: 'destructive', onPress: () => confirmDeleteImageMessage(messageId) },
    ]);
  }, [confirmDeleteImageMessage, openStickerNamePrompt, saveImage]);

  const sendSticker = useCallback(async sticker => {
     if (!sticker || messageSelectionOpen || isSending || isSwitching || sessionTransitionPending || !ready || abortRef.current) return;
    const sessionGuard = captureSessionGuard();
    if (!isSessionGuardCurrent(sessionGuard)) return;
    try {
      const sent = await sendMessage(input, [{
        id: `sticker-${Date.now()}`,
        kind: STICKER_MESSAGE_KIND,
        name: sticker.name,
        stickerName: sticker.name,
        stickerId: sticker.id,
        uri: sticker.uri,
        mime: sticker.mime,
        width: sticker.width,
        height: sticker.height,
      }], sessionGuard);
       if (sent) {
         setStickerPanelOpen(false);
       }
    } catch (error) {
      Alert.alert('发送表情包失败', (error && error.message) || '请稍后重试。');
    }
  }, [captureSessionGuard, input, isSending, isSessionGuardCurrent, isSwitching, messageSelectionOpen, ready, sendMessage, sessionTransitionPending]);

  // 把助手回复拆成 [文字消息, ...表情包消息]。表情包名称严格取自用户现有表情包，
  // 白名单外的 [[表情包:xxx]] 由 extractStickerDirectives 丢弃并保留原样。

  const deleteStickerItems = useCallback(async ids => {
    const result = await deleteStickers(ids);
    stickerLoadRef.current += 1;
    setStickers(result.remaining);
    (result.removed || []).forEach(item => {
      if (item.uri) deleteStickerImage(item.uri);
    });
    return result.remaining;
  }, [deleteStickerImage, deleteStickers]);

  const reorderStickerItems = useCallback(async orderedIds => {
    const next = await reorderStickers(orderedIds);
    stickerLoadRef.current += 1;
    setStickers(next);
    return next;
  }, [reorderStickers]);

  const onSend = useCallback(async () => {
    const text = input.trim();
     if (messageSelectionOpen || (!text && attachments.length === 0) || isSending || isSwitching || sessionTransitionPending || !ready || abortRef.current) return;
    if (!isGroupRef.current && !greetingReady) {
      openGreetingPicker(activeSessionId ? 'reselect' : 'new');
      return;
    }
     await sendText(input);
   }, [activeSessionId, attachments.length, greetingReady, input, isSending, isSwitching, messageSelectionOpen, openGreetingPicker, ready, sendText, sessionTransitionPending]);

  // 语音录制入口：仅在单聊、非群聊、就绪时可用。
  const voiceEnabled = !isGroup && !sessionOwnerMissing && ready;

  const onStartVoice = useCallback(async () => {
    if (!voiceEnabled || isSending || isSwitching || messageSelectionOpen || voiceBusy) return;
    if (!isGroupRef.current && !greetingReady) {
      openGreetingPicker(activeSessionId ? 'reselect' : 'new');
      return;
    }
    try {
      await recorder.start();
    } catch (error) {
      Alert.alert('无法录音', maskSecrets((error && error.message) || '请检查麦克风权限。'));
    }
  }, [voiceEnabled, isSending, isSwitching, messageSelectionOpen, voiceBusy, greetingReady, activeSessionId, openGreetingPicker, recorder]);

  const onCancelVoice = useCallback(async () => {
    try {
      await recorder.cancel();
    } catch (error) {}
  }, [recorder]);

  // 结束录音 → 转写（复用聊天来源 → 独立配置 → 占位）→ 作为语音消息发送。
  const onStopVoice = useCallback(async () => {
    if (voiceBusy) return;
    setVoiceBusy(true);
    let audio = null;
    try {
      audio = await recorder.stop();
    } catch (error) {
      Alert.alert('录音失败', maskSecrets((error && error.message) || '请重试。'));
      setVoiceBusy(false);
      return;
    }
    if (!audio || !audio.uri) {
      setVoiceBusy(false);
      return;
    }
    const guard = captureSessionGuard();
    let text = '';
    try {
      const [{ configs, activeId }, transcriptionSettings] = await Promise.all([
        getApiConfigs(),
        getTranscriptionSettings().catch(() => ({ activeId: '', configs: [] })),
      ]);
      const activeChat = configs.find(item => item.id === activeId) || configs[0] || null;
      const dedicated = transcriptionSettings.configs.find(
        item => item.id === transcriptionSettings.activeId
      ) || null;
      const target = resolveTranscription({ chatConfig: activeChat, dedicated });
      // 无任何可用的转写来源：明确提示引导补配，本条仍按占位发送（不阻断）。
      if (target.source === 'none') {
        Alert.alert(
          '未配置语音转写',
          '当前聊天来源不支持转写时，可在「设置 → 语音转文字」新增独立转写配置：点厂商芯片（硅基流动 / Groq / OpenAI）一键预填端点与模型，再填入 API Key。本条语音将以占位文本发送。'
        );
      }
      // 该会话已确认来源不支持转写：跳过请求，直接用占位（需求 3.5）。
      const known = transcriptionSupportedRef.current[guard.sessionId];
      if (target.source !== 'none' && known !== false) {
        try {
          const result = await transcribeAudio({
            config: target,
            fileUri: audio.uri,
            mime: audio.mime,
          });
          text = String(result.text || '').trim();
        } catch (error) {
          if (isUnsupportedTranscriptionError(error)) {
            transcriptionSupportedRef.current[guard.sessionId] = false;
            Alert.alert(
              '当前来源不支持语音转写',
              '可在「设置 → 语音转文字」新增独立转写配置：点厂商芯片（硅基流动 / Groq / OpenAI）一键预填，或改用支持音频的模型并在「设置 → API」打开「支持语音识别」。本条语音将以占位文本发送。'
            );
          } else {
            // 网络类/其他失败：明确告知（角色收不到文字的根因可见），本条按占位发送。
            recordDiagnostic('api', error, 'voice-transcribe');
            Alert.alert(
              '语音转写失败',
              `已按占位文本发送，角色收不到语音内容。原因：${String((error && error.message) || '未知')}\n\n可到「设置 → 语音转文字」检查接口地址、密钥与模型名。`
            );
          }
        }
      }
    } catch (error) {}
    if (!isSessionGuardCurrent(guard)) {
      setVoiceBusy(false);
      return;
    }
    // 转写成功时把文本回填输入框（让用户可见），同时仍以语音气泡发送。
    if (text) setInput(text);
    try {
      await sendMessage(text, [], guard, { uri: audio.uri, mime: audio.mime, durationMs: audio.durationMs, text });
    } finally {
      setVoiceBusy(false);
    }
  }, [voiceBusy, recorder, captureSessionGuard, isSessionGuardCurrent, sendMessage]);


  const insertMention = useCallback(name => {
    const label = `${MENTION_PREFIX}${name} `;
    const current = input;
    const selection = inputSelectionRef.current || { start: current.length, end: current.length };
    const start = Math.max(0, Math.min(selection.start, current.length));
    const end = Math.max(start, Math.min(selection.end, current.length));
    const next = `${current.slice(0, start)}${label}${current.slice(end)}`;
    const caret = start + label.length;
    inputSelectionRef.current = { start: caret, end: caret };
    onInputChange(next);
  }, [input, onInputChange]);

  const bgUri = isGroup
    ? String(activeSession?.bgUri || '')
    : (character.bgUri || '');
  const groupAvatarUri = isGroup ? String(activeSession?.avatarUri || '') : '';
  const displayName = isGroup
    ? (activeSession?.name || groupCharacters.map(item => item.name).join('、') || '群聊')
    : (sessionOwnerMissing ? '角色资料缺失' : (character.name || 'EasyChat2 助手'));
  const inputDisabled = !ready || isSending || isSwitching || attachmentLoading || messageSelectionOpen || sessionOwnerMissing || sessionTransitionPending || (!isGroup && !greetingReady);

  const runRecordTurn = useCallback(async (userText, assistantText, sender = null) => {
    const settings = await getMomentsSettings().catch(() => ({ enabled: true }));
    if (!settings.enabled) return;
    const characterId = String((sender && sender.id) || activeCharacterIdRef.current || '');
    if (!characterId) return;
    const senderName = String((sender && sender.name) || '').trim() || '角色';
    const senderAvatarUri = String((sender && sender.avatarUri) || '').trim();
    const { delta, milestone } = evaluateTurn({ userText, assistantText });
    const affinityStatus = await getAffinityStatus().catch(() => ({ status: 'corrupt', map: {} }));
    if (affinityStatus.status === 'corrupt') return;
    const map = affinityStatus.map;
    const current = map[characterId] || { score: 0, turnCount: 0, triggers: [] };
    const next = {
      score: clampAffinity(current.score + delta),
      turnCount: current.turnCount + 1,
      triggers: Array.isArray(current.triggers) ? current.triggers : [],
    };
    const trigger = shouldTrigger({
      affinity: next.score,
      turnCount: next.turnCount,
      milestone,
      triggers: next.triggers,
    });
    if (!trigger) {
       await saveAffinity({ ...map, [characterId]: next }).catch(error => {
         if (__DEV__) console.warn('[moments] affinity save failed', error);
       });
       return;

    }
    next.triggers = [...next.triggers, trigger];
     await saveAffinity({ ...map, [characterId]: next }).catch(error => {
       if (__DEV__) console.warn('[moments] affinity save failed', error);
     });

    const moment = {
      id: `${Date.now()}-${trigger}`,
      characterId,
      characterName: senderName,
      avatarUri: senderAvatarUri,
      sessionId: String((sender && sender.sessionId) || activeSessionIdRef.current || ''),
      trigger,
      text: buildMomentText({
        trigger,
        character: { name: senderName },
        seed: next.turnCount,
      }),
      createdAt: Date.now(),
      likedByUser: false,
      likes: [],
      comments: [],
    };
     await updateMoments(moments => appendMoment(moments, moment)).catch(error => {
       if (__DEV__) console.warn('[moments] dynamic save failed', error);
     });
    // 同住角色的点赞 / 评论：异步、失败静默，不阻塞发动态主流程。
    runHousemateReactions({ momentId: moment.id }).catch(error => {
      if (__DEV__) console.warn('[moments] housemate reactions failed', error);
    });

  }, []);
  // affinity 是读-改-写：连续两次回复若并行读取同一份 map，后写会覆盖先写的增量。
  // 用 promise 队列把 recordTurn 串行化，保证每次基于上一次结果累加。
  const recordTurn = useCallback((userText, assistantText, sender = null) => {
    const task = recordTurnQueueRef.current
      .catch(() => {})
      .then(() => runRecordTurn(userText, assistantText, sender));
    recordTurnQueueRef.current = task;
    return task;
  }, [runRecordTurn]);
  // recordTurn 声明在下方，这里用 ref 暴露给它上面的回调，避免依赖数组引用“后声明”的 const（TDZ）。
  useEffect(() => {
    recordTurnRef.current = recordTurn;
  }, [recordTurn]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      {bgUri ? (
        <Image key={bgUri} source={{ uri: bgUri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" pointerEvents="none" />
      ) : null}
      <ChatTopBar
        messageSelectionOpen={messageSelectionOpen}
        selectedCount={selectedMessageIds.length}
        allSelected={allMessagesSelected}
        isSending={isSending}
        onCancelSelection={cancelMessageSelection}
        onToggleSelectAll={toggleSelectAllMessages}
        onDeleteSelected={confirmDeleteSelectedMessages}
        onOpenSwitcher={() => setSwitcherOpen(true)}
        loaded={loaded}
        isGroup={isGroup}
        groupAvatarUri={groupAvatarUri}
        characterAvatarUri={character.avatarUri}
        displayName={displayName}
        onNewChat={onNewChat}
        ready={ready}
        autoBroadcast={ttsSettings.autoBroadcast}
        onToggleBroadcast={toggleBroadcast}
        onOpenMore={() => setMoreOpen(true)}
      />
      <View style={styles.aiNoticeBar} pointerEvents="none">
        <Text style={styles.aiNoticeText}>{AI_DISCLAIMER_TEXT}</Text>
      </View>
      <ChatSearchBar
        visible={searchOpen}
        query={searchQuery}
        onChangeQuery={setSearchQuery}
        matchCount={searchMatches.length}
        activeMatchIndex={activeMatchIndex}
        onPrev={() => goToMatch(-1)}
        onNext={() => goToMatch(1)}
        onClose={closeSearch}
      />
      <MessageList
        scrollRef={ scrollRef }
        styles={ styles }
        autoScrollToBottom={ autoScrollToBottom }
        onMessagesScroll={ onMessagesScroll }
        messages={ messages }
        bgUri={ bgUri }
        isGroup={ isGroup }
        sessionOwnerMissing={ sessionOwnerMissing }
        openGreetingPicker={ openGreetingPicker }
        activeSessionId={ activeSessionId }
        theme={ theme }
        character={ character }
        greetingReady={ greetingReady }
        renderedMessages={ renderedMessages }
        characterMap={ characterMap }
        selectedMessageIdSet={ selectedMessageIdSet }
        messageSelectionOpen={ messageSelectionOpen }
        windowSize={ messageWindowSize }
        onExpandWindow={ expandMessageWindow }
        chatOptions={ chatOptions }
        errorRawRef={ errorRawRef }
        rawTextById={ rawTextById }
        displayName={ displayName }
        groupCharacters={ groupCharacters }
        groupAvatarUri={ groupAvatarUri }
        userAvatar={ userAvatar }
        onSlashCommand={ onSlashCommand }
        regenerableIds={ regenerableIds }
        onRegenerateMessage={ onRegenerateMessage }
        onEditUserMessage={ onEditUserMessage }
        onSelectText={ onSelectText }
        onQuoteMessage={ onQuoteMessage }
        onPressQuoteBlock={ onPressQuoteBlock }
        generateInlineImage={ generateInlineImage }
        broadcastMessage={ broadcastMessage }
        searchQuery={ searchQuery }
        searchMatches={ searchMatches }
        focusedMessageId={ focusedMessageId }
        onReselectGreeting={ onReselectGreeting }
        startMessageSelection={ startMessageSelection }
        thinkingDisplay={ thinkingDisplay }
        onMessageLayout={ onMessageLayout }
        openImageActions={ openImageActions }
        toggleSelectedMessage={ toggleSelectedMessage }
        ready={ ready }
        isSending={ isSending }
      />

      <ChatComposer
        quoteTarget={quoteTarget}
        quoteLocked={isSending || !!sendLockRef.current}
        onCancelQuote={() => {
          if (!isSending && !sendLockRef.current) setQuoteTarget(null);
        }}
        bgUri={bgUri}
        attachments={attachments}
        attachLocked={isSending || !!sendLockRef.current}
        onRemoveAttachment={removeAttachment}
        isSending={isSending}
        isGroup={isGroup}
        inputDisabled={inputDisabled}
        onPickAttachment={pickAttachmentMenu}
        onOpenMention={() => setMentionPickerOpen(true)}
        input={input}
        onChangeInput={onInputChange}
        inputFocused={inputFocused}
        onInputFocus={() => setInputFocused(true)}
        onInputBlur={() => setInputFocused(false)}
        onSelectionChange={event => {
          inputSelectionRef.current = event.nativeEvent.selection;
        }}
        onOpenSticker={() => setStickerPanelOpen(true)}
        onOpenFullScreen={() => {
          setFullScreenText(input);
          setFullScreenOpen(true);
        }}
        fullScreenDisabled={!ready || sessionOwnerMissing || (!isGroup && !greetingReady)}
        onStop={onStop}
        onSend={onSend}
        voiceEnabled={voiceEnabled}
        recording={recorder.recording}
        onStartVoice={onStartVoice}
        onStopVoice={onStopVoice}
        onCancelVoice={onCancelVoice}
      />

      <StickerPanelModal
        visible={stickerPanelOpen}
        onClose={() => setStickerPanelOpen(false)}
        stickers={stickers}
        stickerSaving={stickerSaving}
        addStickerFromPicker={addStickerFromPicker}
        sendSticker={sendSticker}
        inputDisabled={inputDisabled}
        onDeleteStickers={deleteStickerItems}
        onReorderStickers={reorderStickerItems}
      />

      <StickerNamePromptModal
        visible={!!stickerNamePrompt}
        onClose={closeStickerNamePrompt}
        draft={stickerNameDraft}
        onChangeDraft={setStickerNameDraft}
        confirmStickerName={confirmStickerName}
        stickerSaving={stickerSaving}
      />

      <AttachmentMenuModal
        visible={attachmentMenuOpen}
        onClose={() => setAttachmentMenuOpen(false)}
        onSelect={selectAttachmentKind}
        visionEnabled={attachmentVisionEnabled}
      />

      <FullScreenInputModal
        visible={fullScreenOpen}
        onClose={() => setFullScreenOpen(false)}
        text={fullScreenText}
        onChangeText={setFullScreenText}
        onSend={async () => {
          const text = fullScreenText.trim();
          const draft = fullScreenText;
          const sessionGuard = captureSessionGuard();
          setFullScreenOpen(false);
          if (!text) {
            setFullScreenText('');
            return;
          }
          const sent = await sendMessage(text, [], sessionGuard);
          if (!isSessionGuardCurrent(sessionGuard)) return;
          if (sent) {
            setFullScreenText('');
            setInput('');
            // 全屏输入的文本已作为消息发出，清掉主输入框与对应草稿。
            draftTextRef.current = '';
            persistDraftNow(sessionGuard.sessionId, '');
          } else {
            setFullScreenText(draft);
          }
        }}
      />

      <SwitcherModal
        visible={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        characters={characters}
        isGroup={isGroup}
        activeId={activeId}
        onSwitch={onSwitch}
        groupSessions={groupSessions}
        activeSessionId={activeSessionId}
        onSwitchGroup={onSwitchGroup}
        groupSessionName={groupSessionName}
      />

      <MentionPickerModal
        visible={mentionPickerOpen}
        onClose={() => setMentionPickerOpen(false)}
        groupCharacters={groupCharacters}
        insertMention={insertMention}
      />

      <SelectionTextModal text={selectionText} onClose={() => setSelectionText('')} />

      <MoreMenuModal
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        items={[
          {
            key: 'notice',
            label: '公告',
            icon: 'megaphone-outline',
            onPress: () => setNoticeOpen(true),
          },
          {
            key: 'model',
            label: '模型',
            icon: 'cube-outline',
            onPress: openModelPanel,
          },
          {
            key: 'local-logs',
            label: '本地日志',
            icon: 'document-text-outline',
            onPress: () => setLocalLogsOpen(true),
          },
          {
            key: 'thinking',
            label: '思考',
            icon: 'bulb-outline',
            onPress: openThinkingPanel,
          },
          {
            key: 'voice',
            label: '语音',
            icon: 'volume-high-outline',
            onPress: () => setVoiceSettingsOpen(true),
          },
          {
            key: 'scrubber',
            label: '定位',
            icon: 'options-outline',
            disabled: scrubberMessages.length === 0,
            onPress: () => setScrubberOpen(true),
          },
          {
            key: 'search',
            label: '搜索',
            icon: 'search',
            active: searchOpen,
            onPress: () => (searchOpen ? closeSearch() : setSearchOpen(true)),
          },
          {
            key: 'summary',
            label: summarizing ? '总结中' : '总结',
            icon: 'book-outline',
            disabled: summarizing || !ready,
            onPress: onSummarize,
          },
          {
            key: 'settings',
            label: '设置',
            icon: 'settings-outline',
            onPress: () => setChatSettingsOpen(true),
          },
        ]}
      />

      <ChatSettingsModal
        visible={chatSettingsOpen}
        onClose={() => setChatSettingsOpen(false)}
        onOpenSystemSettings={() => { if (navigation) navigation.navigate('设置'); }}
        editLabel={isGroup ? '编辑群聊' : '编辑角色'}
        onOpenEditor={() => {
          if (isGroup) setGroupEditOpen(true);
          else setCharacterEditOpen(true);
        }}
      />

      <VoiceSettingsModal
        visible={voiceSettingsOpen}
        onClose={() => setVoiceSettingsOpen(false)}
        voiceMode={!isGroup && character.voiceDisplay === 'voice'}
        onToggleVoiceMode={() => {
          if (isGroup || !characterId) return;
          const next = character.voiceDisplay === 'voice' ? 'text' : 'voice';
          updateCharacter({ id: characterId, voiceDisplay: next }).catch(() => {
            Alert.alert('保存失败', '请检查存储空间或权限。');
          });
        }}
        onOpenTranscription={() => setTranscriptionPanelOpen(true)}
      />

      <TranscriptionPanel
        visible={transcriptionPanelOpen}
        onClose={() => setTranscriptionPanelOpen(false)}
      />

      <CharacterEditForm
        visible={characterEditOpen}
        character={character}
        onClose={() => setCharacterEditOpen(false)}
        onSaved={() => {
          setCharacterEditOpen(false);
          Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');
        }}
      />

      <GroupEditForm
        visible={groupEditOpen}
        session={activeSession}
        members={groupCharacters}
        onClose={() => setGroupEditOpen(false)}
        onSaved={() => {
          setGroupEditOpen(false);
          refreshSessions().catch(() => {});
          Alert.alert('已保存', '群聊信息已更新。');
        }}
      />

      <GreetingPickerModal
        visible={!!greetingPicker}
        mode="select"
        candidates={greetingPicker ? greetingPicker.candidates : []}
        initialSelectedIndex={greetingPicker ? greetingPicker.initialSelectedIndex : undefined}
        onCancel={() => setGreetingPicker(null)}
        onConfirm={confirmGreeting}
      />

      <DisclaimerModal
        visible={noticeOpen}
        title="公告"
        onClose={() => setNoticeOpen(false)}
      />

      <ModelPanelModal
        visible={modelPanelOpen}
        onClose={() => setModelPanelOpen(false)}
        apiConfigs={apiConfigs}
        modelSourceId={modelSourceId}
        setModelSourceId={setModelSourceId}
        applyModelSelection={applyModelSelection}
        isSending={isSending}
        localModels={localModels}
        activeLocalModelId={activeLocalModelId}
        loadingLocalModelId={loadingLocalModelId}
        onActivateLocalModel={activateLocalModel}
        onDeactivateLocalModel={deactivateLocalModel}
        onOpenModelLogs={() => setLocalLogsOpen(true)}
      />

      <ModelLogsModal visible={localLogsOpen} onClose={() => setLocalLogsOpen(false)} />

      <ThinkingPanelModal
        visible={thinkingOpen}
        onClose={() => setThinkingOpen(false)}
        thinkingSupported={thinkingSupported}
        thinkingEnabled={thinkingEnabled}
        thinkingLevel={thinkingLevel}
        thinkingDisplay={thinkingDisplay}
        applyThinking={applyThinking}
      />

      <ScrollScrubber
        visible={scrubberOpen}
        onClose={() => setScrubberOpen(false)}
        messageCount={scrubberMessages.length}
        previews={scrubberPreviews}
        onSeek={onScrubberSeek}
        onToStart={onScrubberToStart}
        onToEnd={onScrubberToEnd}
      />
    </KeyboardAvoidingView>
  );
}
