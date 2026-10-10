// 从 ChatScreen.js 原样外提（无行为变化）：回复发送编排。
// 单聊 requestReply（插件/向量/摘要上下文组装、本地与在线双路发送、流式增量、
// 错误分类落盘）、群聊 requestGroupReply（成员资料、逐角色与合议两种模式）、
// performSendMessage（附件校验/媒体消息构造/草稿清空与失败回滚）、
// regenerateMessage（撤回复重生成与记忆摘要失效）、editUserMessage（修改重发）。
// 纯逻辑已下沉 src/chat/replyFlow.js；此处仅剩编排壳。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

import {
  ASSISTANT_ID,
  THINKING_PLACEHOLDER,
  USER_ID,
} from './chatConstants.js';
import {
  getConfigFingerprint,
  isCanceledError,
  isConfigChangedError,
  sendChatMessage,
} from '../network/api.js';
import { buildRequestMessages, filterRequestMedia } from '../prompt/chatPipeline.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { isStaleReply } from './chatRace.js';
import { getEditResendPlan } from './messageSelection.js';
import { canUseLocalModel, sendWithModelProvider } from '../network/modelProvider.js';
import { listToolsForMode } from '../agent/tools/registry.js';
import { runAgentTurn, workspaceRoundBudget } from '../agent/loop.js';
// I1：Steering 队列（运行中补充指令）——纯函数工厂，队列本身只在「本轮会跑工具循环」时建。
import { createSteeringQueue } from '../agent/steering.js';
import { registerChatTools, unregisterChatTools } from './chatTools.js';
import { TOOL_BUBBLE_KIND } from './chatConstants.js';
import { approveToolCall } from './toolApprovalFlow.js';
import { createWorkspaceStore, registerDefaultWorkspaceTools } from '../workspace/native.js';
import { persistToolResult } from '../workspace/taskOutputs.js';
import {
  buildHookContextText,
  collectPromptHooks,
  collectSessionStartNotices,
  collectTurnEndNotices,
  hookPermissionRules,
  readWorkspaceHooks,
} from '../workspace/hooks.js';
import { ensureMcpToolsRegistered } from '../workspace/mcpTools.js';
import { getLocalModelMediaCapabilities } from '../localModel/modelState.js';
import {
  ATTACH_ERROR,
  getImageDimensions,
  getImageFileInfo,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_BYTES,
  MAX_VIDEO_ATTACHMENTS,
  MAX_VIDEO_BASE64_BYTES,
  MAX_VIDEO_BYTES,
  mergeTextAttachments,
  readImageDataUri,
  readVideoDataUri,
  validateImageBatch,
  validateVideoSize,
} from './attachments.js';
import { createMediaMessage, getMessagePromptText, STICKER_MESSAGE_KIND } from './chatMedia.js';
import { createVoiceMessage } from './voiceMessages.js';
import { createRequestMeter, estimatePromptTokens, estimateReplyTokens } from './sessionStats.js';
import { recordSessionRequest } from '../storage/sessionStats.js';
import { stop as ttsStop } from '../tts/index.js';
import { maskSecrets } from '../storage/secrets.js';
import { resolveStickerNames } from './stickerDirectives.js';
import { buildTimeAwareText } from './currentTime.js';
import { buildSchedulePrompt, isScheduleActive } from './schedule.js';
import { getCharacterSchedule } from '../storage/schedule.js';
import { saveSessionPlan } from '../storage/sessionPlan.js';
import { recordDiagnostic } from '../storage/diagnostics.js';
// N1：reactive 回退——API 报上下文超限时压缩历史（本批接线为「压缩 + 提示重发」；
// 自动重试需发送流程重构，见 reactiveCompact 注释）。
import { REACTIVE_FAILED_MESSAGE, isContextOverflowError, runReactiveCompact } from './reactiveCompact.js';
// P5：工具轨迹持久化（把本轮 tool 消息挂在助手终稿上，供跨轮 K1/N2 使用）。
import { attachToolTrace, extractToolTrace } from './toolTrace.js';
import { buildLocationText, placeToLocation, resolveActivePlace } from '../location/geo.js';
import { settlePendingMessage } from './chatHelpers.js';
import {
  buildContextBreakdown,
  estimateHistoryTokens,
  estimateTextTokens,
} from './contextUsage.js';
import {
  buildAutoSummaryInput,
  buildReplyErrorMessage,
  classifyReplyError,
  mergeErrorMessage,
  mergeStreamedReasoning,
  mergeStreamedText,
  replacePendingWithReply,
  trimHistoryByBoundary,
} from './replyFlow.js';
import {
  buildEnsemblePrompt,
  buildGroupRequest,
  ensureMemberProfiles,
  hasEveryoneMention,
  mergeAdjacentSegments,
  parseEnsembleReply,
  parseMentions,
  selectSpeakers,
  ENSEMBLE_MODE,
} from './groupChat.js';
import { buildMemoryContext, retrieve } from '../vectorMemory/index.js';
import { getVectorOwnerId } from '../vectorMemory/scope.js';
import {
  buildMemorySummaryText,
  invalidateHistorySummaries,
  isBuiltinAssistant,
  isSessionScopedMemory,
  planMemoryBudget,
} from '../memory/memorySummary.js';
import { getActiveLocalModel, getLocalModelSettings } from '../storage/localModels.js';
import { capabilitiesForModel, getApiConfigs, getActiveModel } from '../storage/apiConfigs.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import { getEnabledPlugins } from '../storage/settings.js';
import { getUserProfile } from '../storage/personas.js';
import { getLocationSettings } from '../storage/location.js';
import {
  getSessionSummaries,
  markSessionModel,
  saveMessagesBySession,
  updateSessionMemberProfiles,
} from '../storage/sessions.js';
import {
  getVectorIndex,
  getVectorMemoryConfig,
  removeVectorIndexForSession,
} from '../storage/vector.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { getChatOptions } from '../storage/settings/chatOptions.js';
import { getLocalModelFileInfo } from '../localModel/modelManager.js';
import { runPlugins } from '../plugins/registry.js';
import { archiveBranch } from '../storage/sessionBranches.js';

// 发送流程内部哨兵错误：只用于 catch 里分流提示，不直接展示给用户；
// 用 code 判等而不是文案（用户可见文案走 i18n，随语言变化，不能当判等依据）。
const SEND_ERROR = {
  IMAGE_MISSING: 'send-image-missing',
  IMAGE_TOTAL_TOO_LARGE: 'send-image-total-too-large',
  VIDEO_MISSING: 'send-video-missing',
  VIDEO_TOTAL_TOO_LARGE: 'send-video-total-too-large',
};
const sendError = code => {
  const error = new Error(code);
  error.code = code;
  return error;
};

// 后台完成（用户已切走，回复不再是「当前会话」）时把这一轮结果写回**它自己的会话**。
// 用整体覆盖写盘：该会话此刻被它自己的运行锁着，没有并发写者，保证「用户消息 + 回复」
// 顺序与内容完整（只保留非 pending 项）。写盘失败不抛——主链路已经拿到回复，丢一次
// 落盘不该把界面变成错误态。
async function persistBackgroundReply({ sessionId, messages, ownerCharacterId }) {
  const id = String(sessionId || '');
  const finalMessages = (Array.isArray(messages) ? messages : []).filter(item => item && !item.pending);
  if (!id || finalMessages.length === 0) return;
  try {
    await saveMessagesBySession(id, finalMessages, String(ownerCharacterId || ''), []);
  } catch (error) {
    if (__DEV__) console.warn('[runtime] background reply persist failed', error);
  }
}

export default function useChatSend({
  // 守卫（来自 useSessionGuard）
    beginSendOperation,
    endSendOperation,
    captureSessionGuard,
    isSessionGuardCurrent,
    sendLockRef,
    abortRef,
    sourceChangedRef,
    sessionVersionRef,
    openingRequestRef,
  // 状态值
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
  // ref
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
  // 回调与 setter
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
}) {
  // 翻译在 hook 顶层取，经 ref 传给 requestReply：requestReply 是空依赖 useCallback，
  // 直接闭包 t 会在切换语言后继续用旧语言；ref 保证取到当前语言。
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  // 本地模型首次加载进度（0-100）：本地路径首条消息会在推理前 mmap 数 GB 权重，
  // 期间「正在思考」看不出是在加载。null = 未在加载（在线路径或无本地模型）。
  const [modelLoadProgress, setModelLoadProgress] = useState(null);
  // P0-7 降级链提示：本次发送中途换过模型时，如实告诉用户「已切换到 X」。
  // 静默换模型会让用户把另一个模型的回复当成主模型的产出。null = 本次没换过。
  const [modelFallbackNotice, setModelFallbackNotice] = useState(null);
  // I1：Steering——本轮工具循环运行中，用户补充的指令入队，loop 在下一轮请求前注入。
  // 只有**真的会跑工具循环**时才有队列（单次请求没有「下一轮」可注入，收了等于吞掉
  // 用户打的字，判定见 chat/steeringSend.js）。
  const steeringRef = useRef(null);
  const [steeringAvailable, setSteeringAvailable] = useState(false);
  const [steeringNote, setSteeringNote] = useState('');
  // P0-8：hooks.json 的注入类事件——session_start 每个会话只注入一次（内存记账），
  // after_turn 的提醒排队给下一轮。两者都只在本次运行内有效（重启即丢，不写盘）。
  const hookSessionInjectedRef = useRef(new Set());
  const pendingHookNoticesRef = useRef([]);
  // P2-7：上下文占用明细（按本次真实发出的请求分段测量；null = 还没发过请求）。
  const [contextBreakdown, setContextBreakdown] = useState(null);
  // 分支变更计数：撤回归档 / 切换 / 删除分支后自增，驱动 UI 重新读取分支索引。
  const [branchesRefreshToken, setBranchesRefreshToken] = useState(0);
  const bumpBranchesRefresh = useCallback(() => {
    setBranchesRefreshToken(token => token + 1);
  }, []);
  // 归档被撤回的尾段。失败不阻断撤回主链路（仅开发告警），成功则通知 UI 刷新。
  const archiveActiveTail = useCallback(async (sessionId, forkMessageId, tail) => {
    if (!Array.isArray(tail) || tail.length === 0) return;
    try {
      const descriptor = await archiveBranch(sessionId, forkMessageId, tail);
      if (descriptor) bumpBranchesRefresh();
    } catch (error) {
      if (__DEV__) console.warn('[branch] archive failed', error);
    }
  }, [bumpBranchesRefresh]);
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
     // 工具过程气泡：由 onToolEvent 驱动，临时消息（不落库、不进上下文）。
     // 同一个气泡对象原地更新状态（running → done/error），不逐轮堆叠。
     const toolStatusId = `${Date.now()}-tool-bubble`;
     const clearToolBubble = () => {
       if (!isCurrentSession()) return;
       setMessages(current => (
         isCurrentSession() ? current.filter(item => item.id !== toolStatusId) : current
       ));
     };
     const setToolBubble = (name, status, error = '') => {
       if (!isCurrentSession()) return;
       setMessages(current => {
         if (!isCurrentSession()) return current;
         const without = current.filter(item => item.id !== toolStatusId);
         if (!name || !status) return without;
         return [...without, {
           id: toolStatusId,
           role: ASSISTANT_ID,
           text: '',
           kind: TOOL_BUBBLE_KIND,
           toolName: name,
           toolStatus: status,
           toolError: error,
           pending: true,
           transient: true,
           timestamp: Date.now(),
         }];
       });
     };
     // P0-7：降级链中途换了模型 → 记下「从谁换到谁」，由 ChatScreen 在输入栏上方
     // 如实提示（不弹框、不打断生成）。只记当前会话：切走后旧会话的提示不该跟过来。
     const noteModelFallback = info => {
       if (!isCurrentSession()) return;
       const to = String((info && info.to) || '');
       if (!to) return;
       setModelFallbackNotice({ from: String((info && info.from) || ''), to });
     };
     // 工作区模式（ask/read/write）：决定在线路径是否走 agent 工具循环。
     // 读取失败按默认 ask 处理（零行为变化，绝不因设置读失败而改变发送行为）。
     let workspaceMode = 'ask';
     let workspaceSettings = null;
     try {
       workspaceSettings = await getWorkspaceSettings();
       workspaceMode = (workspaceSettings && workspaceSettings.mode) || 'ask';
     } catch (error) {
       workspaceMode = 'ask';
     }
     // P0-8：提交前钩子（before_prompt）与上下文注入（session_start / 上一轮的 after_turn）。
     // 放在**建消息之前**：拦下时不留下任何 pending 气泡（一次脏状态都不产生）。
     // 钩子读失败一律当没有钩子——声明式扩展绝不能成为发送链路的故障源。
     let hookContextText = '';
     try {
       const hookStore = createWorkspaceStore(workspaceSettings);
       const hooks = await readWorkspaceHooks(hookStore, character.id);
       const promptHooks = collectPromptHooks(hooks, userText);
       if (promptHooks.blocks.length > 0) {
         Alert.alert(tRef.current('chat.hooks.blocked.title'), promptHooks.blocks.join('\n'));
         return false;
       }
       const sessionId = String(sendSessionId || '');
       const sessionNotices = sessionId && !hookSessionInjectedRef.current.has(sessionId)
         ? collectSessionStartNotices(hooks)
         : [];
       if (sessionNotices.length > 0 && sessionId) hookSessionInjectedRef.current.add(sessionId);
       hookContextText = buildHookContextText([
         ...pendingHookNoticesRef.current,
         ...sessionNotices,
         ...promptHooks.notices,
       ]);
       // 本轮结束后要提醒的（after_turn）排队给下一次请求：本轮读到的快照即依据，
       // 队列只在内存里（重启即丢——不写盘、不假装持久）。
       pendingHookNoticesRef.current = collectTurnEndNotices(hooks);
     } catch (error) {}
     const pendingAssistantMessage = {
      id: `${Date.now()}-assistant`,
      role: ASSISTANT_ID,
      text: THINKING_PLACEHOLDER,
      reasoning: '',
      pending: true,
      waitingForResponse: true,
      timestamp: Date.now(),
    };
    // 本会话统计打点：声明在 try 之外（catch 的失败/取消分支也要记账），
    // 真正赋值在请求发出前；未赋值时是空操作。异常一律吞掉——统计绝不能影响聊天主链路。
    let recordStats = () => {};

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
          Alert.alert(tRef.current('chat.send.webSearchFailed.title'), maskSecrets((error && error.message) || tRef.current('chat.send.webSearchFailed.body')));
        },
      });
      const currentSession = sessionsRef.current.find(
        session => session.id === sendSessionId
      );
      const boundary = currentSession && currentSession.summarizedUpTo;
      // 已经作为原文发送的历史（boundary 之后）不再由向量重复召回；被摘要裁剪掉
      // 的更早区间和其它会话才交给向量，避免同一内容既当原文又当“相关记忆”。
      const { trimmedHistory, sentIds } = trimHistoryByBoundary(historyMessages, boundary);
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
        // 注入必须跟随「会话所属角色」，不能用当前活跃角色：切换角色的过渡窗口里二者会
        // 不一致，用活跃角色会把它的世界书记忆塞进别的会话（写入侧口径见 runSummarize）。
        const sessionCharacter = (Array.isArray(characters) ? characters : [])
          .find(item => item.id === sessionCharacterId) || character;
        const characterExists = (Array.isArray(characters) ? characters : [])
          .some(item => item.id === sessionCharacterId);
        // 读取作用域：单会话角色继续带上已有世界书记忆（不做迁移/丢弃），
        // 多会话角色只读本会话。写入侧的降级见 runSummarize，两者解耦。
        // 内置助手一律按会话级（它卡上的「记忆总结」可能是兜底归属沉淀来的），
        // 并把当前会话计入判定，避免新建的第二个会话被当成单会话角色。
        const scoped = isBuiltinAssistant(sessionCharacter)
          || !characterExists
          || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, undefined, sendSessionId);
        const sessionSummaries = await getSessionSummaries(sendSessionId);
        summaryText = buildMemorySummaryText(
          sessionCharacter,
          sessionSummaries,
          scoped,
          memoryBudget.summaryMaxChars
        );
      } catch (error) {
        summaryText = '';
      }
       // 位置注入（双开关门控）：位置分享（enabled）与位置感知（awareness）都开启时，
       // 注入「[当前位置] …」——内容就是当前选中的那条自写位置（点选即用，一次一个）。
       // 任一关闭 = 空串——位置感知是独立 opt-in，不给「开地图即默认分享」留后门。
       // maxAgeMs: null —— 手写位置没有「取点时间」，不该按定位时效判过期。
       let locationLine = '';
       try {
         const locationSettings = await getLocationSettings();
         locationLine = buildLocationText(
           locationSettings && locationSettings.enabled === true && locationSettings.awareness === true,
           placeToLocation(resolveActivePlace(locationSettings)),
           { maxAgeMs: null }
         );
       } catch (error) {
         locationLine = '';
       }
       // 角色作息：读取会话所属角色的作息；启用时注入静态作息规则，并附带当前时间
       // （规则要靠当前时间判断时段，故启用作息即附带时间，与全局 timeAware 解耦）。
       let scheduleText = '';
       let scheduleActive = false;
       try {
         const scheduleCharacterId = String(
           (currentSession && currentSession.characterId) || character.id || ''
         );
         const schedule = scheduleCharacterId ? await getCharacterSchedule(scheduleCharacterId) : null;
         if (isScheduleActive(schedule)) {
           scheduleText = buildSchedulePrompt(schedule);
           scheduleActive = true;
         }
       } catch (error) {
         scheduleText = '';
         scheduleActive = false;
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
         // 时间感知开启（或角色作息启用）时附上当前时间（每次请求现算，保证准确）。
         currentTimeText: buildTimeAwareText(chatOptionsRef.current.timeAware || scheduleActive),
         // 角色作息启用时附上作息规则（含「按当前时间判断状态」）。
         scheduleText,
         // 真实位置开启且存在最近位置时附上位置行。
         locationText: locationLine,
         // P0-8：hooks.json 的注入类事件（session_start / after_turn / before_prompt）。
         extraSystemPrompt: hookContextText || undefined,
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
        // P2：本地媒体裁剪能力抽出来——reactive 压缩后重试要按同一口径重算消息。
        const localMedia = {
          allowVision: Boolean(localSettings && localSettings.enableMediaInput && localItem && localItem.hasVision),
          allowAudio: Boolean(localSettings && localSettings.enableMediaInput && localItem && localItem.hasAudio),
        };
        let localMessages = localReady
          ? filterRequestMedia(requestMessages, localMedia)
          : requestMessages;
        // 本地模型可以拥有独立的 mmproj 能力；本地失败回退在线时，必须按在线配置
        // 单独裁剪媒体，避免把图片/音频发给不支持多模态的在线端点。
        let onlineMedia = { allowVision: false, allowAudio: false };
        let onlineModelName = '';
        let onlineConfigLabel = '';
        try {
          const { configs, activeId } = await getApiConfigs();
          const onlineConfig = configs.find(item => item.id === expectedConfigId)
            || configs.find(item => item.id === activeId)
            || configs[0];
          onlineMedia = {
            allowVision: Boolean(onlineConfig && onlineConfig.supportsVision),
            allowAudio: Boolean(onlineConfig && onlineConfig.supportsAudio),
          };
          onlineModelName = onlineConfig ? String(getActiveModel(onlineConfig) || '').trim() : '';
          onlineConfigLabel = onlineConfig ? String(onlineConfig.name || onlineConfig.id || '') : '';
        } catch (error) {}
        let onlineMessages = filterRequestMedia(requestMessages, onlineMedia);
        // 聊天内受控工具（联网搜索）：独立开关，与工作区模式无关——聊天页默认 ask，
        // 若沿用工作区门控则永远不可用。关闭时必须**摘掉注册**（不只是不勾选），
        // 否则执行路径仍能调到它。
        let chatToolsEnabled = false;
        try {
          const chatOptionsForTools = await getChatOptions();
          chatToolsEnabled = chatOptionsForTools.chatTools === true;
        } catch (error) {
          chatToolsEnabled = false;
        }
        try {
          if (chatToolsEnabled) registerChatTools();
          else unregisterChatTools();
        } catch (error) {
          chatToolsEnabled = false;
        }
        // 在线路径按工作区模式分流：ask 不暴露工作区工具，走原 sendChatMessage（零变化）；
        // read/write 走 runAgentTurn（agent 工具循环）。工具集由注册表按模式派生。
        // 聊天内工具在上述任一模式下都可用（由 allowChatTools 单独放行）。
        let agentTools = [];
        // 钩子（hooks.json）读取用的 store：与注册工具那份等价（同一份设置快照派生），
        // 审批回调里读 before_shell 预置禁令用；创建失败当没有钩子（审批照常）。
        let hookStore = null;
        if (workspaceMode !== 'ask') {
          try {
            // O0.3：update_plan 的清单随本会话落盘（键与消息分开），供压缩 recap 恢复。
            registerDefaultWorkspaceTools(workspaceSettings, {
              onPlan: steps => saveSessionPlan(sendSessionId, steps),
            });
          } catch (error) {}
          try {
            hookStore = createWorkspaceStore(workspaceSettings);
          } catch (error) {
            hookStore = null;
          }
          // MCP（通用多服务器，含内置 GitHub）：把风险分级过滤过的工具挂进注册表
          //（未启用/未连接等价于全摘除）；只读工具 read 模式即暴露，写入类走逐条确认。
          try {
            await ensureMcpToolsRegistered();
          } catch (error) {}
        }
        agentTools = listToolsForMode(
          workspaceMode,
          { allowChatTools: chatToolsEnabled }
        );
        // P2-7：上下文占用明细——按**本次真实发出的请求**分段测量（系统提示 / 历史 /
        // 本轮输入 / 工具定义），让用户看到「谁在吃窗口」。系统提示里折了角色设定、
        // 预设、世界书、记忆与钩子注入，这里不假装能拆开（要拆得改请求构造层）。
        try {
          const systemText = requestMessages
            .filter(item => item && item.role === 'system')
            .map(item => (typeof item.content === 'string' ? item.content : ''))
            .join('\n');
          const nonSystem = requestMessages.filter(item => item && item.role !== 'system');
          const inputMessages = nonSystem.slice(-1);
          const historyMessages = nonSystem.slice(0, -1);
          setContextBreakdown(buildContextBreakdown([
            { key: 'system', tokens: estimateTextTokens(systemText) },
            { key: 'history', tokens: estimateHistoryTokens(historyMessages) },
            { key: 'input', tokens: estimateHistoryTokens(inputMessages) },
            ...(agentTools.length > 0
              ? [{ key: 'tools', tokens: estimateTextTokens(JSON.stringify(agentTools)) }]
              : []),
          ], 0));
        } catch (error) {}
        // I1：Steering 队列只在本轮真的会跑工具循环时建（runAgentTurn 才会在轮与轮之间
        // drain）；单次请求没有「下一轮」，收了就是吞掉用户的字。宿主据此决定运行中
        // 发送是「入队」还是「保留输入并说明」。
        const steeringQueue = agentTools.length > 0 ? createSteeringQueue() : null;
        steeringRef.current = steeringQueue;
        setSteeringAvailable(!!steeringQueue);
        setSteeringNote('');
        // token 口径（E1 起）：端点返回 usage 时用**真实值**（含缓存命中数），
        // 不返回时回退估算器（口径与上下文占用一致，服务商之间可比）。
        let resolvedProvider = null;
        // P5：本轮工具轨迹（onTranscript 回抛；挂到助手终稿上持久化）。
        let turnTrace = null;
        const meter = createRequestMeter();
        // E1：本次发送内多次 API 调用（工具轮）的 usage 累加器——每次调用都是真实
        // 计费，累计才是这次发送的真实成本；缓存命中率 = Σcached / Σprompt。
        // 本地模型/不返回 usage 的端点：count 恒为 0，走估算回退（零行为变化）。
        // P0-7/P2-10：`lastModel` 记**真正产出内容**的模型（降级链可能换过模型）——
        // 记账按主模型记会让「这条回复是谁产的」变成假话。
        const usageAcc = { count: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, lastModel: '' };
        recordStats = (completionText, extra = {}) => {
          try {
            const timing = meter.finish();
            const isLocal = Boolean(resolvedProvider && resolvedProvider.kind === 'local');
            recordSessionRequest(sendSessionId, {
              configId: isLocal ? 'local' : (expectedConfigId || 'unknown'),
              configLabel: isLocal
                ? tRef.current('chat.stats.localProvider')
                : (onlineConfigLabel || expectedConfigId || ''),
              model: isLocal
                ? String(resolvedProvider.modelName || '')
                : (usageAcc.lastModel || onlineModelName),
              promptTokens: estimatePromptTokens(requestMessages),
              completionTokens: estimateReplyTokens(completionText || ''),
              // 有真实 usage 就覆盖估算；extra 在其后仍可最终覆盖（失败记账等场景）。
              ...(usageAcc.count > 0 ? {
                promptTokens: usageAcc.promptTokens,
                completionTokens: usageAcc.completionTokens,
                cachedTokens: usageAcc.cachedTokens,
              } : {}),
              firstTokenMs: timing.firstTokenMs,
              generationMs: timing.generationMs,
              at: timing.finishedAt,
              ...extra,
            }).catch(() => {});
          } catch (error) {}
        };
        const onlineSend = () => (agentTools.length > 0
          ? runAgentTurn(onlineMessages, {
              mode: workspaceMode,
              tools: agentTools,
              // I1：Steering 队列（运行中补充指令，每轮请求前注入）。
              ...(steeringQueue ? { steering: steeringQueue } : {}),
              // 轮次预算（A1）：与工作区同款分档（write 16 / read 10；其余默认 12）。
              maxRounds: workspaceRoundBudget(workspaceMode),
              signal: controller.signal,
              // E1：usage 累加（工具轮多轮逐轮累计——每轮都是真实计费）。
              onUsage: entry => {
                usageAcc.count += 1;
                usageAcc.promptTokens += Number(entry && entry.promptTokens) || 0;
                usageAcc.completionTokens += Number(entry && entry.completionTokens) || 0;
                usageAcc.cachedTokens += Number(entry && entry.cachedTokens) || 0;
                // 记「最后一轮真正产出内容」的模型（降级后就是降级模型）。
                if (entry && entry.model) usageAcc.lastModel = String(entry.model);
              },
              requestOptions: {
                expectedConfigId,
                expectedConfigFingerprint,
                stream: chatOptions.stream,
                // P0-7：换模型重试要能提示到用户（经 runAgentTurn 透传给 api.js）。
                onModelFallback: noteModelFallback,
              },
              onToken: fullText => {
                meter.markFirstToken();
                if (!isCurrentSession() || controller.signal.aborted) return;
                setMessages(current => {
                  if (!isCurrentSession()) return current;
                  return mergeStreamedText(current, pendingAssistantMessage.id, fullText);
                });
              },
              onReasoning: fullReasoning => {
                if (!isCurrentSession() || controller.signal.aborted) return;
                setMessages(current => {
                  if (!isCurrentSession()) return current;
                  return mergeStreamedReasoning(current, pendingAssistantMessage.id, fullReasoning);
                });
              },
              onToolEvent: event => {
                // 可见的工具过程气泡：start 时挂出「正在…」，end 时原地改成「完成/失败」。
                // 结束后不立刻清掉——用户要能看到「刚才搜过」，它随本轮结束一起消失
                //（下面 clearToolBubble 在各收尾分支统一调用），且不落库。
                if (!event) return;
                if (event.phase === 'start') setToolBubble(event.name, 'running');
                else if (event.phase === 'end') {
                  setToolBubble(event.name, event.ok === false ? 'error' : 'done', event.error || '');
                }
              },
              // 逐条确认 + 权限规则：这里是唯一能问到用户的出口，所以必须接上——
              // 不接的话 registry 会把需要确认的工具一律拒绝。先查已记住的规则
              //（本次会话 / 永远允许），没命中才弹三选项框。
              // 工作区钩子（hooks.json）的 before_shell 预置禁令在这里注入（每次直读）。
              // 用户在弹框上犹豫多久都不算超时：runTool 把审批放在超时竞速之外。
              onToolApproval: async call => {
                let extraRules = [];
                if (hookStore) {
                  try {
                    const hooks = await readWorkspaceHooks(hookStore, character.id);
                    extraRules = hookPermissionRules(hooks);
                  } catch (error) {}
                }
                return approveToolCall({
                  name: call && call.name,
                  args: call && call.args,
                  t: tRef.current,
                  // 用户点「停止生成」时立刻按拒绝结算，不留悬挂的弹框 Promise。
                  signal: controller.signal,
                  extraRules,
                });
              },
              context: { characterId: character.id, sessionId: sendSessionId },
              allowChatTools: chatToolsEnabled,
              // O1：超限工具结果整份落盘到工作区 .task_outputs/，消息里只留预览 + 指针
              //（模型可按 offset 读回）；无工作区后端（ask / 建 store 失败）则不注入。
              persistToolResult: hookStore
                ? (content, meta) => persistToolResult({
                  store: hookStore,
                  characterId: character.id,
                  toolUseId: meta && meta.toolCallId,
                  content,
                })
                : undefined,
              // P5：本轮 agent 追加消息（含 tool）回抛，提取工具轨迹持久化。
              onTranscript: msgs => { turnTrace = extractToolTrace(msgs); },
            })
          : sendChatMessage(onlineMessages, {
              expectedConfigId,
              expectedConfigFingerprint,
              signal: controller.signal,
           stream: chatOptions.stream,
           onModelFallback: noteModelFallback,
           onChunk: fullText => {
             meter.markFirstToken();
             if (!isCurrentSession() || controller.signal.aborted) return;
             setMessages(current => {
               if (!isCurrentSession()) return current;
               return mergeStreamedText(current, pendingAssistantMessage.id, fullText);
             });
           },
           onReasoning: fullReasoning => {
             if (!isCurrentSession() || controller.signal.aborted) return;
             setMessages(current => {
               if (!isCurrentSession()) return current;
               return mergeStreamedReasoning(current, pendingAssistantMessage.id, fullReasoning);
             });
            }
        }));
        // 路由结果由 provider 回调告知（本地成功=local，回退/未启用=api）：
        // 本地→在线是静默回退，「这次回复是谁产的」只能按真实产出链路标记。
        // P2：上下文超限 → 压缩历史 → 重试一次（对齐 dsh「condense and retry on request-error」）。
        let reply;
        let overflowRetried = false;
        while (true) {
          try {
            reply = await sendWithModelProvider({
          messages: localMessages,
          localSettings,
          localItem,
          localFileInfo,
          signal: controller.signal,
          // 把本轮工具集告诉适配层：本地模型不支持工具调用时会降级为纯对话并留日志。
          // 不透传的话，用户在本地模型下开着聊天内工具会「看不到搜索气泡、也没有任何说明」。
          tools: agentTools,
          onProviderResolved: info => {
            resolvedProvider = info && typeof info === 'object' ? info : null;
          },
          // 会话标识：跨对话时适配器会清 KV cache，避免新对话串进上一段对话。
          conversationKey: String((sessionGuard && sessionGuard.sessionId) || ''),
          // 本地模型加载进度透传：首条消息前 mmap 权重的耗时对用户可见。
          onModelLoadProgress: value => {
            if (!isCurrentSession() || controller.signal.aborted) return;
            const num = Number(value);
            setModelLoadProgress(Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : null);
          },
          onToken: fullText => {
            meter.markFirstToken();
            if (!isCurrentSession() || controller.signal.aborted) return;
            setMessages(current => mergeStreamedText(current, pendingAssistantMessage.id, fullText));
          },
          // 本地推理模型的思考过程（<think> 流）由适配器拆分后走这里，
          // 与在线路径的 onReasoning 同构：覆写 reasoning 字段，不动 pending。
          onReasoning: fullReasoning => {
            if (!isCurrentSession() || controller.signal.aborted) return;
            setMessages(current => {
              if (!isCurrentSession()) return current;
              return mergeStreamedReasoning(current, pendingAssistantMessage.id, fullReasoning);
            });
          },
          onlineSend,
            });
            break;
          } catch (error) {
            if (!overflowRetried && isContextOverflowError(error)) {
              overflowRetried = true;
              let compactedOk = false;
              try {
                const result = await runReactiveCompact({
                  messages: requestMessages,
                  error,
                  deps: {
                    summarize: request => sendChatMessage(request, {
                      stream: false,
                      expectedConfigId,
                      expectedConfigFingerprint,
                    }),
                  },
                });
                if (result.compacted) {
                  localMessages = localReady
                    ? filterRequestMedia(result.messages, localMedia)
                    : result.messages;
                  onlineMessages = filterRequestMedia(result.messages, onlineMedia);
                  compactedOk = true;
                }
              } catch (compactError) {
                compactedOk = false;
              }
              if (compactedOk) continue;
            }
            throw error;
          }
        }

       if (controller.signal.aborted) {
         recordStats('');
         clearToolBubble();
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
       // 记账放在拿到终稿之后：生成时长含解析开销，但只是毫秒级，换来「成功请求」口径准确。
       recordStats(replyText);
       clearToolBubble();
        if (isCurrentSession()) {
          setMessages(current => {
            const next = replacePendingWithReply(current, pendingAssistantMessage.id, replyParts);
            // P5：把本轮工具轨迹挂到助手终稿上（展示无感；下轮组装请求时展开回 agent 历史）。
            return turnTrace ? attachToolTrace(next, replyParts, turnTrace) : next;
          });
        // 会话模型标识落盘（记忆页「本地」badge 的数据源）。只在回复真正落入
        // 当前会话后标记；落盘失败不影响聊天主链路，静默吞掉。
        if (resolvedProvider) {
          markSessionModel(sendSessionId, {
            modelKind: resolvedProvider.kind === 'local' ? 'local' : 'api',
            modelName: resolvedProvider.kind === 'local'
              ? String(resolvedProvider.modelName || '')
              : onlineModelName,
          }).catch(() => {});
        }
        maybeAutoSummarize(buildAutoSummaryInput(baseMessages, replyParts, pendingAssistantMessage));
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
      } else {
        // 用户已离开这个会话：回复不再是「当前会话」的界面状态，写回它自己的会话，别丢。
        const ownerCharacterId = String(
          ((sessionsRef.current || []).find(item => item.id === sendSessionId) || {}).characterId
          || character.id
          || ''
        );
        await persistBackgroundReply({
          sessionId: sendSessionId,
          messages: replacePendingWithReply(
            [...baseMessages, pendingAssistantMessage],
            pendingAssistantMessage.id,
            replyParts
          ),
          ownerCharacterId,
        });
      }
     } catch (error) {
       clearToolBubble();
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
         recordStats('');
         setMessages(current => (
           isCurrentSession()
             ? settlePendingMessage(current, pendingAssistantMessage.id)
             : current
         ));
         return false;
       }
       // P2：上下文超限已在发送循环里「压缩 + 重试一次」（对齐 dsh condense-and-retry）；
       // 走到这里说明重试仍失败 → 明确提示用户手动精简。
       if (isContextOverflowError(error)) {
         recordStats('', { failed: true });
         recordDiagnostic('storage', '上下文超限：自动压缩后重试仍失败', 'reactive-compact');
         if (isCurrentSession()) {
           const { message: errorMessage, rawText } = buildReplyErrorMessage(
             pendingAssistantMessage.id,
             new Error(REACTIVE_FAILED_MESSAGE)
           );
           errorRawRef.current[errorMessage.id] = rawText;
           setMessages(current => (
             isCurrentSession()
               ? mergeErrorMessage(current, pendingAssistantMessage.id, errorMessage)
               : current
           ));
         }
         return false;
       }
       if (classifyReplyError(error, isConfigChangedError, isCanceledError) === 'failure') {
        // 失败也记一笔（只计请求数与失败数，token 记 0）——服务商的失败率同样是性价比信号。
        recordStats('', { failed: true });
        const { message: errorMessage, rawText } = buildReplyErrorMessage(pendingAssistantMessage.id, error);
        if (isCurrentSession()) {
          errorRawRef.current[errorMessage.id] = rawText;
        }
        setMessages(current => {
          if (!isCurrentSession()) return current;
          return mergeErrorMessage(current, pendingAssistantMessage.id, errorMessage);
        });
        if (restoreOnFailure) return false;
      }
     } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (isCurrentSession()) {
          setIsSending(false);
          autoScrollToBottom();
        }
      }
      setModelLoadProgress(null);
      // 降级提示随本次发送一起收场：它描述的是「这次请求中途换过模型」。
      setModelFallbackNotice(null);
      // I1：Steering 队列与提示同样只属于本轮（队列不跨轮复用，下一轮重新建）。
      steeringRef.current = null;
      setSteeringAvailable(false);
      setSteeringNote('');
    }
  }, [autoScrollToBottom, character, characters, chatOptions.stream, isSessionGuardCurrent, maybeAutoSummarize, ready, scrollToBottom]);

  const requestGroupReply = useCallback(async ({ historyMessages, userText, baseMessages, imageMessages, quote, expectedConfigId, expectedConfigFingerprint, sessionGuard }) => {
     if (sessionGuard && !isSessionGuardCurrent(sessionGuard)) return false;
     if (!ready || (abortRef.current && abortRef.current.signal.aborted)) return false;
    const members = groupCharactersRef.current;
    if (members.length === 0) {
      // 输入框在 onSend 里已清空，这里必须给个提示，不能让用户以为发出去又什么都没发生。
      Alert.alert(tRef.current('chat.send.noMembers.title'), tRef.current('chat.send.noMembers.body'));
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
     // P0-7：群聊（含群像/发言调度）换模型同样要如实提示——与单聊同一口径。
     const noteGroupModelFallback = info => {
       if (!isCurrent()) return;
       const to = String((info && info.to) || '');
       if (!to) return;
       setModelFallbackNotice({ from: String((info && info.from) || ''), to });
     };
     // 群聊同样计入本会话统计：配置名/模型名在这里读一次，供每组请求记账。
     let groupConfigLabel = '';
     let groupModelName = '';
     try {
       const { configs, activeId } = await getApiConfigs();
       const currentConfig = configs.find(item => item.id === expectedConfigId)
         || configs.find(item => item.id === activeId)
         || configs[0];
       groupConfigLabel = currentConfig ? String(currentConfig.name || currentConfig.id || '') : '';
       groupModelName = currentConfig ? String(getActiveModel(currentConfig) || '') : '';
     } catch (error) {}
     const recordGroupStats = (meter, replyText, extra = {}) => {
       try {
         const timing = meter.finish();
         recordSessionRequest(sendSessionId, {
           configId: expectedConfigId || 'unknown',
           configLabel: groupConfigLabel || expectedConfigId || '',
           model: groupModelName,
           promptTokens: 0,
           completionTokens: estimateReplyTokens(replyText || ''),
           firstTokenMs: timing.firstTokenMs,
           generationMs: timing.generationMs,
           at: timing.finishedAt,
           ...extra,
         }).catch(() => {});
       } catch (error) {}
     };
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
           Alert.alert(tRef.current('chat.send.webSearchFailed.title'), maskSecrets((error && error.message) || tRef.current('chat.send.webSearchFailed.body')));
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
            const speakerMeter = createRequestMeter();
            const reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
              stream: chatOptions.stream,
              onModelFallback: noteGroupModelFallback,
            });
            recordGroupStats(speakerMeter, reply);
             if (!isCurrent()) return false;
             working = working.map(item => (
              item.id === pendingMessage.id
                ? { ...item, text: reply || tRef.current('chat.send.noReply'), pending: false, waitingForResponse: false }
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
                  text: tRef.current('chat.send.memberReplyFailed', { name: speaker.name }),
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
          || tRef.current('chat.session.defaultGroupName');
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
        const ensembleMeter = createRequestMeter();
        try {
           reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
            stream: chatOptions.stream,
            onModelFallback: noteGroupModelFallback,
            onChunk: fullText => {
              ensembleMeter.markFirstToken();
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
        recordGroupStats(ensembleMeter, reply);
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
          Alert.alert(tRef.current('chat.send.groupReplyFailed.title'), tRef.current('chat.send.groupReplyFailed.body'));
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
      // 降级提示随本次发送一起收场（与单聊同款）。
      setModelFallbackNotice(null);
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
    const videoAttachments = allAttachments.filter(item => item && item.kind === 'video');
    const textAttachments = allAttachments.filter(item => item && item.kind === 'text');
    if (imageAttachments.length > MAX_IMAGE_ATTACHMENTS) {
      Alert.alert(tRef.current('chat.send.tooManyImages.title'), tRef.current('chat.send.tooManyImages.body', { max: MAX_IMAGE_ATTACHMENTS }));
      return false;
    }
    if (videoAttachments.length > MAX_VIDEO_ATTACHMENTS) {
      Alert.alert(tRef.current('chat.send.tooManyVideos.title'), tRef.current('chat.send.tooManyVideos.body', { max: MAX_VIDEO_ATTACHMENTS }));
      return false;
    }
    if (!isSessionGuardCurrent(sessionGuard)
       || messageSelectionOpen
       || isSwitching
       || sessionTransitionPending
       || (!text && imageAttachments.length === 0 && videoAttachments.length === 0 && textAttachments.length === 0 && !voice)
      || !sendLockRef.current
       || !ready
       || (abortRef.current && abortRef.current.signal.aborted)) return false;
     if (!isGroupRef.current && !greetingReady) return false;
     if (isGroupRef.current && groupCharactersRef.current.length === 0) {
       Alert.alert(tRef.current('chat.send.noMembers.title'), tRef.current('chat.send.noMembers.body'));
       return false;
     }
     if (isGroupRef.current) openingRequestRef.current += 1;
     if (sessionOwnerMissing) {
       Alert.alert(tRef.current('chat.send.ownerMissing.title'), tRef.current('chat.send.ownerMissing.sendBody'));
       return false;
     }
      let visionEnabled = false;
      let audioInputEnabled = false;
      let videoEnabled = false;
     let expectedConfigId = '';
     let expectedConfigFingerprint = '';
    try {
       const { configs, activeId } = await getApiConfigs();
       if (isCanceled() || !isSessionGuardCurrent(sessionGuard)) return false;
      const current = configs.find(item => item.id === activeId) || configs[0];
       expectedConfigId = String(current?.id || '');
       expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
        // 能力按**当前模型**解析（同一配置下每个模型一套能力，见 storage/apiConfigs）。
        const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
        visionEnabled = caps.supportsVision === true;
        audioInputEnabled = caps.supportsAudio === true;
        // 视频附件：模型声明看视频能力，且线协议为 OpenAI 兼容（video_url 是
        // 兼容端点的扩展类型，Responses/Anthropic 都没有视频输入）。本地模型无视频能力。
        videoEnabled = caps.supportsVideo === true
          && String(current.protocol || 'openai') === 'openai';
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
         if (!info.exists) throw sendError(SEND_ERROR.IMAGE_MISSING);
         return { ...item, size: info.size || Number(item.size) || 0 };
         }));
         if (isCanceled()) return false;
         validateImageBatch(sizedImages, { requireDimensions: true });
     } catch (error) {
       // 三种失败要分开说：文件已不存在（如撤回后原文件被清理）不能被说成「图片过大」，
       // 那会让用户去换更小的图，而真正的问题是这张图没了。
       if (error && error.code === SEND_ERROR.IMAGE_MISSING) {
         Alert.alert(tRef.current('chat.send.imageMissing.title'), tRef.current('chat.send.imageMissing.body'));
       } else if (error && error.code === ATTACH_ERROR.IMAGE_SIZE_UNREADABLE) {
         Alert.alert(tRef.current('chat.send.imageReadFailed.title'), tRef.current('chat.send.imageReadFailed.sizeBody'));
       } else {
         Alert.alert(tRef.current('chat.send.imageTooLarge.title'), tRef.current('chat.send.imageTooLarge.totalBody'));
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
         Alert.alert(tRef.current('chat.send.noVision.title'), tRef.current('chat.send.noVision.body'));
         return false;
       }
        let dataUri = '';
        if (visionEnabled) {
           const estimatedBase64Bytes = Math.ceil(Number(item.size || 0) * 4 / 3);
           if (totalBase64Bytes + estimatedBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
             Alert.alert(tRef.current('chat.send.imageTooLarge.title'), tRef.current('chat.send.imageTooLarge.totalBodyShort'));
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
                throw sendError(SEND_ERROR.IMAGE_TOTAL_TOO_LARGE);
              }
              if (isCanceled()) return false;
          } catch (error) {
           if (error && error.code === SEND_ERROR.IMAGE_TOTAL_TOO_LARGE) {
             Alert.alert(tRef.current('chat.send.imageTooLarge.title'), tRef.current('chat.send.imageTooLarge.totalBodyShort'));
           } else {
             Alert.alert(tRef.current('chat.send.imageReadFailed.title'), tRef.current('chat.send.imageReadFailed.retryBody'));
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
    // 视频附件：能力/数量/大小三重校验后读成数据 URI。预算与图片分列——
    // 视频请求体大得多，单独用 MAX_VIDEO_BASE64_BYTES 控住，避免一条视频
    // 把图片的额度连带吃光。
    if (videoAttachments.length > 0) {
      if (!videoEnabled) {
        Alert.alert(tRef.current('chat.send.noVideo.title'), tRef.current('chat.send.noVideo.body'));
        return false;
      }
      let totalVideoBase64Bytes = 0;
      for (let index = 0; index < videoAttachments.length; index += 1) {
        const item = videoAttachments[index];
        let size = Number(item.size || 0);
        try {
          const info = await getImageFileInfo(item.uri);
           if (!info.exists) throw sendError(SEND_ERROR.VIDEO_MISSING);
           size = info.size || size;
           validateVideoSize({ size });
         } catch (error) {
           if (error && error.code === SEND_ERROR.VIDEO_MISSING) {
             Alert.alert(tRef.current('chat.send.videoMissing.title'), tRef.current('chat.send.videoMissing.body'));
           } else {
             Alert.alert(tRef.current('chat.send.videoTooLarge.title'), tRef.current('chat.send.videoTooLarge.body', { max: Math.round(MAX_VIDEO_BYTES / (1024 * 1024)) }));
           }
          return false;
        }
        let dataUri = '';
        try {
          const estimatedBase64Bytes = Math.ceil(size * 4 / 3);
          if (totalVideoBase64Bytes + estimatedBase64Bytes > MAX_VIDEO_BASE64_BYTES) {
            throw sendError(SEND_ERROR.VIDEO_TOTAL_TOO_LARGE);
          }
          totalVideoBase64Bytes += estimatedBase64Bytes;
          dataUri = await readVideoDataUri(item.uri, item.mime);
          const separator = dataUri.indexOf(',');
          const base64Length = separator >= 0 ? dataUri.length - separator - 1 : dataUri.length;
          totalVideoBase64Bytes = Math.max(
            totalVideoBase64Bytes,
            totalVideoBase64Bytes - estimatedBase64Bytes + Math.ceil(base64Length * 3 / 4)
          );
          if (totalVideoBase64Bytes > MAX_VIDEO_BASE64_BYTES) throw sendError(SEND_ERROR.VIDEO_TOTAL_TOO_LARGE);
          if (isCanceled()) return false;
        } catch (error) {
          Alert.alert(tRef.current('chat.send.videoReadFailed.title'), tRef.current('chat.send.videoReadFailed.body'));
          return false;
        }
        if (!isSessionGuardCurrent(sessionGuard)) return false;
        const videoMessage = createMediaMessage({
          id: `${now}-video-${index}`,
          kind: 'video',
          uri: item.uri,
          mime: item.mime,
          name: item.name,
          width: item.width,
          height: item.height,
          timestamp: now + imageAttachments.length + index,
        });
        mediaMessages.push(videoMessage);
        imageMessages.push({ ...videoMessage, dataUri, includeVideo: videoEnabled });
      }
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
         Alert.alert(tRef.current('chat.send.sourceChanged.title'), tRef.current('chat.send.sourceChanged.resendBody'));
         return false;
       }
        if (
          imageAttachments.some(item => item.kind === 'image')
          && latestConfig
          && latestConfig.supportsVision !== true
          && !localMedia.vision
        ) {
         Alert.alert(tRef.current('chat.send.noVision.title'), tRef.current('chat.send.noVision.body'));
         return false;
       }
     } catch (error) {
       Alert.alert(tRef.current('chat.send.configReadFailed.title'), tRef.current('chat.send.configReadFailed.body'));
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
          Alert.alert(tRef.current('chat.send.sourceChanged.title'), tRef.current('chat.send.sourceChanged.draftKeptBody'));
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
        Alert.alert(tRef.current('chat.send.ownerMissing.title'), tRef.current('chat.send.ownerMissing.regenBody'));
        return false;
      }
       const index = messages.findIndex(item => item.id === targetId);
       if (index < 0 || messages[index].role !== ASSISTANT_ID) return false;
       // 重新生成会丢弃被重生成助手消息及其之后的所有消息：先留一份尾段，
       // 成功后归档成分支（失败路径会恢复整条时间线，不归档，避免重复）。
       const removedTail = messages.slice(index);
       const removedForkId = index > 0 ? String(messages[index - 1] && messages[index - 1].id || '') : '';
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
           if (!info.exists) throw sendError(SEND_ERROR.IMAGE_MISSING);
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
         Alert.alert(tRef.current('chat.send.imageTooLarge.title'), tRef.current('chat.send.imageTooLarge.regenBody'));
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
              Alert.alert(tRef.current('chat.send.imageTooLarge.title'), tRef.current('chat.send.imageTooLarge.regenTotalBody'));
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
              Alert.alert(tRef.current('chat.send.imageTooLarge.title'), tRef.current('chat.send.imageTooLarge.regenTotalBody'));
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
            Alert.alert(tRef.current('chat.send.sourceChanged.title'), tRef.current('chat.send.sourceChanged.regenBody'));
          }
          return false;
        }
        if (handled !== false && isSessionGuardCurrent(sessionGuard) && !abortRef.current) {
          const session = sessionsRef.current.find(item => item.id === sessionGuard.sessionId);
          if (session) {
            const sessionCharacterId = String(session.characterId || '');
            const latestCharacters = Array.isArray(charactersRef.current) ? charactersRef.current : [];
            const characterExists = latestCharacters
              .some(item => item.id === sessionCharacterId);
            const sessionCharacter = latestCharacters
              .find(item => item.id === sessionCharacterId) || character;
            const scoped = isBuiltinAssistant(sessionCharacter)
              || !characterExists
              || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, undefined, session.id);
            try {
              await invalidateHistorySummaries({
                session,
                messages: originalMessages.slice(0, index),
                removedIds: originalMessages.slice(index).map(item => String(item && item.id || '')),
                scoped,
                character: sessionCharacter,
                updateCharacter,
              });
            } catch (error) {
              if (__DEV__) console.warn('[memorySummary] regenerate invalidation failed', error);
            }
          }
          // 归档被重生成丢弃的旧尾段（含旧回复），让用户可回到旧版本。
          await archiveActiveTail(sessionGuard.sessionId, removedForkId, removedTail);
        }
        return handled !== false && isSessionGuardCurrent(sessionGuard) && !abortRef.current;
    } finally {
      endSendOperation(token);
    }
  }, [archiveActiveTail, beginSendOperation, captureSessionGuard, character, endSendOperation, isSending, isSessionGuardCurrent, isSwitching, messages, ready, removeVectorIndexForSession, requestReply, sessionOwnerMissing, sessionTransitionPending, updateCharacter]);

  const editUserMessage = useCallback(targetId => {
    if (isSending || isSwitching || sessionTransitionPending || !ready || abortRef.current) return;
    const sessionGuard = captureSessionGuard();
    const plan = getEditResendPlan(messagesRef.current, targetId);
    if (!plan || !isSessionGuardCurrent(sessionGuard)) return;
    // 图片/表情包撤回后回填到附件区，文字撤回后回填到输入框——文案随之区分。
    const isMediaPlan = Array.isArray(plan.attachments) && plan.attachments.length > 0;
    Alert.alert(
      tRef.current('chat.editResend.title'),
      isMediaPlan
        ? tRef.current('chat.editResend.mediaBody')
        : tRef.current('chat.editResend.textBody'),
      [
        { text: tRef.current('common.cancel'), style: 'cancel' },
        {
          text: tRef.current('chat.editResend.confirm'),
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
                const latestCharacters = Array.isArray(charactersRef.current) ? charactersRef.current : [];
                const characterExists = latestCharacters
                  .some(item => item.id === sessionCharacterId);
                const sessionCharacter = latestCharacters
                  .find(item => item.id === sessionCharacterId) || character;
                const scoped = isBuiltinAssistant(sessionCharacter)
                  || !characterExists
                  || isSessionScopedMemory(sessionsRef.current, sessionCharacterId, undefined, session.id);
                await invalidateHistorySummaries({
                  session,
                  messages: latestPlan.messages,
                  removedIds,
                  scoped,
                  character: sessionCharacter,
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
              // 归档被「修改重发」丢弃的尾段（含被编辑的原用户消息及其后所有消息）。
              const latestMessages = messagesRef.current;
              const keptCount = latestPlan.messages.length;
              const removedTail = latestMessages.slice(keptCount);
              const removedForkId = keptCount > 0
                ? String(latestMessages[keptCount - 1] && latestMessages[keptCount - 1].id || '')
                : '';
              await archiveActiveTail(sessionGuard.sessionId, removedForkId, removedTail);
              setMessages(latestPlan.messages);
              setInput(latestPlan.text);
              // 图片消息把撤下来的图片放回附件区：文件仍在文档目录，落入附件列表即
              // 被 syncProtectedAttachmentUris 纳入保护集合（它读取 attachmentsRef +
              // pendingAttachmentUrisRef），后续孤儿文件回收不会误删。
              const restored = Array.isArray(latestPlan.attachments) ? latestPlan.attachments : [];
              if (restored.length > 0) {
                setAttachments(current => {
                  const next = [...current, ...restored];
                  attachmentsRef.current = next;
                  return next;
                });
                syncProtectedAttachmentUris();
              }
              setQuoteTarget(null);
            } catch (error) {
              Alert.alert(tRef.current('chat.editResend.failed.title'), tRef.current('chat.editResend.failed.body'));
            }
          },
        },
      ]
    );
  }, [archiveActiveTail, captureSessionGuard, character, characterId, isSending, isSessionGuardCurrent, isSwitching, ready, removeVectorIndexForSession, sessionTransitionPending, syncProtectedAttachmentUris, updateCharacter]);

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

  // I1：运行中的补充指令入队。判定（能不能入队）在 chat/steeringSend.js 的纯函数里，
  // 这里只负责「入队 + 给用户一句如实提示」；没有队列/空文本一律 false，不假装成功。
  const pushSteering = useCallback(rawText => {
    const queue = steeringRef.current;
    const text = String(rawText === undefined || rawText === null ? '' : rawText).trim();
    if (!queue || !text) return false;
    if (!queue.push(text)) return false;
    setSteeringNote(tRef.current('chat.send.steering.note'));
    return true;
  }, []);

  return {
    requestReply,
    requestGroupReply,
    performSendMessage,
    sendMessage,
    sendText,
    regenerateMessage,
    editUserMessage,
    onRegenerateMessage,
    onEditUserMessage,
    modelLoadProgress,
    modelFallbackNotice,
    // P2-7：上下文占用明细（null = 还没发过请求）。
    contextBreakdown,
    // I1：运行中补充指令（队列可用性 + 入队 + 提示文案）。
    steeringAvailable,
    pushSteering,
    steeringNote,
    setSteeringNote,
    branchesRefreshToken,
  };
}
