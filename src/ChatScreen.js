import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, isConfigChangedError, sendChatMessage } from './api.js';
import {
   deleteLocalImage,
   deleteTemporaryImage,
    isImage,
    isTextLike,
    isVisionImage,
  mergeTextAttachments,
  persistImageAttachment,
  pickAttachment,
  pickStickerImage,
  readImageDataUri,
  readTextAttachment,
   getImageDimensions,
   getImageFileInfo,
   getImageMime,
   getPendingStickerImage,
   MAX_IMAGE_ATTACHMENTS,
   MAX_IMAGE_BASE64_BYTES,
   validateImageBatch,
   validateImageSize,
} from './attachments.js';
import { buildRequestMessages, filterRequestMedia } from './chatPipeline.js';
import { buildTimeAwareText } from './currentTime.js';
import { createMediaMessage, getMessagePromptText, STICKER_MESSAGE_KIND } from './chatMedia.js';
import { extractStickerDirectives, resolveStickerNames } from './stickerDirectives.js';
import { createStickerImage, deleteStickerImage } from './stickerImages.js';
import { getCachedDisplayText } from './displayTextCache.js';
import { isGreetingMessage, listGreetingCandidates } from './cardGreetings.js';
import {
  getEditResendPlan,
  removeMessagesByIds,
  selectableMessageIds,
  toggleMessageSelection,
} from './messageSelection.js';
import {
  applySummary,
  buildMemorySummaryText,
  invalidateHistorySummaries,
  isSessionScopedMemory,
  planMemoryBudget,
  selectManualSummarizable,
  selectSummarizable,
  shouldSummarize,
} from './memorySummary.js';
import { isStaleReply } from './chatRace.js';
import { useApp } from './context/AppContext.js';
import CharacterEditForm from './CharacterEditForm.js';
import GreetingPickerModal from './GreetingPickerModal.js';
import GroupEditForm from './GroupEditForm.js';
import DisclaimerModal from './disclaimer.js';
import {
  buildEnsemblePrompt,
  buildGroupRequest,
  ENSEMBLE_MODE,
  ensureMemberProfiles,
  generateOpening,
  hasEveryoneMention,
  mergeAdjacentSegments,
  MENTION_PREFIX,
  parseEnsembleReply,
  parseMentions,
  selectSpeakers,
} from './groupChat.js';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine.js';
import { containsHtml } from './plainText.js';
import { shouldRenderRichHtml } from './richHtml.js';
import ScrollScrubber from './ScrollScrubber.js';
import { maskSecrets } from './secrets.js';
import { hideVariantStatusBar } from './speechText.js';
import { recordDiagnostic } from './diagnostics.js';
import {
  clearSessionDraft,
  createGroupSession,
  DEFAULT_CHARACTER,
  getApiConfigs,
  getActiveLocalModel,
  getChatOptions,
  getEnabledGlobalPresetPrompts,
  getEnabledPlugins,
  getImageGenSettings,
  getLocalModelSettings,
  getInlineImageSettings,
  getMemorySummarySettings,
  getMessagesBySessionStatus,
  getSessionDraft,
  getSessionSummaries,
  getStickers,
  getThinkingSettings,
  getTranscriptionSettings,
  getUserProfile,
  hasShownDefaultGreeting,
  markDefaultGreetingShown,
  saveMessagesBySession,
  saveSessionDraft,
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
  startNewSession,
  updateSessionMemberProfiles,
  getVectorMemoryConfig,
  getVectorIndex,
  removeVectorIndexForMessage,
  removeVectorIndexForMessages,
  removeVectorIndexForSession,
  updateVectorIndex,
} from './storage.js';

import { runPlugins } from './plugins/registry.js';
import {
  buildMemoryContext,
  indexMessages,
  retrieve,
} from './vectorMemory/index.js';
import { getVectorOwnerId, shouldIndexSession } from './vectorMemory/scope.js';
import { useTheme } from './theme/ThemeContext.js';
import { generateImage } from './imageGen/index.js';
import { getLocalModelFileInfo } from './localModel/modelManager.js';
import ModelLogsModal from './localModel/ModelLogsModal.js';
import { canUseLocalModel, sendWithModelProvider } from './modelProvider.js';
import { getLocalModelMediaCapabilities } from './localModel/modelState.js';
import { getImageProvider } from './imageGen/providers.js';
import { stop as ttsStop } from './tts/index.js';
import useChatTts from './chat/useChatTts.js';
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
  SYSTEM_ERROR_ID,
  THINKING_PLACEHOLDER,
  USER_ID,
} from './chat/chatConstants.js';
import {
  buildErrorRawText,
  buildGreetingMessage,
  buildInlineImagePrompt,
  buildQuotePayload,
  settlePendingMessage,
} from './chat/chatHelpers.js';
import { createChatStyles } from './chat/chatStyles.js';
import useScrollScrubber from './chat/useScrollScrubber.js';
import useChatSearch from './chat/useChatSearch.js';
import MessageBubble from './chat/MessageBubble.js';
import ErrorBubble from './chat/ErrorBubble.js';
import AnimatedEntry from './chat/AnimatedEntry.js';
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
import {
  isUnsupportedTranscriptionError,
  resolveTranscription,
  transcribeAudio,
} from './transcription.js';
import { createVoiceMessage } from './voiceMessages.js';
export default function ChatScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const scrollRef = useRef(null);
  const errorRawRef = useRef({});
  const lastSavedSnapshotRef = useRef(null);
  const saveFailedRef = useRef(false);
  const saveInFlightSnapshotRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const saveRetryTimerRef = useRef(null);
  const saveRetryAttemptsRef = useRef(0);
  const [saveRetryTick, setSaveRetryTick] = useState(0);
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
   const abortRef = useRef(null);
   const sendLockRef = useRef(null);
   const sourceChangedRef = useRef(false);
   const sendOperationRef = useRef(0);
   const switchOperationRef = useRef(0);
   const openingRequestRef = useRef(0);
   const openingAbortControllerRef = useRef(null);
   const sessionVersionRef = useRef(0);
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
  const [input, setInput] = useState('');
  // 输入框草稿按会话保留。draftTextRef 只记录“用户真实输入”的文本，程序性的
  // setInput('')（切会话/发送后清空）不经过 onInputChange，因此不会污染草稿。
  const draftSessionIdRef = useRef('');
  const draftTextRef = useRef('');
  const draftSaveTimerRef = useRef(null);
  // 上一次处理过的主动消息刷新计数：用于把「主动消息落库刷新」与「切会话」区分开。
  const refreshTickRef = useRef(messageRefreshTick);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const inputSelectionRef = useRef({ start: 0, end: 0 });
  const [inputFocused, setInputFocused] = useState(false);
   const [messages, setMessages] = useState([]);
   const messagesRef = useRef([]);
   messagesRef.current = messages;
   const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const selectedMessageIdSet = useMemo(
    () => new Set(selectedMessageIds),
    [selectedMessageIds]
  );
  const messageSelectionOpen = selectedMessageIds.length > 0;
  const [greetingReady, setGreetingReady] = useState(false);
   const [isSending, setIsSending] = useState(false);
   const [isSwitching, setIsSwitching] = useState(false);
   const [ready, setReady] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
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

  // 立即落定某个会话的草稿：开启保留则写入，关闭则清除（避免旧草稿在新开关下复活）。
  const persistDraftNow = useCallback((sessionId, text) => {
    const id = String(sessionId || '');
    if (!id) return;
    if (chatOptionsRef.current.keepDraft) {
      saveSessionDraft(id, text).catch(() => {});
    } else {
      clearSessionDraft(id).catch(() => {});
    }
  }, []);

  // 用户真实输入走这里：更新界面与草稿 ref，并在开启保留时防抖写盘。
  // 程序性 setInput（切会话清空、发送后清空、回填）不经过本函数，故不会误写。
  const onInputChange = useCallback(text => {
    setInput(text);
    draftTextRef.current = String(text ?? '');
    if (!chatOptionsRef.current.keepDraft) return;
    const id = String(draftSessionIdRef.current || '');
    if (!id) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    const value = draftTextRef.current;
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      if (!chatOptionsRef.current.keepDraft) return;
      saveSessionDraft(id, value).catch(() => {});
    }, 400);
  }, []);
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
   const inlineImageControllerRef = useRef(null);

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

   const closeStickerNamePrompt = useCallback(() => {
     const source = stickerNamePrompt;
     setStickerNamePrompt(null);
     setStickerNameDraft('');
     if (source && source.uri) deleteTemporaryImage(source.uri);
   }, [stickerNamePrompt]);

   const onSwitch = useCallback(id => {
     if (isSwitching) return;
     setSwitcherOpen(false);
     if (id === activeCharacterIdRef.current && !isGroupRef.current) return;
       const previousCharacterId = activeCharacterIdRef.current;
       const previousSessionId = activeSessionIdRef.current;
     const draft = {
       input,
       fullScreenText,
       attachments: [...attachments],
       quoteTarget,
       stickerPanelOpen,
       stickerNamePrompt,
       stickerNameDraft,
     };
     const switchToken = ++switchOperationRef.current;
     setIsSwitching(true);
     invalidateSessionOperations();
     activeCharacterIdRef.current = id;
     setProtectedChatImageUris(draft.attachments
       .filter(item => item && item.kind === 'image')
       .map(item => item.uri));
     attachmentsRef.current = [];
     setQuoteTarget(null);
     setInput('');
     setFullScreenText('');
     setAttachments([]);
     setStickerPanelOpen(false);
     setStickerNamePrompt(null);
     setStickerNameDraft('');
     switchCharacter(id)
       .then(() => (
         switchOperationRef.current === switchToken
           ? ensureCharacterSession(id)
           : null
       ))
       .then(() => {
           if (switchOperationRef.current !== switchToken) return;
           draft.attachments.forEach(item => {
             if (item.kind === 'image') deleteLocalImage(item.uri);
           });
           if (draft.stickerNamePrompt && draft.stickerNamePrompt.uri) {
             deleteTemporaryImage(draft.stickerNamePrompt.uri);
           }
            setProtectedChatImageUris([]);
            setIsSwitching(false);
        })
         .catch(async () => {
           if (switchOperationRef.current !== switchToken) return;

           try {
             await switchCharacter(previousCharacterId);
             if (previousSessionId) await switchSession(previousSessionId);
           } catch (error) {}
          setIsSwitching(false);
          activeCharacterIdRef.current = previousCharacterId;
          activeSessionIdRef.current = previousSessionId;
          sessionVersionRef.current += 1;
          setInput(draft.input);
          setFullScreenText(draft.fullScreenText);
          setAttachments(draft.attachments);
          attachmentsRef.current = draft.attachments;
          setQuoteTarget(draft.quoteTarget);
          setStickerPanelOpen(draft.stickerPanelOpen);
          setStickerNamePrompt(draft.stickerNamePrompt);
          setStickerNameDraft(draft.stickerNameDraft);
          setProtectedChatImageUris(draft.attachments
            .filter(item => item && item.kind === 'image')
            .map(item => item.uri));
          Alert.alert('切换失败', '请检查存储空间或权限。');
        });
   }, [attachments, closeStickerNamePrompt, ensureCharacterSession, fullScreenText, input, invalidateSessionOperations, isSwitching, quoteTarget, stickerNameDraft, stickerNamePrompt, stickerPanelOpen, switchCharacter]);

   const onSwitchGroup = useCallback(id => {
    if (isSwitching) return;
    setSwitcherOpen(false);
     if (id === activeSessionIdRef.current) return;
     const previousSessionId = activeSessionIdRef.current;
     const draft = {
       input,
       fullScreenText,
       attachments: [...attachments],
       quoteTarget,
       stickerPanelOpen,
       stickerNamePrompt,
       stickerNameDraft,
     };
     const switchToken = ++switchOperationRef.current;
     setIsSwitching(true);
     invalidateSessionOperations();
     activeSessionIdRef.current = id;
     setProtectedChatImageUris(draft.attachments
       .filter(item => item && item.kind === 'image')
       .map(item => item.uri));
     attachmentsRef.current = [];
     setQuoteTarget(null);
     setInput('');
     setFullScreenText('');
     setAttachments([]);
     setStickerPanelOpen(false);
     setStickerNamePrompt(null);
     setStickerNameDraft('');
     switchSession(id)
       .then(() => {
           if (switchOperationRef.current !== switchToken) return;
           draft.attachments.forEach(item => {
             if (item.kind === 'image') deleteLocalImage(item.uri);
           });
           if (draft.stickerNamePrompt && draft.stickerNamePrompt.uri) {
             deleteTemporaryImage(draft.stickerNamePrompt.uri);
           }
            setProtectedChatImageUris([]);
            setIsSwitching(false);
        })
         .catch(async () => {
         if (switchOperationRef.current !== switchToken) return;

        try {
          await switchSession(previousSessionId);
        } catch (error) {}
        setIsSwitching(false);
        activeSessionIdRef.current = previousSessionId;
          sessionVersionRef.current += 1;
          setInput(draft.input);
          setFullScreenText(draft.fullScreenText);
          setAttachments(draft.attachments);
          attachmentsRef.current = draft.attachments;
          setQuoteTarget(draft.quoteTarget);
          setStickerPanelOpen(draft.stickerPanelOpen);
          setStickerNamePrompt(draft.stickerNamePrompt);
          setStickerNameDraft(draft.stickerNameDraft);
          setProtectedChatImageUris(draft.attachments
            .filter(item => item && item.kind === 'image')
            .map(item => item.uri));
          Alert.alert('切换失败', '请检查存储空间或权限。');
        });
   }, [attachments, closeStickerNamePrompt, fullScreenText, input, invalidateSessionOperations, isSwitching, quoteTarget, stickerNameDraft, stickerNamePrompt, stickerPanelOpen, switchSession]);

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

  const persistableMessages = useMemo(
    () => (messages || [])
      .filter(item => item && !item.pending)
      .map(item => {
        const hasWaiting = Object.prototype.hasOwnProperty.call(item, 'waitingForResponse');
        const inlineImage = item.inlineImage;
        const inlineImageSettled = inlineImage && inlineImage.status === 'done';
        if (!hasWaiting && (!inlineImage || inlineImageSettled)) return item;
        const next = { ...item };
        delete next.waitingForResponse;
        if (inlineImage && !inlineImageSettled) delete next.inlineImage;
        return next;
      }),
    [messages]
  );
  // 已提交（非 pending）消息：流式期间 pending 消息不参与落盘
  const committedMessages = useMemo(
    () => (messages || []).filter(item => item && !item.pending),
    [messages]
  );
  const committedRef = useRef({ list: [], snapshot: '[]' });
  const persistableSnapshot = useMemo(() => {
    // 只有“已提交消息”确实变化时才做整份 JSON.stringify：流式回复期间每个
    // token 都会更新 messages，但已提交部分没有变（元素仍是同一批对象引用），
    // 因此这里按引用比对即可跳过无意义的全量序列化，同时保留
    // “用户消息一发出就落盘”的原有行为。
    const previous = committedRef.current.list;
    const unchanged = previous.length === committedMessages.length
      && committedMessages.every((item, index) => item === previous[index]);
    if (unchanged) return committedRef.current.snapshot;
    const snapshot = JSON.stringify(persistableMessages);
    committedRef.current = { list: committedMessages, snapshot };
    return snapshot;
  }, [committedMessages, persistableMessages]);
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

  useEffect(() => {
     if (!loaded) return;
      const loadSessionId = String(activeSessionId || '');
      const previousSessionId = String(draftSessionIdRef.current || '');
      const sessionChanged = previousSessionId !== loadSessionId;
      const tickChanged = refreshTickRef.current !== messageRefreshTick;
      // 后台主动消息落库会把 messageRefreshTick 推进，但会话并未切换。这条路径
      // 只把新落库的消息读回来：绝不清空正在输入的草稿、删除已选附件，也不打断
      // 进行中的请求。正在发送/流式时索性不覆盖本地消息，避免丢掉尚未落盘的回复；
      // 此时不消费 tick，等下一次刷新再补。
      if (!sessionChanged && tickChanged && loadSessionId) {
        if (sendLockRef.current || abortRef.current) return undefined;
        refreshTickRef.current = messageRefreshTick;
        let tickCancelled = false;
        getMessagesBySessionStatus(loadSessionId)
          .then(result => {
            if (tickCancelled) return;
            if (!result || result.status !== 'ok') return;
            const refreshed = Array.isArray(result.messages) ? result.messages : [];
            // 同步落盘基准，避免随后把刚读回的消息当成本地改动又写一遍。
            lastSavedSnapshotRef.current = JSON.stringify(refreshed);
            setMessages(refreshed);
          })
          .catch(() => {});
        return () => {
          tickCancelled = true;
        };
      }
      refreshTickRef.current = messageRefreshTick;
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      // 只在会话真的切换时动草稿：会话内其它依赖（如角色资料缺失）触发的重跑
      // 不应重新回填，否则会覆盖用户正在输入的内容。
      if (sessionChanged) {
        if (previousSessionId) {
          // 离开旧会话：按开关立即落定草稿（开启保存、关闭清除），避免旧草稿复活。
          persistDraftNow(previousSessionId, draftTextRef.current);
        }
        draftSessionIdRef.current = loadSessionId;
        draftTextRef.current = '';
      }
      const draftAttachments = attachmentsRef.current;
      draftAttachments.forEach(item => {
        if (item.kind === 'image') deleteLocalImage(item.uri);
      });
      attachmentsRef.current = [];
      setProtectedChatImageUris([]);
      setInput('');
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
      activeCharacterIdRef.current = characterId;
      activeSessionIdRef.current = activeSessionId;
      sessionVersionRef.current += 1;
      openingRequestRef.current += 1;
      if (openingAbortControllerRef.current) {
        openingAbortControllerRef.current.abort();
        openingAbortControllerRef.current = null;
      }
      sendLockRef.current = null;
     let cancelled = false;
     if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setReady(false);
    setIsSending(false);
    errorRawRef.current = {};
    atBottomRef.current = true;
    if (!activeSessionId) {
      lastSavedSnapshotRef.current = '[]';
      setMessages([]);
      setGreetingReady(false);
      setReady(true);
      return () => {
        cancelled = true;
        sessionVersionRef.current += 1;
      };
    }
    const profilePromise = getUserProfile().then(profile => {
      if (cancelled) return;
      userNameRef.current = String(profile.userName || '').trim();
      setUserAvatar(profile.avatarUri || '');
    }).catch(() => {});
    getMessagesBySessionStatus(activeSessionId)
      .then(async result => {
        if (cancelled) return;
        await profilePromise;
        if (cancelled) return;
        // 损坏（读取失败）时不能当成空会话：明确提示记录仍在，且不做后续写盘。
        if (result && result.status === 'corrupt') {
          lastSavedSnapshotRef.current = '[]';
          setMessages([]);
          setGreetingReady(false);
          Alert.alert(
            '聊天记录读取失败',
            '本次没能读出该会话的消息（可能因数据过大）。系统已停止本次自动写回；继续发送会生成新记录，请先保留设备数据后再操作。'
          );
          return;
        }
        const initial = Array.isArray(result && result.messages) ? result.messages : [];
        if (initial.length === 0 && isGroupRef.current) {
          const members = groupCharactersRef.current;
          lastSavedSnapshotRef.current = '[]';
          setMessages([]);
          setGreetingReady(true);
           if (members.length > 0) {
             const openingSessionId = activeSessionId;
             const openingToken = openingRequestRef.current;
             const openingController = new AbortController();
             openingAbortControllerRef.current = openingController;
              (async () => {
               try {
                 const [profile, presets, apiState] = await Promise.all([
                   getUserProfile().catch(() => null),
                   getEnabledGlobalPresetPrompts().catch(() => []),
                   getApiConfigs().catch(() => ({ configs: [], activeId: '' })),
                 ]);
                 const currentConfig = (apiState.configs || []).find(
                   item => item.id === apiState.activeId
                 ) || (apiState.configs || [])[0];
                 const opening = await generateOpening({
                   characters: members,
                   userProfile: profile,
                   globalPresets: presets,
                     expectedConfigId: String(currentConfig && currentConfig.id || ''),
                     expectedConfigFingerprint: currentConfig ? getConfigFingerprint(currentConfig) : '',
                     signal: openingController.signal,
                 });
                  if (cancelled || !opening) return;
                  if (openingRequestRef.current !== openingToken) return;
                  if (activeSessionIdRef.current !== openingSessionId) return;
                setMessages(current => current.length === 0
                  ? [{
                      id: `${Date.now()}-opening`,
                      role: ASSISTANT_ID,
                      text: opening.opening,
                      speakerId: opening.speakerId,
                      speakerName: opening.speakerName,
                      timestamp: Date.now(),
                    }]
                  : current);
               } catch (error) {
               } finally {
                 if (openingAbortControllerRef.current === openingController) {
                   openingAbortControllerRef.current = null;
                 }
               }
             })();
          }
          return;
        }
        // 默认角色（内置助手）的空会话：首次进入自动显示内置教学开场白，
        // 让新手一进来就看到「配 API → 导入角色卡 → 开始聊天」的引导，而不是空白。
        // 仅对内置默认角色、仅当该会话为空、且从未自动展示过时执行一次；
        // 用户自定义开场白的角色、已有消息的会话、以及清空后都不再自动注入。
        if (
          initial.length === 0
          && !isGroupRef.current
          && !sessionOwnerMissing
          && characterId === DEFAULT_CHARACTER.id
          && String(character.firstMes || '').trim()
        ) {
          try {
            const alreadyShown = await hasShownDefaultGreeting();
            if (!cancelled && !alreadyShown && activeSessionIdRef.current === activeSessionId) {
              const greeting = buildGreetingMessage(
                activeSessionId,
                character.firstMes,
                userNameRef.current
              );
              if (greeting) {
                // 不预置 lastSavedSnapshotRef，让常规保存 effect 把这条开场白写盘，
                // 否则重启后（标记已置位、不再自动补）会变成空会话。
                setMessages([greeting]);
                setGreetingReady(true);
                markDefaultGreetingShown().catch(() => {});
                setSessionGreetingSelected(activeSessionId, true).catch(() => {});
                return;
              }
            }
          } catch (error) {
            // 自动开场白失败退回普通空状态，不阻断加载。
          }
        }
        setGreetingReady(
          isGroupRef.current
          || initial.length > 0
          || sessionsRef.current.some(session => (
            session.id === activeSessionId && session.greetingSelected === true
          ))
        );
        lastSavedSnapshotRef.current = JSON.stringify(initial);
        setMessages(initial);
      })
      .catch(() => {
        if (cancelled) return;
        lastSavedSnapshotRef.current = '[]';
        setMessages([]);
        setGreetingReady(false);
        // 读取失败时以前是静默显示空对话，用户很容易误以为记录被清空了。
        // 明确告知：记录还在，只是这次没读出来；且不会覆盖原数据。
        Alert.alert(
          '聊天记录读取失败',
          '本次没能读出该会话的消息（可能因数据过大）。记录本身没有被删除，可稍后重试；继续发送可能覆盖原内容。'
        );
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      sessionVersionRef.current += 1;
    };
  }, [activeSessionId, loaded, sessionOwnerMissing, messageRefreshTick]);

  // 回填输入草稿。独立于会话加载 effect：chatOptions 是异步读出的，冷启动时
  // 往往晚于会话就绪；若挤在加载 effect 里，keepDraft 还没读出来就会回填失败。
  useEffect(() => {
    if (!loaded || !activeSessionId) return undefined;
    if (!chatOptions.keepDraft) {
      draftTextRef.current = '';
      return undefined;
    }
    const targetSessionId = String(activeSessionId);
    let cancelled = false;
    getSessionDraft(targetSessionId)
      .then(text => {
        if (cancelled) return;
        if (activeSessionIdRef.current !== targetSessionId) return;
        // 用户已在异步回填前开始输入时，不覆盖他正在写的内容。
        if (draftTextRef.current) return;
        const value = String(text || '');
        draftTextRef.current = value;
        if (value) setInput(value);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeSessionId, loaded, chatOptions.keepDraft]);

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

  useEffect(() => {
    if (!sessionOwnerMissing) return;
    Alert.alert('角色资料缺失', '这段历史对话仍在，可以先查看；恢复角色资料后才能继续发送。');
  }, [sessionOwnerMissing]);

  useEffect(() => {
    if (!ready) return;
    if (!activeSessionId) return;
    if (persistableSnapshot === lastSavedSnapshotRef.current) return;
    if (persistableSnapshot === saveInFlightSnapshotRef.current) return;
    saveInFlightSnapshotRef.current = persistableSnapshot;
    const snapshotBeingSaved = persistableSnapshot;
    const indexController = typeof AbortController === 'function' ? new AbortController() : null;
    const scheduleSaveRetry = () => {
      if (saveRetryTimerRef.current) clearTimeout(saveRetryTimerRef.current);
      if (saveRetryAttemptsRef.current >= 5) return;
      saveRetryAttemptsRef.current += 1;
      const delay = Math.min(3000 * (2 ** (saveRetryAttemptsRef.current - 1)), 60000);
      saveRetryTimerRef.current = setTimeout(() => setSaveRetryTick(tick => tick + 1), delay);
    };
    const messagesToIndex = persistableMessages;
    // 会话条目若已从存储里缺失（历史版本的 startNewSession 会误删），
    // 把归属角色一并传下去，让本次写盘把会话行补回来；群聊没有单一归属角色，跳过。
     const ownerRow = sessionsRef.current.find(item => item.id === activeSessionId);
     const indexableSession = shouldIndexSession(ownerRow);
     const indexedCharacterId = getVectorOwnerId(ownerRow, character.id);

    const recoverOwnerId = isGroupRef.current
      ? ''
      : String((ownerRow && ownerRow.characterId) || character.id || '');
    const indexVersion = sessionVersionRef.current;
    const protectedImageUris = [
      ...attachmentsRef.current
        .filter(item => item && item.kind === 'image')
        .map(item => item.uri),
      ...pendingAttachmentUrisRef.current,
    ];
    // 写盘串行化：同会话连续快照若并行写，旧快照可能在新快照之后落盘，
    // 让持久化结果回退。用 promise 队列保证顺序，后到的快照总是最后写入。
    const savePromise = saveQueueRef.current
      .catch(() => {})
      .then(() => saveMessagesBySession(
        activeSessionId,
        persistableMessages,
        recoverOwnerId,
        protectedImageUris
      ));
    saveQueueRef.current = savePromise;
    savePromise
      .then(savedMessages => {
        if (saveInFlightSnapshotRef.current === snapshotBeingSaved) {
          saveInFlightSnapshotRef.current = null;
        }
        saveRetryAttemptsRef.current = 0;
        if (saveRetryTimerRef.current) {
          clearTimeout(saveRetryTimerRef.current);
          saveRetryTimerRef.current = null;
        }
        lastSavedSnapshotRef.current = snapshotBeingSaved;
        saveFailedRef.current = false;
        if (
          !Array.isArray(savedMessages)
          || savedMessages.length === 0
          || activeSessionIdRef.current !== activeSessionId
           || !indexableSession
           || !indexedCharacterId

        ) return;
        getVectorMemoryConfig()
          .then(config => {
            if (
              activeSessionIdRef.current !== activeSessionId
              || sessionVersionRef.current !== indexVersion
               || !indexableSession
             ) return null;

            return updateVectorIndex(indexedCharacterId, current => {
              if (
                activeSessionIdRef.current !== activeSessionId
                || sessionVersionRef.current !== indexVersion
                 || !indexableSession
               ) return undefined;

              return indexMessages({
                messages: messagesToIndex,
                config,
                existing: current,
                sessionId: activeSessionId,
                signal: indexController ? indexController.signal : null,
              });
            });
          })
          .catch(error => {
            if (__DEV__) console.warn('[vector] indexing failed', error);
          });
      }).catch(() => {
        if (saveInFlightSnapshotRef.current === snapshotBeingSaved) {
          saveInFlightSnapshotRef.current = null;
        }
        scheduleSaveRetry();
        if (!saveFailedRef.current) {
          saveFailedRef.current = true;
          Alert.alert('聊天记录保存失败', '请检查存储空间或权限。');
        }
      });
    return () => {
      // 切会话/卸载或下一次保存到来时，终止仍在进行的向量嵌入，避免无谓网络与写入。
      if (indexController) indexController.abort();
    };
  }, [activeSessionId, persistableSnapshot, ready, character.id, saveRetryTick]);

  useEffect(() => () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current);
      saveRetryTimerRef.current = null;
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

  const confirmGreeting = useCallback(async result => {
     const flow = greetingPicker;
     if (!flow) return false;
     const characterId = activeCharacterIdRef.current;
     const sessionId = activeSessionIdRef.current;
     const transitionToken = flow.purpose === 'new' ? ++switchOperationRef.current : 0;
     const transitionVersion = sessionVersionRef.current;
     if (flow.purpose === 'new') setIsSwitching(true);
     try {
      await updateCharacter({
        id: characterId,
        firstMes: result.firstMes,
        alternateGreetings: result.alternateGreetings,
       });
       if (activeCharacterIdRef.current !== characterId) return false;
       if (
         flow.purpose === 'new'
         && (
           switchOperationRef.current !== transitionToken
           || sessionVersionRef.current !== transitionVersion
            || activeSessionIdRef.current !== sessionId
          )
        ) return false;
       if (flow.purpose === 'new') {
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setIsSending(false);
         const openingTemplate = String(result.firstMes || '');
         const openingText = openingTemplate.replace(/\{\{user\}\}/g, () => userNameRef.current || '用户');
         const created = await startNewSession(characterId, {
           text: openingText,
           template: openingTemplate,
         });
         if (
           switchOperationRef.current !== transitionToken
           || activeCharacterIdRef.current !== characterId
           || (
             activeSessionIdRef.current !== sessionId
              && activeSessionIdRef.current !== created.id
            )
          ) return false;
         activeSessionIdRef.current = created.id;
         await refreshSessions();
         if (
           switchOperationRef.current !== transitionToken
           || activeCharacterIdRef.current !== characterId
            || activeSessionIdRef.current !== created.id
          ) return false;
         errorRawRef.current = {};
        sessionVersionRef.current += 1;
        setMessages([]);
        setAttachments([]);
        setQuoteTarget(null);
        setSearchOpen(false);
        setSearchQuery('');
        setActiveMatchIndex(0);
        setFocusedMessageId('');
        setSelectionText('');
         setGreetingReady(true);
         setGreetingPicker(null);
         return true;
      }
        if (activeSessionIdRef.current !== sessionId) return false;
       await setSessionGreetingSelected(sessionId, true);
       await refreshSessions();
       if (
         activeCharacterIdRef.current !== characterId
          || activeSessionIdRef.current !== sessionId
        ) return false;
       const nextGreeting = buildGreetingMessage(sessionId, result.firstMes, userNameRef.current);
      const hasGreeting = messages.some(item => isGreetingMessage(item, sessionId));
      if (nextGreeting) {
        setMessages(current => hasGreeting
          ? current.map(item => (
            isGreetingMessage(item, sessionId)
              ? { ...item, ...nextGreeting, id: item.id, timestamp: item.timestamp }
              : item
          ))
          : [nextGreeting, ...current]);
      } else {
        setMessages(current => current.filter(item => !isGreetingMessage(item, sessionId)));
      }
       setGreetingReady(true);
       setGreetingPicker(null);
       return true;
      } catch (error) {
       if (
         flow.purpose === 'new'
         && (
           switchOperationRef.current !== transitionToken
           || activeCharacterIdRef.current !== characterId
           || (
             activeSessionIdRef.current !== sessionId
              && activeSessionIdRef.current !== ''
            )
          )
        ) return false;
         Alert.alert('开场白保存失败', '请稍后重试。');
         return false;
       } finally {
        if (
          flow.purpose === 'new'
          && switchOperationRef.current === transitionToken
        ) setIsSwitching(false);
      }
   }, [greetingPicker, messages, refreshSessions, updateCharacter]);

  const onNewChat = useCallback(() => {
    if (isSending || isSwitching || !ready || sessionTransitionPending || abortRef.current) return;
    if (sessionOwnerMissing) {
      Alert.alert('角色资料缺失', '这段历史对话可以继续查看，恢复角色资料后才能新建或发送消息。');
      return;
    }
    if (isGroupRef.current && groupCharactersRef.current.length > 0) {
      Alert.alert('新建对话', '将为当前群聊开启一段新对话，旧对话保留在「记忆」中。', [
        { text: '取消', style: 'cancel' },
        {
          text: '新建',
          onPress: async () => {
            const transitionToken = ++switchOperationRef.current;
            const previousCharacterId = activeCharacterIdRef.current;
            const previousSessionId = activeSessionIdRef.current;
            setIsSwitching(true);
            if (abortRef.current) {
              abortRef.current.abort();
              abortRef.current = null;
            }
            setIsSending(false);
             try {
               const current = sessionsRef.current.find(item => item.id === previousSessionId);
               const created = await createGroupSession(groupCharactersRef.current, (current && current.name) || '群聊');
               if (
                 switchOperationRef.current !== transitionToken
                 || activeCharacterIdRef.current !== previousCharacterId
                 || (
                   activeSessionIdRef.current !== previousSessionId
                   && activeSessionIdRef.current !== created.id
                 )
               ) return;
               activeSessionIdRef.current = created.id;
               await refreshSessions();
               if (
                 switchOperationRef.current !== transitionToken
                 || activeCharacterIdRef.current !== previousCharacterId
                 || activeSessionIdRef.current !== created.id
               ) return;
               errorRawRef.current = {};
              sessionVersionRef.current += 1;
              setMessages([]);
              setAttachments([]);
              setQuoteTarget(null);
              setSearchOpen(false);
              setSearchQuery('');
              setActiveMatchIndex(0);
              setFocusedMessageId('');
              setSelectionText('');
             } catch (error) {
               if (
                 switchOperationRef.current !== transitionToken
                 || activeCharacterIdRef.current !== previousCharacterId
                 || (
                   activeSessionIdRef.current !== previousSessionId
                   && activeSessionIdRef.current !== ''
                 )
               ) return;
                Alert.alert('新建对话失败', '请稍后重试。');
              } finally {
                if (switchOperationRef.current === transitionToken) setIsSwitching(false);
              }
          },
        },
      ]);
      return;
    }
    openGreetingPicker('new');
  }, [isSending, isSwitching, openGreetingPicker, ready, refreshSessions, sessionOwnerMissing, sessionTransitionPending]);

  const scrollToMessage = useCallback(id => {
    const attempt = tries => {
      const offset = messageOffsetsRef.current[id];
      if (typeof offset === 'number') {
        scrollRef.current?.scrollTo?.({ y: Math.max(0, offset - 80), animated: true });
      } else if (tries > 0) {
        setTimeout(() => attempt(tries - 1), 120);
      }
    };
    setTimeout(() => attempt(6), 60);
  }, []);

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

  const requestReply = useCallback(async ({ historyMessages, userText, baseMessages, images, imageMessages, quote, expectedConfigId, expectedConfigFingerprint, sessionGuard, restoreOnFailure = false, voiceAudio = null }) => {
     if (sessionGuard && !isSessionGuardCurrent(sessionGuard)) return false;
     if (!ready || (abortRef.current && abortRef.current.signal.aborted)) return false;
    const sendCharacterId = activeCharacterIdRef.current;
    const sendSessionId = activeSessionIdRef.current;
    const sendSessionVersion = sessionVersionRef.current;
    const senderSnapshot = {
      id: sendCharacterId,
      sessionId: sendSessionId,
      name: String(character.name || '').trim(),
      avatarUri: String(character.avatarUri || ''),
    };
    const isCurrentSession = () =>
      sessionVersionRef.current === sendSessionVersion
      && !isStaleReply(activeCharacterIdRef.current, sendCharacterId)
      && activeSessionIdRef.current === sendSessionId;
     const controller = sendLockRef.current?.controller || new AbortController();
     abortRef.current = controller;
     if (controller.signal.aborted) return false;
     const pendingAssistantMessage = {
      id: `${Date.now()}-assistant`,
      role: ASSISTANT_ID,
      text: THINKING_PLACEHOLDER,
      reasoning: '',
      pending: true,
      waitingForResponse: true,
      timestamp: Date.now(),
    };

     setMessages([...baseMessages, pendingAssistantMessage]);
     setIsSending(true);
     atBottomRef.current = true;
     scrollToBottom();

    try {
       const [userProfile, globalPresets, enabledPlugins] = await Promise.all([
         getUserProfile(),
         getEnabledGlobalPresetPrompts(),
         getEnabledPlugins(),
       ]);
       if (controller.signal.aborted) {
         setMessages(current => (
           isCurrentSession() ? settlePendingMessage(current, pendingAssistantMessage.id) : current
         ));
         return;
       }
       const pluginContext = await runPlugins({
        userText,
         plugins: enabledPlugins,
         sessionId: sendSessionId,
         signal: controller.signal,
         onError: error => {
          if (__DEV__) console.warn('[webSearch] failed', maskSecrets(error?.message || String(error)));
          // registry 内部已按会话去重，这里不会每条消息都弹
          Alert.alert('联网搜索失败', maskSecrets((error && error.message) || '请检查搜索服务配置。'));
        },
      });
      const currentSession = sessionsRef.current.find(
        session => session.id === sendSessionId
      );
      const boundary = currentSession && currentSession.summarizedUpTo;
      const boundaryIndex = boundary
        ? historyMessages.findIndex(item => item.id === boundary)
        : -1;
      const trimmedHistory = boundaryIndex >= 0
        ? historyMessages.slice(boundaryIndex + 1)
        : historyMessages;
      // 已经作为原文发送的历史（boundary 之后）不再由向量重复召回；被摘要裁剪掉
      // 的更早区间和其它会话才交给向量，避免同一内容既当原文又当“相关记忆”。
      const sentIds = new Set(
        trimmedHistory.map(item => String((item && item.id) || ''))
      );
      let vectorConfig = null;
      let vectorIndex = [];
      try {
        const config = await getVectorMemoryConfig();
        const ownerId = getVectorOwnerId(currentSession, character.id);
        const index = ownerId ? await getVectorIndex(ownerId) : [];
        if (index.length > 0 && String(userText || '').trim()) {
          vectorConfig = config;
          vectorIndex = index;
        }
      } catch (error) {
        vectorConfig = null;
      }
      let vectorHits = [];
      try {
        if (vectorConfig) {
          const hits = await retrieve({
            config: vectorConfig,
            index: vectorIndex,
            query: userText,
            topK: vectorConfig.topK,
            signal: controller.signal,
          });
          vectorHits = hits.filter(item => (
            !sentIds.has(String((item && item.messageId) || ''))
          ));
        }
      } catch (error) {
        vectorHits = [];
      }
      // 记忆上下文总预算：仅在向量确有命中时才分走份额，否则全部让给摘要，
      // 避免“有索引但无命中”时预算被空占。
      const memoryBudget = planMemoryBudget({ hasVectorContext: vectorHits.length > 0 });
      const memorySnippets = vectorHits.length > 0
        ? buildMemoryContext(vectorHits, { maxTotalChars: memoryBudget.vectorMaxChars })
        : '';
      let summaryText = '';
      try {
        const sessionCharacterId = String(
          (currentSession && currentSession.characterId) || character.id || ''
        );
        const characterExists = (Array.isArray(characters) ? characters : [])
          .some(item => item.id === sessionCharacterId);
        // 读取沿用原作用域判定：单会话角色继续带上已有世界书记忆（不做迁移/丢弃），
        // 多会话角色只读本会话。写入侧的降级见 runSummarize，两者解耦。
        const scoped = !characterExists
          || isSessionScopedMemory(
            sessionsRef.current,
            sessionCharacterId,
            currentSession,
            historyMessages
          );
        const sessionSummaries = await getSessionSummaries(sendSessionId);
        summaryText = buildMemorySummaryText(
          character,
          sessionSummaries,
          scoped,
          memoryBudget.summaryMaxChars
        );
      } catch (error) {
        summaryText = '';
      }
       const requestMessages = buildRequestMessages({
         character,
         historyMessages: trimmedHistory,
         userText,
         userProfile,
         globalPresets,
         imageMessages,
         summaryText,
         memorySnippets,
         pluginContext,
         images,
         quote,
         // 仅当「表情包使用」预设开启且 {{stickers}} 占位符出现时才会被注入。
         stickerNames: resolveStickerNames(stickersRef.current),
         // 时间感知开启时附上当前时间（每次请求现算，保证准确）。
         currentTimeText: buildTimeAwareText(chatOptionsRef.current.timeAware),
         // 语音兜底（需求 6.2）：转写失败且来源支持音频时按 input_audio 直发。
         voiceAudio,
       });
       if (!isCurrentSession()) return;

        const localSettings = await getLocalModelSettings().catch(() => null);
        const localItem = await getActiveLocalModel().catch(() => null);
        const localFileInfo = (localItem || localSettings)
          ? await getLocalModelFileInfo(localItem || localSettings).catch(() => null)
          : null;
        // 本地多模态默认关：仅当用户开启且该模型有能力时，才把图片/音频发给本地推理。
        const localReady = canUseLocalModel(localSettings, localFileInfo, localItem);
        const localMessages = localReady
          ? filterRequestMedia(requestMessages, {
              allowVision: Boolean(localSettings && localSettings.enableMediaInput && localItem && localItem.hasVision),
              allowAudio: Boolean(localSettings && localSettings.enableMediaInput && localItem && localItem.hasAudio),
            })
          : requestMessages;
        // 本地模型可以拥有独立的 mmproj 能力；本地失败回退在线时，必须按在线配置
        // 单独裁剪媒体，避免把图片/音频发给不支持多模态的在线端点。
        let onlineMedia = { allowVision: false, allowAudio: false };
        try {
          const { configs, activeId } = await getApiConfigs();
          const onlineConfig = configs.find(item => item.id === expectedConfigId)
            || configs.find(item => item.id === activeId)
            || configs[0];
          onlineMedia = {
            allowVision: Boolean(onlineConfig && onlineConfig.supportsVision),
            allowAudio: Boolean(onlineConfig && onlineConfig.supportsAudio),
          };
        } catch (error) {}
        const onlineMessages = filterRequestMedia(requestMessages, onlineMedia);
        const onlineSend = () => sendChatMessage(onlineMessages, {
              expectedConfigId,
              expectedConfigFingerprint,
              signal: controller.signal,
           stream: chatOptions.stream,
           onChunk: fullText => {
             if (!isCurrentSession() || controller.signal.aborted) return;
             setMessages(current => {
               if (!isCurrentSession()) return current;
               return current.map(item =>
                 item.id === pendingAssistantMessage.id && item.pending
                   ? { ...item, text: fullText, waitingForResponse: false }
                   : item
               );
             });
           },
           onReasoning: fullReasoning => {
             if (!isCurrentSession() || controller.signal.aborted) return;
             setMessages(current => {
               if (!isCurrentSession()) return current;
               return current.map(item =>
                 item.id === pendingAssistantMessage.id
                   ? { ...item, reasoning: fullReasoning }
                   : item
               );
             });
            }
        });
        const reply = await sendWithModelProvider({
          messages: localMessages,
          localSettings,
          localItem,
          localFileInfo,
          signal: controller.signal,
          onToken: fullText => {
            if (!isCurrentSession() || controller.signal.aborted) return;
            setMessages(current => current.map(item => (
              item.id === pendingAssistantMessage.id && item.pending
                ? { ...item, text: fullText, waitingForResponse: false }
                : item
            )));
          },
          onlineSend,
        });

       if (controller.signal.aborted) {
         setMessages(current => (
           isCurrentSession()
             ? settlePendingMessage(current, pendingAssistantMessage.id)
             : current
         ));
         return;
       }
       // 解析表情包指令：回复可能被拆成「文字消息 + 若干表情包消息」。
       const replyParts = buildAssistantReply(reply);
       const replyText = replyParts.find(item => item.role === ASSISTANT_ID && !item.kind)?.text
         || '';
       setMessages(current => {
        if (!isCurrentSession()) return current;
        const next = [];
        current.forEach(item => {
          if (item.id === pendingAssistantMessage.id) {
            if (replyParts.length === 0) {
              next.push({ ...item, text: '没有收到回复。', pending: false, waitingForResponse: false });
            } else {
              next.push(...replyParts.map(part => ({ ...part, pending: false, waitingForResponse: false })));
            }
          } else {
            next.push(item);
          }
        });
        return next;
      });
      if (isCurrentSession()) {
        maybeAutoSummarize([
          ...baseMessages,
          ...(replyParts.length === 0
            ? [{ ...pendingAssistantMessage, text: '没有收到回复。', pending: false, waitingForResponse: false }]
            : replyParts.map(part => ({ ...part, pending: false, waitingForResponse: false }))),
        ]);
        if (inlineImageEnabledRef.current) {
          // 配图要挂到替换后的文字消息上：pending 占位符已被 replyParts 替换，其 id 已变，
          // 继续用 pendingAssistantMessage.id 会永远匹配不到（图静默不出现）。
          const inlineTarget = replyParts.find(item => item.role === ASSISTANT_ID && !item.kind);
          if (inlineTarget && inlineTarget.id) {
            generateInlineImageRef.current?.(inlineTarget.id, replyText);
          }
        }
        autoBroadcastMessage(replyText);
        synthesizeVoiceForReply(replyParts, replyText);
        recordTurnRef.current?.(userText, replyText, senderSnapshot);
      }
     } catch (error) {
       if (isConfigChangedError(error)) {
         sourceChangedRef.current = true;
         setMessages(current => (
           isCurrentSession()
             ? current.filter(item => item.id !== pendingAssistantMessage.id)
             : current
         ));
         return false;
       }
       if (isCanceledError(error)) {
        // 停止：已有内容（含只生成了思考）就保留并落盘，只有占位符才整条移除
         setMessages(current => (
           isCurrentSession()
             ? settlePendingMessage(current, pendingAssistantMessage.id)
             : current
         ));
         return false;
       }
       const rawText = buildErrorRawText(error);
      const errorMessage = {
        id: `${pendingAssistantMessage.id}-error`,
        role: SYSTEM_ERROR_ID,
        text: '请求失败，点击查看详情',
        detail: maskSecrets(rawText),
        timestamp: Date.now(),
      };
      if (isCurrentSession()) {
        errorRawRef.current[errorMessage.id] = rawText;
      }
      setMessages(current => {
        if (!isCurrentSession()) return current;
        const settled = settlePendingMessage(current, pendingAssistantMessage.id);
        const keptPartial = settled.some(item => item && item.id === pendingAssistantMessage.id);
        if (keptPartial) return settled.concat(errorMessage);
        return current.map(item => (
          item.id === pendingAssistantMessage.id ? errorMessage : item
        ));
       });
       if (restoreOnFailure) return false;
     } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (isCurrentSession()) {
          setIsSending(false);
          autoScrollToBottom();
        }
      }
    }
  }, [autoScrollToBottom, character, characters, chatOptions.stream, isSessionGuardCurrent, maybeAutoSummarize, ready, scrollToBottom]);

  const requestGroupReply = useCallback(async ({ historyMessages, userText, baseMessages, imageMessages, quote, expectedConfigId, expectedConfigFingerprint, sessionGuard }) => {
     if (sessionGuard && !isSessionGuardCurrent(sessionGuard)) return false;
     if (!ready || (abortRef.current && abortRef.current.signal.aborted)) return false;
    const members = groupCharactersRef.current;
    if (members.length === 0) {
      // 输入框在 onSend 里已清空，这里必须给个提示，不能让用户以为发出去又什么都没发生。
      Alert.alert('无法发送', '这个群聊没有可用的角色（成员可能已被删除）。');
      return false;
    }
    const sendSessionId = activeSessionIdRef.current;
    const sendSessionVersion = sessionVersionRef.current;
    const sendCharacterId = activeCharacterIdRef.current;
    const isCurrent = () =>
      sessionVersionRef.current === sendSessionVersion
      && activeSessionIdRef.current === sendSessionId
      && !isStaleReply(activeCharacterIdRef.current, sendCharacterId);

     const controller = sendLockRef.current?.controller || new AbortController();
     abortRef.current = controller;
     if (controller.signal.aborted) return false;
     setIsSending(true);
     atBottomRef.current = true;
     setMessages(baseMessages);
     scrollToBottom();

    try {
const [userProfile, globalPresets, enabledPlugins] = await Promise.all([
          getUserProfile(),
          getEnabledGlobalPresetPrompts(),
          getEnabledPlugins(),
        ]);
if (!isCurrent() || controller.signal.aborted) return false;
       const pluginContext = await runPlugins({
         userText,
         plugins: enabledPlugins,
         sessionId: sendSessionId,
         signal: controller.signal,
         onError: error => {
           if (__DEV__) console.warn('[webSearch] failed', maskSecrets(error?.message || String(error)));
           Alert.alert('联网搜索失败', maskSecrets((error && error.message) || '请检查搜索服务配置。'));
         },
       });
       if (!isCurrent() || controller.signal.aborted) return false;
       let summaryText = '';
       try {
         const summaries = await getSessionSummaries(sendSessionId);
         summaryText = buildMemorySummaryText({}, summaries, true);
       } catch (error) {
         summaryText = '';
       }
       if (!isCurrent() || controller.signal.aborted) return false;
       const groupSessionId = String(activeSessionRef.current?.id || '');
      const cachedProfiles = memberProfilesRef.current.sessionId === groupSessionId
        ? memberProfilesRef.current.profiles
        : (activeSessionRef.current?.memberProfiles || {});
      let memberProfiles = cachedProfiles;
      try {
         const ensured = await ensureMemberProfiles({
           characters: members,
            profiles: cachedProfiles,
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
          });
        const added = Object.keys(ensured).some(key => !cachedProfiles[key]);
        if (!isCurrent()) return false;
        memberProfiles = ensured;
        memberProfilesRef.current = { sessionId: groupSessionId, profiles: ensured };
         if (added && groupSessionId) {
           await updateSessionMemberProfiles(groupSessionId, ensured);
         }
       } catch (error) {
         if (isConfigChangedError(error)) throw error;
       }
       if (!isCurrent()) return false;
       const everyone = hasEveryoneMention(userText);
      const mentions = parseMentions(userText, members);
      const mediaPrompt = (Array.isArray(imageMessages) ? imageMessages : [])
        .map(getMessagePromptText)
        .filter(Boolean)
        .join('\n');
      const schedulerText = [userText, mediaPrompt].filter(Boolean).join('\n');
      const currentTurnIds = new Set(
        (Array.isArray(baseMessages) ? baseMessages.slice(historyMessages.length) : [])
          .map(item => item && item.id)
          .filter(Boolean)
      );
      let working = baseMessages;

      const runTurnSpeakers = async () => {
        const speakerIds = await selectSpeakers({
          characters: members,
          history: historyMessages,
          userText: schedulerText,
            expectedConfigId,
            expectedConfigFingerprint,
            mentions,
           everyone,
           signal: controller.signal,
         });
         for (const speakerId of speakerIds) {
           if (!isCurrent() || controller.signal.aborted) return false;
          const speaker = members.find(item => item.id === speakerId);
          if (!speaker) continue;
          const pendingMessage = {
            id: `${Date.now()}-${speakerId}-assistant`,
            role: ASSISTANT_ID,
            text: THINKING_PLACEHOLDER,
            pending: true,
            waitingForResponse: true,
            speakerId,
            speakerName: speaker.name,
            timestamp: Date.now(),
          };
          const roundHistory = working.filter(item => (
            item
            && !item.pending
            && (item.role === USER_ID || item.role === ASSISTANT_ID)
            && !currentTurnIds.has(item.id)
          ));
           working = [...working, pendingMessage];
           if (!isCurrent()) return false;
          setMessages(working);
          scrollToBottom();
          try {
            const requestMessages = buildGroupRequest({
              speaker,
              characters: members,
              historyMessages: roundHistory,
              userText,
              userProfile,
              globalPresets,
               quote,
               summaryText,
               pluginContext,
               profiles: memberProfiles,
               imageMessages,
            });
            const reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
              stream: chatOptions.stream,
            });
             if (!isCurrent()) return false;
             working = working.map(item => (
              item.id === pendingMessage.id
                ? { ...item, text: reply || '没有收到回复。', pending: false, waitingForResponse: false }
                : item
            ));
            setMessages(working);
        } catch (error) {
          if (isConfigChangedError(error)) throw error;
          if (isCanceledError(error)) {
            // 停止：结算占位气泡，避免留下永远“正在思考”的僵尸消息
            setMessages(current => (
              isCurrent() ? settlePendingMessage(current, pendingMessage.id) : current
             ));
             return false;
           }
           if (!isCurrent()) return false;
             working = working.map(item => (
              item.id === pendingMessage.id
                ? {
                  ...item,
                  text: `${speaker.name} 本次回复失败`,
                  pending: false,
                  waitingForResponse: false,
                }
                : item
            ));
             setMessages(working);
           }
         }
         return true;
       };

      const runEnsemble = async () => {
        const historyForPrompt = working.filter(item => (
          item
          && !item.pending
          && (item.role === USER_ID || item.role === ASSISTANT_ID)
          && !currentTurnIds.has(item.id)
        ));
        const requestMessages = buildEnsemblePrompt({
          characters: members,
          historyMessages: historyForPrompt,
          userText,
           userProfile,
           globalPresets,
           quote,
           summaryText,
           pluginContext,
           profiles: memberProfiles,
          mentions,
          everyone,
          imageMessages,
        });
        if (requestMessages.length === 0) return false;
        if (!isCurrent()) return false;
        const groupName = String(activeSessionRef.current?.name || '').trim()
          || members.map(item => String(item.name || '').trim()).filter(Boolean).join('、')
          || '群聊';
        const pendingMessage = {
          id: `${Date.now()}-ensemble-assistant`,
          role: ASSISTANT_ID,
          text: THINKING_PLACEHOLDER,
          pending: true,
          waitingForResponse: true,
          speakerName: groupName,
          timestamp: Date.now(),
        };
        working = [...working, pendingMessage];
        if (!isCurrent()) return false;
        setMessages(working);
        scrollToBottom();
        let reply = '';
        try {
           reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
            stream: chatOptions.stream,
            onChunk: fullText => {
              if (!isCurrent() || controller.signal.aborted) return;
              setMessages(current => current.map(item => (
                item.id === pendingMessage.id
                  ? { ...item, text: fullText, waitingForResponse: false }
                  : item
              )));
            },
          });
         } catch (error) {
           if (isConfigChangedError(error)) throw error;
           if (isCanceledError(error)) {
             // 停止：合议模式的流式增量只写进了 state（局部变量 working 里仍是占位符），
             // 所以必须按当前 state 结算，否则已生成的部分会被整条丢掉
             setMessages(current => (
               isCurrent() ? settlePendingMessage(current, pendingMessage.id) : current
             ));
             throw error;
           }
           working = working.filter(item => item.id !== pendingMessage.id);
          if (isCurrent()) setMessages(working);
          return false;
        }
        if (!isCurrent()) return false;
        const segments = mergeAdjacentSegments(parseEnsembleReply(reply, members));
        if (segments.length === 0) {
          // 回退：移除临时消息后交给逐角色模式
          working = working.filter(item => item.id !== pendingMessage.id);
          if (isCurrent()) setMessages(working);
          return false;
        }
        working = working.filter(item => item.id !== pendingMessage.id);
        segments.forEach((segment, index) => {
          working = [...working, {
            id: `${Date.now()}-ensemble-${index}-assistant`,
            role: ASSISTANT_ID,
            text: segment.text,
            speakerId: segment.speakerId || undefined,
            speakerName: segment.speakerName || '',
          }];
        });
        if (!isCurrent()) return false;
        setMessages(working);
        scrollToBottom();
        return true;
      };

      const groupMode = activeSessionRef.current?.groupMode || ENSEMBLE_MODE;
      let handled = false;
      if (groupMode !== 'turn') {
        try {
          handled = await runEnsemble();
         } catch (error) {
           if (isConfigChangedError(error)) throw error;
           if (isCanceledError(error)) return false;
           handled = false;
         }
      }
        if (!handled) {
          const turnHandled = await runTurnSpeakers();
          if (turnHandled === false) return false;
        }
        return true;
      } catch (error) {
       if (isConfigChangedError(error)) {
         sourceChangedRef.current = true;
         if (isCurrent()) setMessages(current => current.filter(item => !item.pending));
         return false;
       }
       if (isCanceledError(error)) return false;
        if (isCurrent()) {
          Alert.alert('群聊回复失败', '请稍后重试。');
        }
        return false;
      } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (isCurrent()) {
          setIsSending(false);
          autoScrollToBottom();
        }
      }
    }
  }, [autoScrollToBottom, chatOptions.stream, isSessionGuardCurrent, ready, scrollToBottom]);

  const performSendMessage = useCallback(async (rawText, extraAttachments = [], suppliedGuard = null, voice = null) => {
    const sessionGuard = suppliedGuard || captureSessionGuard();
    const sendController = sendLockRef.current?.controller || null;
    const isCanceled = () => !!(
      (sendController && sendController.signal.aborted)
      || (abortRef.current && abortRef.current.signal.aborted)
    );
    const text = String(rawText || '').trim();
    const baseAttachments = Array.isArray(attachments) ? attachments : [];
    const allAttachments = [...baseAttachments, ...(Array.isArray(extraAttachments) ? extraAttachments : [])];
    const imageAttachments = allAttachments.filter(item => (
      item && (item.kind === 'image' || item.kind === STICKER_MESSAGE_KIND)
    ));
    const textAttachments = allAttachments.filter(item => item && item.kind === 'text');
    if (imageAttachments.length > MAX_IMAGE_ATTACHMENTS) {
      Alert.alert('图片过多', `一次最多发送 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
      return false;
    }
    if (!isSessionGuardCurrent(sessionGuard)
       || messageSelectionOpen
       || isSwitching
       || sessionTransitionPending
       || (!text && imageAttachments.length === 0 && textAttachments.length === 0 && !voice)
      || !sendLockRef.current
       || !ready
       || (abortRef.current && abortRef.current.signal.aborted)) return false;
     if (!isGroupRef.current && !greetingReady) return false;
     if (isGroupRef.current && groupCharactersRef.current.length === 0) {
       Alert.alert('无法发送', '这个群聊没有可用的角色（成员可能已被删除）。');
       return false;
     }
     if (isGroupRef.current) openingRequestRef.current += 1;
     if (sessionOwnerMissing) {
      Alert.alert('角色资料缺失', '这段历史对话可以查看，恢复角色资料后才能发送消息。');
      return false;
    }
      let visionEnabled = false;
      let audioInputEnabled = false;
     let expectedConfigId = '';
     let expectedConfigFingerprint = '';
    try {
       const { configs, activeId } = await getApiConfigs();
       if (isCanceled() || !isSessionGuardCurrent(sessionGuard)) return false;
      const current = configs.find(item => item.id === activeId) || configs[0];
       expectedConfigId = String(current?.id || '');
       expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
        visionEnabled = !!(current && current.supportsVision);
        audioInputEnabled = !!(current && current.supportsAudio);
      } catch (error) {}
      // 在线配置与本地活动模型可能是两套能力声明：本地模型带 mmproj 且开启多模态时，
      // 附件校验应使用本地能力，不能被在线配置的 supportsVision/supportsAudio 提前拦截。
      const localSettingsForMedia = await getLocalModelSettings().catch(() => null);
      const localItemForMedia = await getActiveLocalModel().catch(() => null);
      const localMedia = getLocalModelMediaCapabilities(localSettingsForMedia, localItemForMedia);
      visionEnabled = visionEnabled || localMedia.vision;
      audioInputEnabled = audioInputEnabled || localMedia.audio;
     let sizedImages = [];
     try {
       sizedImages = await Promise.all(imageAttachments.map(async item => {
         const info = await getImageFileInfo(item.uri);
         if (!info.exists) throw new Error('图片不存在');
         return { ...item, size: info.size || Number(item.size) || 0 };
         }));
         if (isCanceled()) return false;
         validateImageBatch(sizedImages, { requireDimensions: true });
     } catch (error) {
       if (error && error.message === '无法读取图片大小') {
         Alert.alert('图片读取失败', '无法读取图片大小，请重新选择图片。');
       } else {
         Alert.alert('图片过大', '一次发送的图片总大小过大，请减少图片后再试。');
       }
       return false;
     }
    ttsStop().catch(() => {});
     const now = Date.now();
     const mediaMessages = [];
     const imageMessages = [];
     let totalBase64Bytes = 0;
    for (let index = 0; index < imageAttachments.length; index += 1) {
      const item = sizedImages[index];
      const kind = item.kind === STICKER_MESSAGE_KIND ? STICKER_MESSAGE_KIND : 'image';
      if (kind === 'image' && !visionEnabled) {
        Alert.alert('不支持识图', '当前来源未标记为支持识图，请在设置中确认模型能力。');
        return false;
      }
       let dataUri = '';
       if (visionEnabled) {
          const estimatedBase64Bytes = Math.ceil(Number(item.size || 0) * 4 / 3);
          if (totalBase64Bytes + estimatedBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
            Alert.alert('图片过大', '图片总大小过大，请减少图片后再试。');
            return false;
          }
          totalBase64Bytes += estimatedBase64Bytes;
          try {
            dataUri = await readImageDataUri(item.uri, item.mime);
            const separator = dataUri.indexOf(',');
            const base64Length = separator >= 0 ? dataUri.length - separator - 1 : dataUri.length;
            const actualBase64Bytes = Math.ceil(base64Length * 3 / 4);
            totalBase64Bytes = Math.max(
              totalBase64Bytes,
              totalBase64Bytes - estimatedBase64Bytes + actualBase64Bytes
            );
              if (totalBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
                throw new Error('图片总大小过大');
              }
              if (isCanceled()) return false;
          } catch (error) {
           if (error && error.message === '图片总大小过大') {
             Alert.alert('图片过大', '图片总大小过大，请减少图片后再试。');
           } else {
             Alert.alert('图片读取失败', '请重新选择图片。');
           }
           return false;
         }
      }
      if (!isSessionGuardCurrent(sessionGuard)) return false;
      const mediaMessage = createMediaMessage({
        id: `${now}-${kind}-${index}`,
        kind,
        uri: item.uri,
        mime: item.mime,
        name: item.name || item.stickerName,
        width: item.width,
        height: item.height,
        stickerId: item.stickerId,
        stickerName: item.stickerName,
        timestamp: now + index,
      });
      mediaMessages.push(mediaMessage);
      imageMessages.push({
        ...mediaMessage,
        dataUri,
        includeImage: visionEnabled,
      });
    }
     const mergedText = mergeTextAttachments(text, textAttachments);
     if (!mergedText && mediaMessages.length === 0 && !voice) return false;
     const textMessage = mergedText
      ? {
          id: `${now}-user-${mediaMessages.length}`,
          role: USER_ID,
          text: mergedText,
          timestamp: now + mediaMessages.length,
        }
      : null;
    const draftQuote = quoteTarget;
    if (textMessage && draftQuote) textMessage.quoted = draftQuote;
    // 语音消息：自身携带转写文本与音频引用，作为一条 user 消息参与展示与上下文。
    // 转写文本进入 userText（送模型），音频仅本机回放（历史不回传，符合非目标）。
    const voiceMessage = voice
      ? createVoiceMessage({
          id: `${now}-user-voice`,
          role: USER_ID,
          text: voice.text,
          audio: { uri: voice.uri, mime: voice.mime, durationMs: voice.durationMs },
          timestamp: now + mediaMessages.length,
        })
      : null;
    if (voiceMessage && draftQuote) voiceMessage.quoted = draftQuote;
    const baseMessages = [...messages, ...mediaMessages];
    if (textMessage) baseMessages.push(textMessage);
    if (voiceMessage) baseMessages.push(voiceMessage);
    const promptUserText = voiceMessage ? String(voice.text || '').trim() : mergedText;
    // 音频兜底（需求 6.2）：转写文本为空且来源标记 supportsAudio 时，读音频为
    // base64 按 input_audio 多模态直接发送（仅当前这条，历史不回传）。
    let voiceAudio = null;
    if (voiceMessage && !promptUserText && audioInputEnabled && voice.uri) {
      try {
        const base64 = await FileSystem.readAsStringAsync(voice.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (base64) voiceAudio = { base64, mime: voice.mime };
      } catch (error) {
        voiceAudio = null;
      }
    }
    const payload = {
      historyMessages: messages,
      userText: voiceMessage ? (promptUserText || '[用户发来一段语音]') : mergedText,
      baseMessages,
      images: imageMessages
        .filter(item => item.includeImage)
        .map(item => item.dataUri),
      imageMessages,
      quote: (textMessage || voiceMessage) ? draftQuote : null,
      voiceAudio,
       expectedConfigId,
       expectedConfigFingerprint,
       sessionGuard,
    };
     if (isCanceled() || !isSessionGuardCurrent(sessionGuard)
       || (abortRef.current && abortRef.current.signal.aborted)) return false;
     try {
       const latest = await getApiConfigs();
       if (isCanceled() || !isSessionGuardCurrent(sessionGuard)) return false;
       const latestConfig = latest.configs.find(item => item.id === latest.activeId) || latest.configs[0];
        const latestConfigId = String(latestConfig && latestConfig.id || '');
        if (
          (expectedConfigId && latestConfigId !== expectedConfigId)
          || (
            expectedConfigFingerprint
            && latestConfig
            && getConfigFingerprint(latestConfig) !== expectedConfigFingerprint
          )
        ) {
         Alert.alert('模型来源已切换', '请重新发送这条消息。');
         return false;
       }
        if (
          imageAttachments.some(item => item.kind === 'image')
          && latestConfig
          && latestConfig.supportsVision !== true
          && !localMedia.vision
        ) {
         Alert.alert('不支持识图', '当前来源未标记为支持识图，请在设置中确认模型能力。');
         return false;
       }
     } catch (error) {
       Alert.alert('配置读取失败', '请稍后重试。');
       return false;
     }
     const baseAttachmentIds = baseAttachments.map(item => String(item.id || ''));
    setInput(current => {
      if (current !== rawText) return current;
      // 发送成功即清空草稿：内容已进入消息列表，不再是待发草稿。
      draftTextRef.current = '';
      persistDraftNow(sessionGuard.sessionId, '');
      return '';
    });
    setAttachments(current => {
      const currentIds = current.map(item => String(item.id || ''));
      if (
        currentIds.length !== baseAttachmentIds.length
        || currentIds.some((id, index) => id !== baseAttachmentIds[index])
      ) return current;
      return [];
    });
    setQuoteTarget(current => (
      String(current && current.id || '') === String(draftQuote && draftQuote.id || '')
        ? null
        : current
    ));
      const handled = isGroupRef.current
        ? await requestGroupReply(payload)
        : await requestReply(payload);
      if (handled === false && isSessionGuardCurrent(sessionGuard)) {
        const originalIds = new Set(messages.map(item => String(item && item.id || '')));
        setMessages(current => current.filter(item => originalIds.has(String(item && item.id || ''))));
        const restoredAttachments = allAttachments;
        attachmentsRef.current = restoredAttachments;
        setAttachments(restoredAttachments);
        setInput(rawText);
        draftTextRef.current = rawText;
        persistDraftNow(sessionGuard.sessionId, rawText);
        setQuoteTarget(draftQuote);
        syncProtectedAttachmentUris();
        if (sourceChangedRef.current) {
          Alert.alert('模型来源已切换', '已保留原消息草稿，请重新发送。');
        }
        return false;
      }
      return handled !== false && isSessionGuardCurrent(sessionGuard) && !(abortRef.current && abortRef.current.signal.aborted);
  }, [attachments, captureSessionGuard, greetingReady, isSessionGuardCurrent, isSwitching, messageSelectionOpen, messages, quoteTarget, ready, requestReply, requestGroupReply, sessionOwnerMissing, sessionTransitionPending, syncProtectedAttachmentUris]);

  const sendMessage = useCallback(async (...args) => {
    const token = beginSendOperation();
    if (!token) return false;
    try {
      return await performSendMessage(...args);
    } finally {
      endSendOperation(token);
    }
  }, [beginSendOperation, endSendOperation, performSendMessage]);

  const sendText = useCallback(rawText => sendMessage(rawText), [sendMessage]);
  const regenerateMessage = useCallback(async targetId => {
     if (isSending || isSwitching || sessionTransitionPending || !ready || sendLockRef.current) return;
    const token = beginSendOperation();
    if (!token) return;
    const sessionGuard = captureSessionGuard();
     try {
       if (!isSessionGuardCurrent(sessionGuard)) return false;
       const originalMessages = messages;
       if (sessionOwnerMissing) {
        Alert.alert('角色资料缺失', '恢复角色资料后才能重新生成回复。');
        return false;
      }
      const index = messages.findIndex(item => item.id === targetId);
      if (index < 0 || messages[index].role !== ASSISTANT_ID) return false;
      let userStart = index - 1;
      while (userStart >= 0 && messages[userStart].role === USER_ID) {
        userStart -= 1;
      }
      userStart += 1;
       const userMessages = messages.slice(userStart, index);
       if (userMessages.length === 0) return false;
       const quote = userMessages
         .slice()
         .reverse()
         .find(item => item && item.quoted && item.quoted.text)
         ?.quoted || null;
       let includeImage = false;
       let expectedConfigId = '';
       let expectedConfigFingerprint = '';
       let localMedia = { vision: false, audio: false };
      try {
        const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
          getApiConfigs(),
          getLocalModelSettings().catch(() => null),
          getActiveLocalModel().catch(() => null),
        ]);
        const current = configs.find(item => item.id === activeId) || configs[0];
         expectedConfigId = String(current?.id || '');
         expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
         includeImage = !!(current && current.supportsVision);
         localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
         includeImage = includeImage || localMedia.vision;
      } catch (error) {}
      if (!isSessionGuardCurrent(sessionGuard)) return false;
       const mediaItems = userMessages.filter(item => item && item.image);
       let sizedMedia = [];
       try {
         sizedMedia = await Promise.all(mediaItems.map(async item => {
           const info = await getImageFileInfo(item.image.uri);
           if (!info.exists) throw new Error('图片不存在');
             const dimensions = item.image.width > 0 && item.image.height > 0
               ? { width: item.image.width, height: item.image.height }
               : await getImageDimensions(item.image.uri);
             return {
               item,
               size: info.size,
               width: dimensions.width,
               height: dimensions.height,
             };
         }));
           validateImageBatch(sizedMedia, { requireDimensions: true });
       } catch (error) {
         Alert.alert('图片过大', '重新生成所需的图片大小或数量超限。');
         return false;
       }
        const imageMessages = [];
        let totalBase64Bytes = 0;
        for (const media of sizedMedia) {
          const { item } = media;
          let dataUri = '';
          if (includeImage) {
            const estimatedBase64Bytes = Math.ceil(Number(media.size || 0) * 4 / 3);
            if (totalBase64Bytes + estimatedBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
              Alert.alert('图片过大', '重新生成所需的图片总大小过大。');
              return false;
            }
            totalBase64Bytes += estimatedBase64Bytes;
            dataUri = await readImageDataUri(item.image.uri, item.image.mime).catch(() => '');
            const separator = dataUri.indexOf(',');
            const base64Length = separator >= 0 ? dataUri.length - separator - 1 : dataUri.length;
            const actualBase64Bytes = Math.ceil(base64Length * 3 / 4);
            totalBase64Bytes = Math.max(
              totalBase64Bytes,
              totalBase64Bytes - estimatedBase64Bytes + actualBase64Bytes
            );
            if (totalBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
              Alert.alert('图片过大', '重新生成所需的图片总大小过大。');
              return false;
            }
          }
          imageMessages.push({
            ...item.item,
            dataUri,
            includeImage,
          });
        }
      const userText = userMessages
        .filter(item => item && !item.image)
        .map(item => String(item.text || ''))
        .filter(Boolean)
        .join('\n');
        if (!isSessionGuardCurrent(sessionGuard)) return false;
        const vectorOwnerId = getVectorOwnerId(
          sessionsRef.current.find(item => item.id === sessionGuard.sessionId),
          character.id
        );
        if (vectorOwnerId) {
          await removeVectorIndexForSession(vectorOwnerId, sessionGuard.sessionId);
        }

       const handled = await requestReply({
         historyMessages: messages.slice(0, userStart),
         userText,
           baseMessages: messages.slice(0, index),
           imageMessages,
           quote,
            expectedConfigId,
            expectedConfigFingerprint,
            sessionGuard,
            restoreOnFailure: true,
       });
        if (handled === false && isSessionGuardCurrent(sessionGuard)) {
          setMessages(originalMessages);
          if (sourceChangedRef.current) {
            Alert.alert('模型来源已切换', '已保留原消息，请重新生成。');
          }
          return false;
        }
        if (handled !== false && isSessionGuardCurrent(sessionGuard) && !abortRef.current) {
          const session = sessionsRef.current.find(item => item.id === sessionGuard.sessionId);
          if (session) {
            const sessionCharacterId = String(session.characterId || '');
            const characterExists = (Array.isArray(charactersRef.current) ? charactersRef.current : [])
              .some(item => item.id === sessionCharacterId);
            const scoped = !characterExists
              || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, session, originalMessages);
            try {
              await invalidateHistorySummaries({
                session,
                messages: originalMessages.slice(0, index),
                removedIds: originalMessages.slice(index).map(item => String(item && item.id || '')),
                scoped,
                character,
                updateCharacter,
              });
            } catch (error) {
              if (__DEV__) console.warn('[memorySummary] regenerate invalidation failed', error);
            }
          }
        }
        return handled !== false && isSessionGuardCurrent(sessionGuard) && !abortRef.current;
    } finally {
      endSendOperation(token);
    }
  }, [beginSendOperation, captureSessionGuard, character, endSendOperation, isSending, isSessionGuardCurrent, isSwitching, messages, ready, removeVectorIndexForSession, requestReply, sessionOwnerMissing, sessionTransitionPending, updateCharacter]);

  const editUserMessage = useCallback(targetId => {
    if (isSending || isSwitching || sessionTransitionPending || !ready || abortRef.current) return;
    const sessionGuard = captureSessionGuard();
    const plan = getEditResendPlan(messagesRef.current, targetId);
    if (!plan || !isSessionGuardCurrent(sessionGuard)) return;
    Alert.alert(
      '修改重发',
      '确定撤回这条消息及其后续回复，并将原文字回退到输入框吗？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '撤回并编辑',
          style: 'destructive',
          onPress: async () => {
            if (isSending || isSwitching || !isSessionGuardCurrent(sessionGuard) || abortRef.current) return;
            const latestPlan = getEditResendPlan(messagesRef.current, targetId);
            if (!latestPlan) return;
            try {
              const session = sessionsRef.current.find(item => item.id === sessionGuard.sessionId);
              const keptIds = new Set(latestPlan.messages.map(item => String(item && item.id || '')));
              const removedIds = messagesRef.current
                .map(item => String(item && item.id || ''))
                .filter(id => id && !keptIds.has(id));
              if (session) {
                const sessionCharacterId = String(session.characterId || '');
                const characterExists = (Array.isArray(charactersRef.current) ? charactersRef.current : [])
                  .some(item => item.id === sessionCharacterId);
                const scoped = !characterExists
                  || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, session, messagesRef.current);
                await invalidateHistorySummaries({
                  session,
                  messages: latestPlan.messages,
                  removedIds,
                  scoped,
                  character,
                  updateCharacter,
                });
              }
               const vectorOwnerId = getVectorOwnerId(
                 session,
                 characterId
               );
               if (vectorOwnerId) {
                 await removeVectorIndexForSession(vectorOwnerId, sessionGuard.sessionId);
               }
              if (!isSessionGuardCurrent(sessionGuard)) return;
              setMessages(latestPlan.messages);
              setInput(latestPlan.text);
              setQuoteTarget(null);
            } catch (error) {
              Alert.alert('撤回失败', '记忆摘要未能同步重置，请稍后重试。');
            }
          },
        },
      ]
    );
  }, [captureSessionGuard, character, characterId, isSending, isSessionGuardCurrent, isSwitching, ready, removeVectorIndexForSession, sessionTransitionPending, updateCharacter]);

  const messageActionsRef = useRef({});
  useEffect(() => {
    messageActionsRef.current = { regenerateMessage, editUserMessage };
  }, [regenerateMessage, editUserMessage]);

  const onRegenerateMessage = useCallback(targetId => {
    messageActionsRef.current.regenerateMessage?.(targetId);
  }, []);

  const onEditUserMessage = useCallback(targetId => {
    messageActionsRef.current.editUserMessage?.(targetId);
  }, []);

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

  const sendTextRef = useRef(sendText);
  const generateInlineImageRef = useRef(null);
  const inlineImageEnabledRef = useRef(false);  const recordTurnRef = useRef(null);
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
      picked = await pickAttachment();
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
    Alert.alert('添加附件', '选择要上传的内容类型。', [
      { text: '取消', style: 'cancel' },
      { text: '纯文本文档', onPress: () => addAttachment('text') },
      { text: '图片', onPress: () => addAttachment('image') },
    ]);
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
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        onContentSizeChange={autoScrollToBottom}
        onScroll={onMessagesScroll}
        scrollEventThrottle={16}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          bgUri ? (
            // 有自定义/内置背景图时不再叠加「开始聊天/当前角色/请先填写 API」引导块：
            // 背景图上再压一段旧引导文案既突兀又像第二层背景。只保留「选择开场白」入口。
            !isGroup && !sessionOwnerMissing ? (
              <View style={styles.emptyState}>
                <TouchableOpacity
                  style={styles.emptyGreetingButton}
                  onPress={() => openGreetingPicker(activeSessionId ? 'reselect' : 'new')}
                  activeOpacity={0.8}
                >
                  <Text style={styles.emptyGreetingButtonText}>选择开场白</Text>
                </TouchableOpacity>
              </View>
            ) : null
          ) : (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconBadge}>
                <Ionicons name="chatbubbles-outline" size={36} color={theme.colors.primaryMuted} />
              </View>
              <Text style={styles.emptyTitle}>开始聊天</Text>
              <Text style={styles.emptyText}>
                当前角色：{sessionOwnerMissing ? '角色资料缺失' : (character.name || 'EasyChat2 助手')}{'\n'}
                {sessionOwnerMissing
                  ? '这段历史对话仍可查看，角色资料恢复后才能发送。'
                  : !greetingReady
                    ? '先选择开场白，再开始发送消息。'
                    : '请先在“设置”里填写 API Key，然后输入消息。'}{'\n'}
              </Text>
              {!isGroup && !sessionOwnerMissing ? (
                <TouchableOpacity
                  style={styles.emptyGreetingButton}
                  onPress={() => openGreetingPicker(activeSessionId ? 'reselect' : 'new')}
                  activeOpacity={0.8}
                >
                  <Text style={styles.emptyGreetingButtonText}>选择开场白</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )
        ) : (
          renderedMessages.map((message, index) => {
            const speaker = message.speakerId ? characterMap.get(message.speakerId) : null;
            const selected = selectedMessageIdSet.has(String(message.id || ''));
            const richInteractive =
              message.role !== SYSTEM_ERROR_ID
              && !message.pending
              && !message.image
              && containsHtml(message.text)
              && shouldRenderRichHtml(message.text, chatOptions.richHtml !== false);
            // 富 HTML 消息内含 WebView：外层 Pressable 会抢走手势，导致卡片内部滚不动。
            // 非多选状态下不包 Pressable，多选入口改由三点菜单的「选择消息」提供。
            const distanceFromBottom = renderedMessages.length - 1 - index;
            const shouldAnimate = distanceFromBottom < 15;
            const entryDelay = distanceFromBottom * 40;
            const body = (
                <AnimatedEntry delay={entryDelay} enabled={shouldAnimate}>
                  {message.role === SYSTEM_ERROR_ID ? (
                    <ErrorBubble
                      message={message}
                      rawError={errorRawRef.current[message.id]}
                      fullWidth={chatOptions.fullWidth}
                      selectionMode={messageSelectionOpen}
                      selected={selected}
                    />
                  ) : (
                    <MessageBubble
                      message={message}
                      rawText={rawTextById.get(message.id)}
                      characterName={
                        isGroup
                          ? ((speaker && speaker.name) || message.speakerName || displayName)
                          : (sessionOwnerMissing ? '角色资料缺失' : ((speaker && speaker.name) || message.speakerName || character.name))
                      }
                      characterAvatar={
                        isGroup
                          ? (
                            (speaker && speaker.avatarUri)
                            || (message.speakerName
                              ? (groupCharacters.find(item => item.name === message.speakerName) || {}).avatarUri
                              : '')
                            || groupAvatarUri
                            || ''
                          )
                          : (speaker ? (speaker.avatarUri || '') : (message.speakerId ? '' : character.avatarUri))
                      }
                      userAvatarUri={userAvatar}
                      onSlashCommand={onSlashCommand}
                      canRegenerate={!isGroup && regenerableIds.has(message.id)}
                      onRegenerate={onRegenerateMessage}
                       onEditUserMessage={!isGroup ? onEditUserMessage : undefined}
                      onSelectText={onSelectText}
                      onQuote={onQuoteMessage}
                      onPressQuote={onPressQuoteBlock}
                      onGenerateImage={generateInlineImage}
                      onBroadcast={broadcastMessage}
                      highlightKeyword={searchQuery.trim()}
                      isMatch={searchMatches.includes(message.id)}
                      isActiveMatch={focusedMessageId === message.id}
                      fullWidth={chatOptions.fullWidth}
                      richHtmlEnabled={chatOptions.richHtml !== false}
                      onReselectGreeting={sessionOwnerMissing ? undefined : onReselectGreeting}
                      onStartSelection={richInteractive ? startMessageSelection : undefined}
                      thinkingDisplay={thinkingDisplay}
                      overlayActions={!!bgUri}
                      selectionMode={messageSelectionOpen}
                      selected={selected}
                    />
                  )}
                </AnimatedEntry>
            );
            if (richInteractive && !messageSelectionOpen) {
              return (
                <View key={message.id} onLayout={event => onMessageLayout(message.id, event)}>
                  {body}
                </View>
              );
            }
            return (
              <Pressable
                key={message.id}
                onLayout={event => onMessageLayout(message.id, event)}
                // onLongPress 必须始终非空：长按触发进入多选后本轮会重渲染，
                // 若此时把 onLongPress 置空，松手时 RN Pressability 的
                // isPressCanceledByLongPress 判定失效（Pressability.js:751），
                // 会补发 onPress 把刚选中的消息又取消掉——表现为原地松手就退出多选、
                // 只有滑动（先转 LONG_PRESS_OUT）才留得住。这里保留 onLongPress 作为
                // 「本次手势已被长按消费」的标记；多选态下长按不做新动作。
                onLongPress={() => {
                  if (messageSelectionOpen) return;
                  if (message.image) openImageActions(message.image, message.id);
                  else startMessageSelection(message.id);
                }}
                onPress={messageSelectionOpen ? () => toggleSelectedMessage(message.id) : undefined}
                delayLongPress={350}
                disabled={!ready || isSending || message.pending}
                accessibilityRole="button"
                accessibilityLabel="长按选择消息"
                accessibilityState={{ selected }}
              >
                {body}
              </Pressable>
            );
          })
        )}
      </ScrollView>

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
