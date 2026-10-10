import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { ROUTE_NAMES } from './navigation/routeNames.js';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Sharing from 'expo-sharing';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isConfigChangedError, sendChatMessage } from './network/api.js';
import {
   deleteLocalImage,
   deleteTemporaryImage,
    isImage,
    isTextLike,
    isVisionImage,
  persistImageAttachment,
  persistVideoAttachment,
  pickAttachment,
  pickStickerImage,
  pickVideoAttachment,
  readTextAttachment,
  recordVideo,
  deleteLocalVideo,
   getImageDimensions,
   getImageFileInfo,
   getImageMime,
   getPendingStickerImage,
   getVideoMime,
   isVideo,
   MAX_IMAGE_ATTACHMENTS,
   MAX_VIDEO_ATTACHMENTS,
   MAX_VIDEO_BYTES,
   takePhoto,
   validateImageSize,
} from './chat/attachments.js';
import { createMediaMessage, STICKER_MESSAGE_KIND } from './chat/chatMedia.js';
import { extractStickerDirectives, resolveStickerNames } from './chat/stickerDirectives.js';
import { createStickerImage, deleteStickerImage } from './chat/stickerImages.js';
import { getCachedDisplayText } from './memory/displayTextCache.js';
import { isGreetingMessage, listGreetingCandidates } from './character/cardGreetings.js';
import {
  getContinuousTailPlan,
  removeMessagesByIds,
  selectableMessageIds,
  toggleMessageSelection,
} from './chat/messageSelection.js';
import {
  applySummary,
  invalidateHistorySummaries,
  isBuiltinAssistant,
  isSessionScopedMemory,
  selectManualSummarizable,
  selectSummarizable,
  shouldSummarize,
} from './memory/memorySummary.js';
import {
} from './chat/replyFlow.js';
import { useApp } from './context/AppContext.js';
import CharacterEditForm from './CharacterEditForm.js';
import GreetingPickerModal from './GreetingPickerModal.js';
import GroupEditForm from './GroupEditForm.js';
import DisclaimerModal from './onboarding/disclaimer.js';
import {
  MENTION_PREFIX,
} from './chat/groupChat.js';
import { applyRegexScripts, REGEX_PLACEMENT } from './prompt/regexEngine.js';
import ScrollScrubber from './chat/ScrollScrubber.js';
import { maskSecrets } from './storage/secrets.js';
import { hideVariantStatusBar } from './chat/speechText.js';
import { recordDiagnostic } from './storage/diagnostics.js';
import { capabilitiesForModel, getApiConfigs, getActiveModel } from './storage/apiConfigs.js';
import { getActiveLocalModel, getLocalModelSettings } from './storage/localModels.js';
import {
  getChatOptions,
  getImageGenSettings,
  getInlineImageSettings,
  getMemorySummarySettings,
  getThinkingSettings,
  getTranscriptionSettings,
  getTtsSettings,
} from './storage/settings.js';
import { getStickers, saveSticker, deleteStickers, reorderStickers } from './storage/stickers.js';
import { getUserProfile } from './storage/personas.js';
import { setProtectedChatImageUris, setSessionGreetingSelected } from './storage/sessions.js';
import {
  archiveBranch,
  deleteBranch as deleteBranchStore,
  getBranch,
  pruneStaleBranches,
} from './storage/sessionBranches.js';
import useChatBranches from './chat/useChatBranches.js';
import { planCheckout } from './chat/branchTree.js';
import { getMomentsSettings, updateMoments } from './storage/moments.js';
import { getAffinityStatus, saveAffinity } from './storage/affinity.js';
import {
  getVectorMemoryConfig,
  removeVectorIndexForMessage,
  removeVectorIndexForMessages,
  removeVectorIndexForSession,
} from './storage/vector.js';

import {
} from './vectorMemory/index.js';
import { getVectorOwnerId } from './vectorMemory/scope.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { generateImage } from './imageGen/index.js';
import { getLocalModelMediaCapabilities } from './localModel/modelState.js';
import { normalizeLocalModelParams } from './localModel/modelParams.js';
import { computeContextUsage, resolveContextWindow } from './chat/contextUsage.js';
import useAutoCompact from './chat/useAutoCompact.js';
import {
  COMPACTION_KEEP_RECENT,
  COMPACTION_MIN_MESSAGES,
  applyCompaction,
  buildCompactionSummaryRequest,
  compactionStatus,
  parseCompactionSummary,
} from './chat/compaction.js';
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
} from './imageGen/inlineImagePrompt.js';

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
import SessionStatsModal from './chat/SessionStatsModal.js';
import MemoryProvenanceModal from './memory/MemoryProvenanceModal.js';
import { summarizeStats } from './chat/sessionStats.js';
import { clearSessionStats, getSessionStats } from './storage/sessionStats.js';
import ConversationExportModal from './chat/ConversationExportModal.js';
import ConversationCardModal from './chat/ConversationCardModal.js';
import { shouldOpenMentionAtCursor } from './chat/groupMentions.js';
import ChatSettingsModal from './chat/ChatSettingsModal.js';
import VoiceSettingsModal from './chat/VoiceSettingsModal.js';
import TranscriptionPanel from './TranscriptionPanel.js';
import FullScreenInputModal from './chat/FullScreenInputModal.js';
import ChatSearchBar from './chat/ChatSearchBar.js';
import ChatTopBar from './chat/ChatTopBar.js';
import RunningRunsBar from './chat/RunningRunsBar.js';
import useWorkspaceRewind from './chat/useWorkspaceRewind.js';
import { sessionRuns } from './agent/runtime/sessionRuns.js';
import ChatComposer from './chat/ChatComposer.js';
import EngineStatusBar from './localModel/EngineStatusBar.js';
import { useLocalEngineStatus } from './localModel/useLocalEngineStatus.js';
import LocalModelPanel from './LocalModelPanel.js';
import useChatRecorder from './chat/useChatRecorder.js';
import AttachmentMenuModal from './chat/AttachmentMenuModal.js';
import {
  isUnsupportedTranscriptionError,
  resolveTranscription,
  transcribeAudio,
} from './transcription.js';
// 「compact」/「/compact」= 压缩指令：把当前会话按手动路径总结入记忆
//（原始消息仍保留在会话里，后续对话带着摘要继续），不把这条文本当消息发出去。
const COMPACT_COMMAND_PATTERN = /^\/?compact$/i;

export default function ChatScreen() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
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
    pendingQuote,
    consumePendingQuote,
  } = useApp();
  // 不能用 'default' 兜底：它是内置助手的角色 id，空 id 兜底会与初始卡撞身份
  // （同 storage/characters.js 的约束）。未加载时留空，由各调用点自行做就绪判断。
  const characterId = character.id || '';
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
    return String(session.name || '').trim() || memberNames.join('、') || t('common.groupChat');
  }, [characterMap, t]);
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
    syncActiveRun,
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
  const [exportOpen, setExportOpen] = useState(false);
  // 从选中对话生成角色卡（对话即制卡）：素材 = 多选的消息，按会话顺序排列。
  const [cardFromChatOpen, setCardFromChatOpen] = useState(false);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const [transcriptionPanelOpen, setTranscriptionPanelOpen] = useState(false);
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  // D3：会话压缩（手动，设置弹窗触发）——进行中状态；体积概览跟随消息变化。
  // E2：ref 版用于静默自动压缩的防重入（state 在异步闭包里会读到旧值）。
  const [compactBusy, setCompactBusy] = useState(false);
  const compactBusyRef = useRef(false);
  // E2：上下文占用（tokens/window/ratio）——70% 显示「建议压缩」提示条；
  // 自动压缩按 token 预算（窗口 − 输出预留 − 缓冲，见 chat/compactionPolicy.js）触发。
  const [contextUsage, setContextUsage] = useState({ tokens: 0, window: 0, ratio: 0 });
  const contextUsageRatio = contextUsage.ratio;
  // 「建议压缩」提示条被用户手动关掉后本次进入会话不再出现（换会话/重载恢复）。
  const [compactHintDismissed, setCompactHintDismissed] = useState(false);
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
    selectLocalModel,
  } = useChatModelThinking({ isSending, sendLockRef });
  const localEngine = useLocalEngineStatus();
  const [hubOpen, setHubOpen] = useState(false);
  // 本会话统计面板：打开时读该会话的累计数据（请求链路在 useChatSend 里打点）。
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsSummary, setStatsSummary] = useState(null);
  // 记忆溯源面板：按当前角色读向量记忆索引，做溯源与冲突检测。
  const [memoryProvenanceOpen, setMemoryProvenanceOpen] = useState(false);
   const [attachments, setAttachments] = useState([]);
   const attachmentsRef = useRef([]);
   attachmentsRef.current = attachments;
   const attachmentPickerLockRef = useRef(false);
   const [attachmentLoading, setAttachmentLoading] = useState(false);
   const pendingAttachmentUrisRef = useRef(new Set());
   const syncProtectedAttachmentUris = useCallback(() => {
     setProtectedChatImageUris([
       ...attachmentsRef.current
         .filter(item => item && (item.kind === 'image' || item.kind === 'video'))
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
  // 上传/拍摄视频的门控：模型声明 supportsVideo，且线协议为 OpenAI 兼容
  //（video_url 是兼容端点的扩展类型，Responses/Anthropic 没有视频输入）。
  const [attachmentVideoEnabled, setAttachmentVideoEnabled] = useState(false);
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
  const [chatOptions, setChatOptions] = useState({ streaming: true, fullWidth: false, richHtml: true, keepDraft: false, timeAware: false, bubbleStyle: 'rounded', autoCompact: true });
  const chatOptionsRef = useRef(chatOptions);
  chatOptionsRef.current = chatOptions;

  // 会话切换时的 UI 复位（附件清理、引用/表情面板/多选等），由 useSessionMessages
  // 在加载 effect 的原时序位置调用；输入框清空由 hook 自己完成。
  const resetSessionUi = useCallback(() => {
    const draftAttachments = attachmentsRef.current;
    draftAttachments.forEach(item => {
      if (item.kind === 'image') deleteLocalImage(item.uri);
      if (item.kind === 'video') deleteLocalVideo(item.uri);
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
      let video = false;
      try {
        const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
          getApiConfigs(),
          getLocalModelSettings().catch(() => null),
          getActiveLocalModel().catch(() => null),
        ]);
        const current = configs.find(item => item.id === activeId) || configs[0];
        // 能力按当前模型解析（同一配置下每个模型一套）。
        const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
        vision = caps.supportsVision === true
          || !!getLocalModelMediaCapabilities(localSettings, localItem).vision;
        video = caps.supportsVideo === true
          && String(current.protocol || 'openai') === 'openai';
      } catch (error) {}
      if (!cancelled) {
        setAttachmentVisionEnabled(vision);
        setAttachmentVideoEnabled(video);
      }
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
    syncActiveRun,
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
    // 切会话必须清掉上一条会话的布局偏移：否则 scrollToMessage 读到过期的数字 offset，
    // 会跳过扩窗直接滚到越界 y，搜索/引用跳转落点错误。
    messageOffsetsRef.current = {};
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

  // L0c（spec 2026-10-10-runtime-split）：**不再**在卸载时中断进行中的发送。
  // 目标 ①「退出聊天页不中断生成」：离开页面/会话后运行继续跑完，结果由 useChatSend
  // 的后台落库分支写回它自己的会话。真正的中止只有两条：用户点停止、运行中面板取消。
  // （保存重试计时器的清理仍随 useSessionMessages 外提。）

  const onStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  // 运行中角色条（L 系 ③）：停止某个后台会话的运行 / 切到它。
  const onStopRunning = useCallback(sessionId => {
    sessionRuns.cancel(String(sessionId || ''));
  }, []);
  const onOpenRunning = useCallback(async sessionId => {
    const id = String(sessionId || '');
    if (!id) return;
    const target = sessionsRef.current.find(item => item && item.id === id);
    const ownerId = target ? String(target.characterId || '') : '';
    try {
      // 与会话同角色：先切角色再切会话（切会话的配对守卫会要求角色一致）。
      if (ownerId) await switchCharacter(ownerId);
      await switchSession(id);
    } catch (error) {}
  }, [switchCharacter, switchSession]);

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

  // 听歌评论「接话」带入的引用：只在目标会话真正激活时消费一次，避免用户接话后
  // 又手动切走会话时引用串场。payload.id 为空（评论不是会话内消息），点引用块不定位。
  useEffect(() => {
    if (!ready || !pendingQuote) return;
    if (pendingQuote.sessionId !== activeSessionId) return;
    const value = consumePendingQuote();
    if (value && value.payload && value.payload.text) setQuoteTarget(value.payload);
  }, [ready, pendingQuote, activeSessionId, consumePendingQuote]);

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
      if (manual) Alert.alert(t('chat.summary.unavailable.title'), t('chat.summary.unavailable.none'));
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
       // 内置助手一律按会话级写入：它的角色卡没有「角色记忆」语义，
       // 且可能已被历史兜底归属污染，不再往里写记忆总结。
       const scoped = isBuiltinAssistant(sessionCharacter)
         || !characterExists
         || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, scopeOverride, session.id);
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
            const latestCharacters = Array.isArray(charactersRef.current) ? charactersRef.current : [];
            const latestCharacterExists = latestCharacters
              .some(item => item.id === sessionCharacterId);
            const latestCharacter = latestCharacters
              .find(item => item.id === sessionCharacterId) || sessionCharacter;
             return isBuiltinAssistant(latestCharacter)
               || !latestCharacterExists
               || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, scopeOverride, session.id);
          },
        });
      await refreshSessions().catch(() => {});
      if (result.skipped) {
        if (manual) Alert.alert(t('chat.summary.done.title'), t('chat.summary.done.empty'));
        return;
      }
      if (manual) {
        Alert.alert(
          t('chat.summary.saved.title'),
          result.scoped
            ? t('chat.summary.saved.scoped')
            : t('chat.summary.saved.worldbook')
        );
      }
    } catch (error) {
      if (manual) {
        Alert.alert(t('chat.summary.fail.title'), t('common.error.retryLater'));
      } else if (__DEV__) {
        console.warn('[memorySummary] automatic summary failed', error);
      }
    } finally {
      summarizingRef.current = false;
      setSummarizing(false);
    }
  }, [character, characters, updateCharacter, refreshSessions, t]);

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
    // 上下文占用（估算）：在线配置用每模型声明的 contextWindow，本地模型用 n_ctx，
    // 未声明则保守默认；到 80% 自动压缩（跟随「记忆总结」开关，见 memorySummary）。
    let contextUsage = null;
    try {
      const [{ configs, activeId }, localItem] = await Promise.all([
        getApiConfigs(),
        getActiveLocalModel().catch(() => null),
      ]);
      const current = configs.find(item => item.id === activeId) || configs[0];
      const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
      const localContextSize = localItem ? normalizeLocalModelParams(localItem).contextSize : 0;
      contextUsage = computeContextUsage(list, resolveContextWindow({
        declared: caps.contextWindow,
        localContextSize,
      }));
    } catch (error) {}
    if (!shouldSummarize({ session, messages: list, settings, contextUsage })) return;
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
      Alert.alert(t('chat.summary.groupUnsupported.title'), t('chat.summary.groupUnsupported.body'));
      return;
    }
    const session = sessionsRef.current.find(
      item => item.id === activeSessionIdRef.current
    );
    if (!session) {
      Alert.alert(t('chat.summary.unavailable.title'), t('chat.summary.noSession'));
      return;
    }
    const picked = selectManualSummarizable(messages, session.summarizedUpTo);
    if (picked.length === 0) {
      Alert.alert(t('chat.summary.unavailable.title'), t('chat.summary.unavailable.none'));
      return;
    }
    Alert.alert(
      t('chat.summary.confirm.title'),
      t('chat.summary.confirm.body', { count: picked.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chat.summary.confirm.action'),
          onPress: () => runSummarize(session, messages, true),
        },
      ]
    );
  }, [isSending, ready, messages, runSummarize, t]);

  // 「更多」菜单里的新对话入口：单聊走显式确认（破坏性操作），
  // 群聊直接调 onNewChat——其内部已有确认（旧对话保留在「记忆」中）。
  const onNewChatFromMenu = useCallback(() => {
    if (isGroupRef.current) {
      onNewChat();
      return;
    }
    Alert.alert(
      '新建对话',
      '将开启一段新对话，当前对话保留在会话列表与记忆中。',
      [
        { text: '取消', style: 'cancel' },
        { text: '新建', style: 'destructive', onPress: () => onNewChat() },
      ]
    );
  }, [onNewChat]);

  // 全屏编辑入口收敛：输入框长按 与「⋯」菜单共用（原右侧 ⛶ 按钮已移除）。
  const openFullScreen = useCallback(() => {
    setFullScreenText(input);
    setFullScreenOpen(true);
  }, [input]);

  // compact 指令：显式输入即代表意图，不再弹确认；runSummarize(manual) 自带
  // 「已完成/失败/无可总结」提示与并发保护。
  const runCompactCommand = useCallback(async () => {
    if (summarizingRef.current) {
      Alert.alert(t('chat.compact.busy.title'), t('chat.compact.busy.body'));
      return;
    }
    if (isGroupRef.current) {
      Alert.alert(t('chat.summary.groupUnsupported.title'), t('chat.compact.groupUnsupported.body'));
      return;
    }
    const session = sessionsRef.current.find(
      item => item.id === activeSessionIdRef.current
    );
    if (!session) {
      Alert.alert(t('chat.compact.noSession.title'), t('chat.compact.noSession.body'));
      return;
    }
    await runSummarize(session, messagesRef.current, true);
  }, [runSummarize, t]);

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
    modelLoadProgress,
    branchesRefreshToken,
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

  const { branchesByFork, reload: reloadBranches } = useChatBranches({
    activeSessionId,
    refreshToken: branchesRefreshToken,
  });

  const rewindWorkspace = useWorkspaceRewind({ messagesRef, sessionsRef }); // Z 系 #7：分支回退联动工作区

  // 切换到某条分支：把活动时间线替换为「分叉点及其之前 + 分支尾段」。
  // 被替换掉的当前尾段也归档成新分支，使来回切换不丢消息。
  const onCheckoutBranch = useCallback(async branch => {
    if (!branch || !branch.id || isSending || isSwitching || sessionTransitionPending || !ready) return;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      const loaded = await getBranch(sessionId, branch.id);
      if (loaded.status === 'corrupt') {
        Alert.alert(t('chat.branch.checkoutFailed.title'), t('chat.branch.checkoutFailed.body'));
        return;
      }
      if (loaded.status !== 'ok' || !loaded.branch) {
        // 分支正文缺失（索引还在）：删除该失效分支；损坏则保留待重试。
        if (loaded.status === 'missing') {
          await deleteBranchStore(sessionId, branch.id).catch(() => {});
        }
        Alert.alert(t('chat.branch.stale.title'), t('chat.branch.stale.body'));
        reloadBranches();
        return;
      }
      const target = { id: branch.id, forkMessageId: branch.forkMessageId, messages: loaded.branch.messages };
      const plan = planCheckout(messagesRef.current, target);
      if (plan.stale) {
        Alert.alert(t('chat.branch.stale.title'), t('chat.branch.stale.body'));
        await pruneStaleBranches(sessionId, new Set(messagesRef.current.map(item => String(item && item.id || '')))).catch(() => {});
        reloadBranches();
        return;
      }
      // 归档被替换掉的当前尾段（非空时）。
      if (plan.removedTail.length > 0) {
        await archiveBranch(sessionId, plan.forkMessageId, plan.removedTail).catch(() => {});
      }
      // 目标分支已被消费：删掉它的归档（消息已进入活动时间线）。
      await deleteBranchStore(sessionId, branch.id).catch(() => {});
      const nextMessages = [...plan.prefix, ...plan.activated];
      const checkoutSession = sessionsRef.current.find(item => item.id === sessionId);
      const sessionCharacterId = String((checkoutSession && checkoutSession.characterId) || '');
      const latestCharacters = Array.isArray(charactersRef.current) ? charactersRef.current : [];
      const characterExists = latestCharacters.some(item => item.id === sessionCharacterId);
      const sessionCharacter = latestCharacters.find(item => item.id === sessionCharacterId) || character;
      const scoped = isBuiltinAssistant(sessionCharacter)
        || !characterExists
        || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, undefined, sessionId);
      await invalidateHistorySummaries({
        session: checkoutSession,
        messages: nextMessages,
        removedIds: plan.removedTail.map(item => String(item && item.id || '')),
        scoped,
        character: sessionCharacter,
        updateCharacter,
      }).catch(() => {});
      const vectorOwnerId = getVectorOwnerId(checkoutSession, characterId);
      if (vectorOwnerId) {
        await removeVectorIndexForSession(vectorOwnerId, sessionId).catch(() => {});
      }
      setMessages(nextMessages);
      rewindWorkspace({ sessionId, forkMessageId: plan.forkMessageId }).catch(() => {});
      reloadBranches();
      autoScrollToBottom();
    } catch (error) {
      Alert.alert(t('chat.branch.checkoutFailed.title'), t('chat.branch.checkoutFailed.body'));
    }
  }, [autoScrollToBottom, character, characterId, isSending, isSwitching, ready, reloadBranches, rewindWorkspace, sessionTransitionPending, t, updateCharacter]);

  const onDeleteBranch = useCallback(async branch => {
    if (!branch || !branch.id) return;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      await deleteBranchStore(sessionId, branch.id);
      reloadBranches();
    } catch (error) {
      Alert.alert(t('chat.branch.deleteFailed.title'), t('chat.branch.deleteFailed.body'));
    }
  }, [reloadBranches, t]);

  const onSelectText = useCallback(text => {
    setSelectionText(String(text || ''));
  }, []);
  const onQuoteMessage = useCallback(message => {
    if (!message || !message.id) return;
    const isUserMessage = message.role === USER_ID;
    const speakerName = String(message.speakerName || '').trim();
    const name = isUserMessage
      ? (userNameRef.current || t('chat.quote.meFallback'))
      : (speakerName || String(character?.name || '').trim());
    const payload = buildQuotePayload(message, name);
    if (!payload) return;
    setQuoteTarget(payload);
  }, [character, t]);

  const onPressQuoteBlock = useCallback(quote => {
    if (!quote || !quote.id) return;
    // 用 messagesRef 查询存在性：若依赖 messages，流式回复期间每个 token 都会让
    // 这个回调换引用，进而击穿 MessageBubble 的 React.memo，导致全体历史气泡
    // 每 token 全量重渲染并重跑 Markdown 解析。
    const exists = messagesRef.current.some(item => item.id === quote.id);
    if (!exists) {
      Alert.alert(t('chat.quote.deleted.title'), t('chat.quote.deleted.body'));
      return;
    }
    setFocusedMessageId(quote.id);
    scrollToMessage(quote.id);
  }, [scrollToMessage, t]);

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

  // 选中的消息按**会话顺序**取出（不是点击顺序）：提炼角色时要还原对话的先后，
  // 打乱顺序会让模型读不出「角色态度怎么变的」。过滤 messages 天然保序。
  const selectedMessagesForCard = useMemo(
    () => (Array.isArray(messages) ? messages : [])
      .filter(item => item && item.id && selectedMessageIdSet.has(String(item.id))),
    [messages, selectedMessageIdSet]
  );
  const openCardFromSelection = useCallback(() => {
    if (selectedMessagesForCard.length === 0 || isSending) return;
    setCardFromChatOpen(true);
  }, [isSending, selectedMessagesForCard.length]);

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
      t('chat.deleteMessages.title'),
      clearsAll
        ? t('chat.deleteMessages.allBody', { count: ids.length })
        : t('chat.deleteMessages.body', { count: ids.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
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
                const latestCharacter = latestCharacters.find(item => item.id === sessionCharacterId)
                  || character;
                const scoped = isBuiltinAssistant(latestCharacter)
                  || !characterExists
                  || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, undefined, session.id);
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
              Alert.alert(t('common.error.deleteFailed'), t('chat.deleteMessages.syncFail.body'));
              return;
            }
            if (
              sessionVersionRef.current !== sessionVersion
              || activeSessionIdRef.current !== sessionId
            ) return;
            sessionVersionRef.current += 1;
            // 删除的消息若是「自某点起的连续尾段」，先归档成分支再移除，
            // 使「全选 + 删除」的整段清理仍可回溯（需求 1.3）。
            const tailPlan = getContinuousTailPlan(messagesRef.current, ids);
            if (tailPlan && tailPlan.tail.length > 0) {
              await archiveBranch(sessionId, tailPlan.forkMessageId, tailPlan.tail).catch(() => {});
            }
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
  }, [character, characterId, characters, isSending, persistDraftNow, ready, refreshSessions, removeVectorIndexForMessages, removeVectorIndexForSession, selectedMessageIds, setSessionGreetingSelected, t, updateCharacter]);

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

  // D3：压缩当前会话——一次模型调用压成三段摘要 + 保留最近 K 条原文；
  // 失败保持原会话不动（压缩是锦上添花，绝不能成为会话损坏的来源）。
  // 与分支系统：压缩会让引用旧消息的 fork 点失效，branchTree 按 `stale` 降级。
  // E2：支持 { silent: true } 静默模式（85% 自动触发用）——不弹任何 Alert，
  // 返回 { ok, before?, after? } 供调用方决策；手动路径行为与旧版逐字一致。
  const compactInfo = useMemo(() => compactionStatus(messages), [messages]);
  const handleCompactSession = useCallback(async (options = {}) => {
    const silent = options && options.silent === true;
    if (compactBusyRef.current) return { ok: false, reason: 'busy' };
    const list = Array.isArray(messagesRef.current) ? messagesRef.current : messages;
    const meaningful = (Array.isArray(list) ? list : [])
      .filter(item => item && (item.role === 'user' || item.role === 'assistant')
        && String((item && (item.text || item.content)) || '').trim());
    if (meaningful.length < COMPACTION_MIN_MESSAGES) {
      if (!silent) Alert.alert(t('chat.settings.compactTitle'), t('chat.settings.compactTooShort'));
      return { ok: false, reason: 'too-short' };
    }
    compactBusyRef.current = true;
    setCompactBusy(true);
    try {
      const { configs, activeId } = await getApiConfigs();
      const config = configs.find(item => item.id === activeId) || configs[0];
      if (!config) throw new Error('no config');
      const reply = await sendChatMessage(buildCompactionSummaryRequest(list), {
        stream: false,
        expectedConfigId: String(config.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(config),
      });
      const summary = parseCompactionSummary(reply);
      if (!summary || summary === EMPTY_REPLY_TEXT) throw new Error('empty summary');
      const next = applyCompaction(list, summary);
      setMessages(next); // useSessionMessages 自动串行持久化
      if (!silent) {
        Alert.alert(t('chat.settings.compactTitle'), t('chat.settings.compactDone', {
          before: meaningful.length,
          after: next.length,
          kept: COMPACTION_KEEP_RECENT,
        }));
      }
      return { ok: true, before: meaningful.length, after: next.length };
    } catch (error) {
      if (!silent) Alert.alert(t('chat.settings.compactTitle'), t('chat.settings.compactFail'));
      return { ok: false, reason: 'failed' };
    } finally {
      compactBusyRef.current = false;
      setCompactBusy(false);
    }
  }, [messages, messagesRef, setMessages, t]);

  // E2：上下文占用观测（独立于记忆总结）——70% 提示条与 85% 自动压缩的数据源。
  // 依赖 messages.length 而非整个数组：流式期间 content 变但条数不变，不做逐 token 重算。
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = Array.isArray(messagesRef.current) ? messagesRef.current : [];
      if (!list.length) {
        if (alive) setContextUsage({ tokens: 0, window: 0, ratio: 0 });
        return;
      }
      try {
        const [{ configs, activeId }, localItem] = await Promise.all([
          getApiConfigs(),
          getActiveLocalModel().catch(() => null),
        ]);
        const current = configs.find(item => item.id === activeId) || configs[0];
        const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
        const localContextSize = localItem ? normalizeLocalModelParams(localItem).contextSize : 0;
        const usage = computeContextUsage(list, resolveContextWindow({
          declared: caps.contextWindow,
          localContextSize,
        }));
        if (alive) setContextUsage(usage && Number.isFinite(usage.ratio) ? usage : { tokens: 0, window: 0, ratio: 0 });
      } catch (error) {
        if (alive) setContextUsage({ tokens: 0, window: 0, ratio: 0 });
      }
    })();
    return () => { alive = false; };
  }, [messages.length]);

  // E2：自动压缩——空闲时静默触发，token 预算口径 + 先本地微压缩（Z 系采纳 #5）。
  useAutoCompact({
    enabled: chatOptions.autoCompact, contextUsage, isSending, messages,
    messagesRef, setMessages, compactBusyRef, onCompact: handleCompactSession,
  });

  const generateInlineImage = useCallback(async (messageId, sourceText) => {
    if (inlineImageBusyRef.current) {
      Alert.alert(t('chat.inlineImage.busy.title'), t('common.error.retryLater'));
      return;
    }
    const settings = inlineImageSettings;
    const providerId = settings.providerId || '';
    if (!providerId) {
      Alert.alert(t('chat.inlineImage.noProvider.title'), t('chat.inlineImage.noProvider.pick'));
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
      Alert.alert(t('chat.inlineImage.noProvider.title'), t('chat.inlineImage.noProvider.config'));
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
        throw new Error(t('chat.inlineImage.noPrompt'));
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
            inlineImage: first ? { status: 'done', ...first } : { status: 'error', message: t('chat.inlineImage.noImage') },
          }
          : item
      )));
     } catch (error) {
       if (!controller.signal.aborted && activeSessionIdRef.current === sessionId) {
         setMessages(current => current.map(item => (
           item.id === messageId
             ? { ...item, inlineImage: { status: 'error', message: (error && error.message) || t('chat.inlineImage.fail') } }
             : item
         )));
       }
     } finally {
       if (inlineImageControllerRef.current === controller) {
         inlineImageControllerRef.current = null;
         inlineImageBusyRef.current = false;
       }

    }
  }, [inlineImageSettings, resolveInlineImageScene, t]);

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
            Alert.alert(t('chat.send.fail.title'), maskSecrets((error && error.message) || t('common.error.retryLater')));
          }
        });
      }
    };
    if (!sourceMessageId) {
      execute();
      return;
    }
    Alert.alert(
      t('chat.cardCommand.title'),
      t('chat.cardCommand.body', { command: maskSecrets(String(command || '').slice(0, 500)) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('chat.send.action'), onPress: execute },
      ],
    );
  }, [t]);

  const removeAttachment = useCallback(id => {
     if (isSending || sendLockRef.current) return;
     const target = attachments.find(item => item.id === id);
     if (target && target.kind === 'image') deleteLocalImage(target.uri);
     if (target && target.kind === 'video') deleteLocalVideo(target.uri);
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
      // 拍照/拍摄视频走相机，其余走系统文件/相册选择器。产出同一形状，后续校验与落盘复用。
      picked = kind === 'camera'
        ? await takePhoto()
        : kind === 'video-camera'
          ? await recordVideo()
          : kind === 'video'
            ? await pickVideoAttachment()
            : await pickAttachment();
      if (picked && picked.denied) {
        Alert.alert(
          t('chat.attach.cameraPerm.title'),
          t('chat.attach.cameraPerm.body')
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
          Alert.alert(t('chat.attach.unsupported.title'), t('chat.attach.unsupported.textOnly'));
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
      // ---- 视频分支（上传/拍摄）----
      if (kind === 'video' || kind === 'video-camera') {
        if (!isVideo(picked.name, picked.mime)) {
          deleteTemporaryImage(picked.uri);
          Alert.alert(t('chat.attach.unsupported.title'), t('chat.attach.unsupported.videoOnly'));
          return;
        }
        const fileInfo = await getImageFileInfo(picked.uri);
        if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        if (!fileInfo.exists) {
          deleteTemporaryImage(picked.uri);
          Alert.alert(t('chat.attach.video.invalid.title'), t('chat.attach.video.invalid.body'));
          return;
        }
        const size = fileInfo.size || picked.size;
        if (!(Number(size) > 0)) {
          deleteTemporaryImage(picked.uri);
          Alert.alert(t('chat.attach.video.readFail.title'), t('chat.attach.video.readFail.body'));
          return;
        }
        if (Number(size) > MAX_VIDEO_BYTES) {
          deleteTemporaryImage(picked.uri);
          Alert.alert(t('chat.attach.video.tooLarge.title'), t('chat.attach.video.tooLarge.body', { size: Math.round(MAX_VIDEO_BYTES / (1024 * 1024)) }));
          return;
        }
        if (attachmentsRef.current.filter(item => item.kind === 'video').length >= MAX_VIDEO_ATTACHMENTS) {
          deleteTemporaryImage(picked.uri);
          Alert.alert(t('chat.attach.video.tooMany.title'), t('chat.attach.video.tooMany.body', { count: MAX_VIDEO_ATTACHMENTS }));
          return;
        }
        const { configs, activeId } = await getApiConfigs();
        if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        const current = configs.find(item => item.id === activeId) || configs[0];
        const videoAllowed = capabilitiesForModel(current, current ? getActiveModel(current) : '').supportsVideo === true
          && String(current.protocol || 'openai') === 'openai';
        if (!videoAllowed) {
          deleteTemporaryImage(picked.uri);
          Alert.alert(t('chat.attach.video.unsupported.title'), t('chat.attach.video.unsupported.body'));
          return;
        }
        durableUri = await persistVideoAttachment(picked.uri, picked.mime, picked.name);
        deleteTemporaryImage(picked.uri);
        pendingAttachmentUrisRef.current.add(durableUri);
        syncProtectedAttachmentUris();
        const videoMime = getVideoMime(picked.name, picked.mime);
        if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
          pendingAttachmentUrisRef.current.delete(durableUri);
          syncProtectedAttachmentUris();
          deleteLocalVideo(durableUri);
          return;
        }
        setAttachments(list => {
          const next = [...list, {
            id: `${Date.now()}-${list.length}`,
            kind: 'video',
            name: picked.name,
            uri: durableUri,
            mime: videoMime,
            size,
            width: Number(picked.width) || 0,
            height: Number(picked.height) || 0,
          }];
          attachmentsRef.current = next;
          return next;
        });
        pendingAttachmentUrisRef.current.delete(durableUri);
        syncProtectedAttachmentUris();
        return;
      }
       if (!isImage(picked.name, picked.mime)) {
         deleteTemporaryImage(picked.uri);
         Alert.alert(t('chat.attach.unsupported.title'), t('chat.attach.unsupported.imageOnly'));
         return;
       }
       if (!isVisionImage(picked.name, picked.mime)) {
         deleteTemporaryImage(picked.uri);
         Alert.alert(t('chat.attach.imageFormat.title'), t('chat.attach.imageFormat.body'));
         return;
       }
       const fileInfo = await getImageFileInfo(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (!fileInfo.exists) throw new Error(t('chat.attach.imageMissing'));
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
        Alert.alert(t('chat.attach.image.tooMany.title'), t('chat.attach.image.tooMany.body', { count: MAX_IMAGE_ATTACHMENTS }));
        return;
      }
      const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
        getApiConfigs(),
        getLocalModelSettings().catch(() => null),
        getActiveLocalModel().catch(() => null),
      ]);
      const current = configs.find(item => item.id === activeId) || configs[0];
      const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
      const imageCaps = current ? capabilitiesForModel(current, getActiveModel(current)) : null;
      if (!(imageCaps && imageCaps.supportsVision === true) && !localMedia.vision) {
        deleteTemporaryImage(picked.uri);
        Alert.alert(t('chat.attach.visionUnsupported.title'), t('chat.attach.visionUnsupported.body'));
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
      if (error && error.code === 'ENCODING') {
        Alert.alert(
          t('chat.attach.encoding.title'),
          t('chat.attach.encoding.body')
        );
      } else {
        Alert.alert(
          t('chat.attach.readFail.title'),
          ['文件过大', '图片过大', '图片分辨率过大', '图片总大小过大'].includes(error && error.message)
            ? t('chat.attach.readFail.tooLarge')
            : t('common.error.retry')
        );
      }
     } finally {
       attachmentPickerLockRef.current = false;
       setAttachmentLoading(false);
     }
   }, [attachmentLoading, captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, messageSelectionOpen, ready, sessionTransitionPending, syncProtectedAttachmentUris, t]);

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
    Alert.alert(t('chat.deleteImage.title'), t('chat.deleteImage.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
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
  }, [characterId, removeVectorIndexForMessage, t]);

  const confirmStickerName = useCallback(async () => {
    if (stickerSaveLockRef.current) return;
    const source = stickerNamePrompt;
    const name = String(stickerNameDraft || '').trim();
     if (!source || !name) {
       if (source) Alert.alert(t('chat.sticker.nameRequired.title'), t('chat.sticker.nameRequired.body'));
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
      Alert.alert(t('chat.sticker.saveFail.title'), (error && error.message) || t('common.error.retryLater'));
     } finally {
       if (sourceConsumed && source && source.uri) deleteTemporaryImage(source.uri);
       stickerSaveLockRef.current = false;
       setStickerSaving(false);
     }
  }, [deleteStickerImage, deleteTemporaryImage, saveSticker, stickerNameDraft, stickerNamePrompt, t]);

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
        Alert.alert(t('chat.attach.unsupported.title'), t('chat.attach.unsupported.pickImage'));
        return;
      }
      const fileInfo = await getImageFileInfo(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (!fileInfo.exists) throw new Error(t('chat.attach.imageMissing'));
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
      Alert.alert(t('chat.pickImage.fail.title'), (error && error.message) || t('common.error.retry'));
    } finally {
      stickerPickerLockRef.current = false;
    }
  }, [captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, openStickerNamePrompt, sessionTransitionPending, stickerSaving, t]);

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
        if (!fileInfo.exists) throw new Error(t('chat.attach.imageMissing'));
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
       if (!cancelled) Alert.alert(t('chat.pickImage.fail.title'), (error && error.message) || t('common.error.retry'));
     }).finally(() => {
      stickerPickerLockRef.current = false;
    });
    return () => {
      cancelled = true;
      stickerPickerLockRef.current = false;
    };
  }, [captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, openStickerNamePrompt, ready, sessionTransitionPending, stickerNamePrompt, stickerSaving, t]);

  const saveImage = useCallback(async image => {
    if (!image || !image.uri) return;
    try {
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (!available) throw new Error(t('chat.saveImage.unsupported'));
      await Sharing.shareAsync(String(image.uri), {
        mimeType: String(image.mime || 'image/jpeg'),
        dialogTitle: t('chat.saveImage.dialogTitle'),
        UTI: 'public.image',
      });
    } catch (error) {
      Alert.alert(t('chat.saveImage.fail.title'), (error && error.message) || t('common.error.retryLater'));
    }
  }, [t]);

  const openImageActions = useCallback((image, messageId) => {
    if (!image || !image.uri) return;
    // 长按是隐藏手势，这里是媒体消息的第二入口；菜单项与气泡「⋯」保持一致
    // （含「引用」——媒体消息的引用走 buildQuotePayload 的占位文本）。
    const target = messagesRef.current.find(item => item && item.id === messageId);
    Alert.alert(t('chat.imageActions.title'), image.stickerName ? t('chat.imageActions.stickerTitle', { name: image.stickerName }) : t('chat.imageActions.choose'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.save'), onPress: () => saveImage(image) },
      { text: t('chat.imageActions.saveAsSticker'), onPress: () => openStickerNamePrompt(image) },
      ...(target ? [{ text: t('chat.imageActions.quote'), onPress: () => onQuoteMessage(target) }] : []),
      { text: t('chat.deleteMessages.title'), style: 'destructive', onPress: () => confirmDeleteImageMessage(messageId) },
    ]);
  }, [confirmDeleteImageMessage, onQuoteMessage, openStickerNamePrompt, saveImage, t]);

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
      Alert.alert(t('chat.sticker.sendFail.title'), (error && error.message) || t('common.error.retryLater'));
    }
  }, [captureSessionGuard, input, isSending, isSessionGuardCurrent, isSwitching, messageSelectionOpen, ready, sendMessage, sessionTransitionPending, t]);

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
    // 压缩指令（compact / /compact）：不发送文本，直接总结当前会话入记忆。
    if (COMPACT_COMMAND_PATTERN.test(text) && attachments.length === 0) {
      setInput('');
      runCompactCommand().catch(() => {});
      return;
    }
    if (!isGroupRef.current && !greetingReady) {
      openGreetingPicker(activeSessionId ? 'reselect' : 'new');
      return;
    }
     await sendText(input);
   }, [activeSessionId, attachments.length, greetingReady, input, isSending, isSwitching, messageSelectionOpen, openGreetingPicker, ready, runCompactCommand, sendText, sessionTransitionPending]);

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
      Alert.alert(t('chat.voice.startFail.title'), maskSecrets((error && error.message) || t('chat.voice.startFail.body')));
    }
  }, [voiceEnabled, isSending, isSwitching, messageSelectionOpen, voiceBusy, greetingReady, activeSessionId, openGreetingPicker, recorder, t]);

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
      Alert.alert(t('chat.voice.recordFail.title'), maskSecrets((error && error.message) || t('common.error.retry')));
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
          t('chat.voice.noTranscription.title'),
          t('chat.voice.noTranscription.body')
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
              t('chat.voice.unsupported.title'),
              t('chat.voice.unsupported.body')
            );
          } else {
            // 网络类/其他失败：明确告知（角色收不到文字的根因可见），本条按占位发送。
            recordDiagnostic('api', error, 'voice-transcribe');
            Alert.alert(
              t('chat.voice.transcribeFail.title'),
              t('chat.voice.transcribeFail.body', { reason: String((error && error.message) || t('chat.voice.unknownReason')) })
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
  }, [voiceBusy, recorder, captureSessionGuard, isSessionGuardCurrent, sendMessage, t]);


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
    ? (activeSession?.name || groupCharacters.map(item => item.name).join('、') || t('common.groupChat'))
    : (sessionOwnerMissing ? t('chat.displayName.missingOwner') : (character.name || t('chat.displayName.defaultAssistant')));
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

  // 本会话统计：打开时按当前会话 id 读累计数据（失败不打断，显示空面板）。
  const openSessionStats = useCallback(async () => {
    const sessionId = String(activeSessionIdRef.current || '');
    if (!sessionId) {
      setStatsSummary(summarizeStats(null));
      setStatsOpen(true);
      return;
    }
    try {
      const stats = await getSessionStats(sessionId);
      setStatsSummary(summarizeStats(stats));
    } catch (error) {
      setStatsSummary(summarizeStats(null));
    }
    setStatsOpen(true);
  }, []);

  const clearSessionStatsForActive = useCallback(() => {
    const sessionId = String(activeSessionIdRef.current || '');
    Alert.alert(
      t('chat.stats.clearConfirm.title'),
      t('chat.stats.clearConfirm.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chat.stats.clearConfirm.confirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await clearSessionStats(sessionId);
            } catch (error) {}
            setStatsSummary(summarizeStats(null));
          },
        },
      ]
    );
  }, [t]);

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
        onForgeCard={openCardFromSelection}
        onOpenSwitcher={() => setSwitcherOpen(true)}
        loaded={loaded}
        isGroup={isGroup}
        groupAvatarUri={groupAvatarUri}
        characterAvatarUri={character.avatarUri}
        displayName={displayName}
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
        onSaveImage={ saveImage }
        onSaveAsSticker={ openStickerNamePrompt }
        onDeleteImageMessage={ confirmDeleteImageMessage }
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
        branchesByFork={ branchesByFork }
        onCheckoutBranch={ onCheckoutBranch }
        onDeleteBranch={ onDeleteBranch }
      />

      {modelLoadProgress != null ? (
        <View style={styles.modelLoadBanner} accessibilityLabel={t('chat.modelLoad.progress', { progress: modelLoadProgress })}>
          <Text style={styles.modelLoadText}>{t('chat.modelLoad.progress', { progress: modelLoadProgress })}</Text>
          <View style={styles.modelLoadTrack}>
            <View style={[styles.modelLoadFill, { width: `${modelLoadProgress}%` }]} />
          </View>
        </View>
      ) : null}

      <EngineStatusBar
        enabled={localEngine.enabled}
        activeModelId={localEngine.activeModelId}
        activeModelName={localEngine.activeModelName}
        fallbackAt={localEngine.fallbackAt}
        onOpenHub={() => setModelPanelOpen(true)}
      />

      {/* E2：上下文占用 ≥70% 的「建议压缩」提示条——一键压缩或关掉（本次进入会话
          内不再出现）；85% 时后台会静默自动压缩（可在系统设置关闭）。 */}
      {contextUsageRatio >= 0.7 && !compactHintDismissed ? (
        <View style={styles.compactHintBar}>
          <Ionicons
            name="information-circle-outline"
            size={15}
            color={theme.colors.primary}
            style={styles.compactHintIcon}
          />
          <Text style={styles.compactHintText} numberOfLines={1}>
            {t('chat.compact.hint', { percent: Math.round(contextUsageRatio * 100) })}
          </Text>
          <TouchableOpacity
            onPress={() => { if (!compactBusy) handleCompactSession(); }}
            accessibilityRole="button"
          >
            <Text style={styles.compactHintAction}>
              {compactBusy ? t('chat.settings.compactBusy') : t('chat.compact.action')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.compactHintClose}
            onPress={() => setCompactHintDismissed(true)}
            accessibilityLabel={t('chat.compact.dismiss')}
          >
            <Ionicons name="close" size={14} color={theme.colors.textFaint} />
          </TouchableOpacity>
        </View>
      ) : null}

      <RunningRunsBar
        activeSessionId={activeSessionId}
        characters={characters}
        onOpen={onOpenRunning}
        onStop={onStopRunning}
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
          // @ 自动提及：光标前紧邻 @ 即弹面板（仅群聊；输入法补全的 @ 同样命中）
          const cursor = event.nativeEvent.selection ? event.nativeEvent.selection.start : 0;
          if (shouldOpenMentionAtCursor({ text: input, cursor, isGroup: isGroupRef.current })) {
            setMentionPickerOpen(true);
          }
        }}
        onOpenSticker={() => setStickerPanelOpen(true)}
        onOpenFullScreen={openFullScreen}
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
        videoEnabled={attachmentVideoEnabled}
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

      {/* 新对话迁入「更多」菜单：单聊需确认（群聊 onNewChat 内部已有确认） */}
      <MoreMenuModal
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        items={[
          // 会话：高频动作与上下文操作（新对话置顶，破坏性操作带红色与确认）
          {
            key: 'new-chat',
            section: t('chat.menu.section.chat'),
            label: t('chat.menu.newChat'),
            icon: 'chatbox-ellipses-outline',
            danger: true,
            disabled: isSending || !ready,
            onPress: onNewChatFromMenu,
          },
          {
            key: 'search',
            section: t('chat.menu.section.chat'),
            label: t('chat.menu.search'),
            icon: 'search',
            active: searchOpen,
            onPress: () => (searchOpen ? closeSearch() : setSearchOpen(true)),
          },
          {
            key: 'summary',
            section: t('chat.menu.section.chat'),
            label: summarizing ? t('chat.menu.summarizing') : t('chat.menu.summary'),
            icon: 'book-outline',
            disabled: summarizing || !ready,
            onPress: onSummarize,
          },
          {
            key: 'scrubber',
            section: t('chat.menu.section.chat'),
            label: t('chat.menu.scrubber'),
            icon: 'options-outline',
            disabled: scrubberMessages.length === 0,
            onPress: () => setScrubberOpen(true),
          },
          {
            key: 'fullscreen',
            section: t('chat.menu.section.chat'),
            label: t('chat.menu.fullscreen'),
            icon: 'expand-outline',
            disabled: !ready || sessionOwnerMissing || (!isGroup && !greetingReady),
            onPress: openFullScreen,
          },
          {
            key: 'export',
            section: t('chat.menu.section.chat'),
            label: t('chat.menu.export'),
            icon: 'share-outline',
            disabled: !ready || messages.length === 0,
            onPress: () => setExportOpen(true),
          },
          // 角色与模型：编辑角色/群聊提升为一等公民（原藏在「设置」二级弹层）
          {
            key: 'edit-role',
            section: t('chat.menu.section.roleModel'),
            label: isGroup ? t('chat.editGroup') : t('chat.editCharacter'),
            icon: 'create-outline',
            onPress: () => (isGroup ? setGroupEditOpen(true) : setCharacterEditOpen(true)),
          },
          {
            key: 'model',
            section: t('chat.menu.section.roleModel'),
            label: t('chat.menu.model'),
            icon: 'cube-outline',
            onPress: openModelPanel,
          },
          {
            key: 'thinking',
            section: t('chat.menu.section.roleModel'),
            label: t('chat.menu.thinking'),
            icon: 'bulb-outline',
            onPress: openThinkingPanel,
          },
          {
            key: 'voice',
            section: t('chat.menu.section.roleModel'),
            label: t('chat.menu.voice'),
            icon: 'volume-high-outline',
            onPress: () => setVoiceSettingsOpen(true),
          },
          // 其他：低频与系统入口
          {
            key: 'memory-provenance',
            section: t('chat.menu.section.other'),
            label: t('chat.menu.memoryProvenance'),
            icon: 'git-network-outline',
            disabled: !characterId,
            onPress: () => setMemoryProvenanceOpen(true),
          },
          {
            key: 'session-stats',
            section: t('chat.menu.section.other'),
            label: t('chat.menu.sessionStats'),
            icon: 'stats-chart-outline',
            onPress: openSessionStats,
          },
          {
            key: 'notice',
            section: t('chat.menu.section.other'),
            label: t('chat.menu.notice'),
            icon: 'megaphone-outline',
            onPress: () => setNoticeOpen(true),
          },
          {
            key: 'local-logs',
            section: t('chat.menu.section.other'),
            label: t('chat.menu.localLogs'),
            icon: 'document-text-outline',
            onPress: () => setHubOpen(true),
          },
          {
            key: 'settings',
            section: t('chat.menu.section.other'),
            label: t('chat.menu.settings'),
            icon: 'settings-outline',
            onPress: () => setChatSettingsOpen(true),
          },
        ]}
      />

      <SessionStatsModal
        visible={statsOpen}
        onClose={() => setStatsOpen(false)}
        summary={statsSummary}
        messageCount={messages.filter(item => item && !item.transient).length}
        onClear={clearSessionStatsForActive}
      />

<ConversationExportModal
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        messages={messages}
        title={displayName}
        characterName={String(character.name || '')}
        userName={String(userNameRef.current || '')}
        isGroup={isGroup}
      />

      <ConversationCardModal
        visible={cardFromChatOpen}
        onClose={() => setCardFromChatOpen(false)}
        messages={selectedMessagesForCard}
        characterName={String(character.name || '')}
        userName={String(userNameRef.current || '')}
      />

      <MemoryProvenanceModal
        visible={memoryProvenanceOpen}
        onClose={() => setMemoryProvenanceOpen(false)}
        characterId={characterId}
        characterName={String(character.name || '')}
        sessions={sessions}
      />

      <ChatSettingsModal
        visible={chatSettingsOpen}
        onClose={() => setChatSettingsOpen(false)}
        onOpenSystemSettings={() => { if (navigation) navigation.navigate(ROUTE_NAMES.settings); }}
        editLabel={isGroup ? t('chat.editGroup') : t('chat.editCharacter')}
        onOpenEditor={() => {
          if (isGroup) setGroupEditOpen(true);
          else setCharacterEditOpen(true);
        }}
        compactInfo={compactInfo}
        compactBusy={compactBusy}
        onCompactSession={handleCompactSession}
      />

      <VoiceSettingsModal
        visible={voiceSettingsOpen}
        onClose={() => setVoiceSettingsOpen(false)}
        autoBroadcast={ttsSettings.autoBroadcast}
        onToggleBroadcast={toggleBroadcast}
        voiceMode={!isGroup && character.voiceDisplay === 'voice'}
        onToggleVoiceMode={() => {
          if (isGroup || !characterId) return;
          const next = character.voiceDisplay === 'voice' ? 'text' : 'voice';
          updateCharacter({ id: characterId, voiceDisplay: next }).catch(() => {
            Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
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
          Alert.alert(t('chat.saved.title'), t('chat.saved.character'));
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
          Alert.alert(t('chat.saved.title'), t('chat.saved.group'));
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
        title={t('chat.menu.notice')}
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
        onSelectLocalModel={selectLocalModel}
        onManageLocalModels={() => { setModelPanelOpen(false); setHubOpen(true); }}
      />

      <LocalModelPanel visible={hubOpen} onClose={() => setHubOpen(false)} />

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
