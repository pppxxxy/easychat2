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
  THINKING_PLACEHOLDER_KEY,
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
// K1 预算（纯换算，可直测）与在线配置侧上下文（碰存储）。
import { resolveAgentContextBudget } from './agentContextBudget.js';
import { EMPTY_ONLINE_REQUEST_CONTEXT, resolveOnlineRequestContext } from './onlineRequestContext.js';
// I1：Steering 队列（运行中补充指令）——纯函数工厂，队列本身只在「本轮会跑工具循环」时建。
import { createSteeringQueue } from '../agent/steering.js';
import { registerChatTools, unregisterChatTools } from './chatTools.js';
// 后台落库后作废流式草稿（半截恢复用，见 persistBackgroundReply）。
import { clearStreamDraft } from '../storage/streamDraft.js';
// 工具过程气泡：事件→状态映射、隐藏判定与状态变换都在 toolBubbleView.js（唯一来源）。
import { createToolBubbleApplier, toolBubbleState } from './toolBubbleView.js';
import { approvalOptionsFromToolCall, approveToolCall, readToolPermissionRules } from './toolApprovalFlow.js';
import { createWorkspaceStore, registerDefaultWorkspaceTools } from '../workspace/native.js';
// O1 超限结果落盘（M 系）+ 工作区钩子事件面（D 系：注入/预置禁令，取代旧的 shellHookDenyRules）。
import { persistToolResult } from '../workspace/taskOutputs.js';
import {
  buildHookContextText,
  collectPromptHooks,
  collectSessionStartNotices,
  collectTurnEndNotices,
  readHookPermissionRules,
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
  MAX_VIDEO_BYTES,
  mergeTextAttachments,
  readImageDataUri,
  validateImageBatch,
} from './attachments.js';
import { createMediaMessage, getMessagePromptText, STICKER_MESSAGE_KIND } from './chatMedia.js';
// 输入框 store：只用 getInput 做调用期读取（不订阅）。清空逻辑见 sendInputCleanup.js。
import { getInput } from './inputStore.js';
import { clearInputAfterSend } from './sendInputCleanup.js';
// 图片识别（OCR）：带图片的消息先由 OCR 模型换成文字描述再喂主模型（接线见
// chat/imageRecognitionSend.js，这里只用它的两个入口）。
import { applyImageRecognitionToMessages } from './imageRecognitionSend.js';
import { resolveImageRecognitionPlan } from '../imageRecognition/index.js';
import { getCharacterApiConfigs, resolveCharacterOcrSettings } from '../character/runtimeConfig.js';
import { prepareVideoMessages } from './videoSend.js';
import { createVoiceMessage, VOICE_PLACEHOLDER_TEXT } from './voiceMessages.js';
import { createRequestMeter, estimatePromptTokens, estimateReplyTokens } from './sessionStats.js';
import { recordSessionRequest } from '../storage/sessionStats.js';
import { stop as ttsStop } from '../tts/index.js';
import { maskSecrets } from '../storage/secrets.js';
import { resolveChatInjections } from './chatInjections.js';
import { saveSessionPlan } from '../storage/sessionPlan.js';
import { recordDiagnostic } from '../storage/diagnostics.js';
// N1：reactive 回退——API 报上下文超限时压缩历史（本批接线为「压缩 + 提示重发」；
// 自动重试需发送流程重构，见 reactiveCompact 注释）。
import { REACTIVE_FAILED_MESSAGE_KEY, isContextOverflowError, runReactiveCompact } from './reactiveCompact.js';
// N2 整合：反应式压缩的 deps（含 L3 归档）与主聊天页四档管线同一套装配纪律。
import { buildReactiveCompactDeps } from './sessionCompaction.js';
// P5：工具轨迹持久化（把本轮 tool 消息挂在助手终稿上，供跨轮 K1/N2 使用）。
import { attachToolTrace, extractToolTrace } from './toolTrace.js';
// ask_user：任务中途向用户提选择题。
import { promptUserChoice } from './askUserPrompt.js';
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
  replacePendingWithReply,
} from './replyFlow.js';
import { resolveHistoryWindow } from './historyWindow.js';
import { createReasoningStreamThrottle, createTextStreamThrottle } from './streamThrottle.js';
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
import { capabilitiesForModel, getActiveModel } from '../storage/apiConfigs.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import { getEnabledPlugins } from '../storage/settings.js';
import { getUserProfile } from '../storage/personas.js';
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
    // 完整回复已落库，流式草稿（半截恢复用）随之作废。不清的话草稿会一直留着，
    // 用户下次打开该会话时走「已恢复」插入路径——按 id 去重虽不会重复显示，
    // 但留在盘上就是永远多读一次、多清一次的负担。
    await clearStreamDraft(id).catch(() => {});
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
  // P0-8：hooks.json 的注入类事件——session_start 每个会话只注入一次（内存记账），after_turn 的提醒排队给下一轮；两者都只在本次运行内有效（重启即丢，不写盘）。
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
     // 挂出 / 原地更新 / 清除、以及**隐藏判定**都在 toolBubbleView.js 里（唯一实现）。
     // 可见性直读 chatOptionsRef：设置页改完回到聊天页即生效，本轮已在跑的工具也跟随。
     // **审批弹层不走这里**：需要确认时由下面的 onToolApproval → approveToolCall 独立弹出。
     // 隐藏过程提示**绝不**隐藏审批，否则工具会在用户不知情时执行（安全问题，不是偏好）。
     const toolBubble = createToolBubbleApplier({
       id: `${Date.now()}-tool-bubble`,
       isCurrentSession,
       getVisibility: () => chatOptionsRef.current,
       setMessages,
     });
     const clearToolBubble = toolBubble.clear;
     const setToolBubble = toolBubble.set;
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
      text: tRef.current(THINKING_PLACEHOLDER_KEY),
      reasoning: '',
      pending: true,
      waitingForResponse: true,
      timestamp: Date.now(),
    };
    // 流式节流（口径见 streamThrottle.js）：与 recordStats 同理声明在 try 之外——catch 的停止/失败分支要 flush 它。
    const streamThrottle = createTextStreamThrottle({ isCurrentSession, setMessages, pendingId: pendingAssistantMessage.id });
    // reasoning 同口径节流：不加它，推理模型每个思考 token 都整表重渲一次（见 streamThrottle.js）。
    const reasoningThrottle = createReasoningStreamThrottle({ isCurrentSession, setMessages, pendingId: pendingAssistantMessage.id });
    // 本会话统计打点：声明在 try 之外（catch 的失败/取消分支也要记账）；异常一律吞掉——统计绝不能影响聊天主链路。
    let recordStats = () => {};

    // 切会话竞态：上面两次 await（工作区设置 / hooks 读取）期间用户可能已切走，此时
    // 写入会把 pending 气泡画进新会话（后续守卫再 return 就留下一个卡住的「思考中」）。
    // 与其它写入点一致，先做会话守卫。
    if (!isCurrentSession()) return false;
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
           isCurrentSession() ? settlePendingMessage(current, pendingAssistantMessage.id, tRef.current) : current
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
      // 已经作为原文发送的历史（boundary 之后）不再由向量重复召回，被摘要裁剪掉的更早
      // 区间与其它会话才交给向量；总结关闭时再按记忆长度只留最近 N 轮（planHistoryWindow）。
      const { trimmedHistory, sentIds } = await resolveHistoryWindow({ historyMessages, boundary });
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
        // 读取作用域：单会话角色带上已有世界书记忆（不做迁移/丢弃），多会话角色只读本会话
        //（写入侧降级见 runSummarize，两者解耦）。内置助手一律按会话级（它卡上的「记忆总结」
        // 可能是兜底归属沉淀来的），并把当前会话计入判定，避免第二个会话被当成单会话角色。
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
       // 位置 / 角色作息 / 时间感知 / 表情包 / 图片下载：与群聊共用同一份计算（chatInjections）。
       // 「本次请求的时刻」只取一次：时间行与作息规则的工作日/休息日判定必须同一天。
       const scheduleCharacterId = String((currentSession && currentSession.characterId) || character.id || '');
       const inject = await resolveChatInjections({
         characterId: scheduleCharacterId,
         chatOptions: chatOptionsRef.current,
         stickerSource: stickersRef.current,
       });
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
         stickerNames: inject.stickerNames,
         stickerEnabled: inject.stickerEnabled,
         stickerChance: inject.stickerChance,
         currentTimeText: inject.currentTimeText,
         scheduleText: inject.scheduleText,
         downloadImageEnabled: inject.downloadImageEnabled,
         downloadImageSources: inject.downloadImageSources,
         locationText: inject.locationText,
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
        // 本地模型可以拥有独立的 mmproj 能力；本地失败回退在线时，必须按在线配置单独裁剪媒体。
        let online = EMPTY_ONLINE_REQUEST_CONTEXT;
        // 角色专属聊天 API 的唯一入口（解析层见 character/runtimeConfig.js）：activeId 已按
        // 角色覆盖解析，专属模型也写进了该条配置的 activeModel，下面的能力/指纹自动跟随。
        const charConfigs = await getCharacterApiConfigs(characterId).catch(() => ({ configs: [], activeId: '', chatRequestOptions: {} }));
        try {
          online = resolveOnlineRequestContext(charConfigs.configs, charConfigs.activeId, expectedConfigId, {
            getModel: getActiveModel,
            getCapabilities: capabilitiesForModel,
          });
        } catch (error) {}
        const { media: onlineMedia, modelName: onlineModelName, configLabel: onlineConfigLabel } = online;
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
        // E1：本次发送内多次 API 调用（工具轮）的 usage 累加器——每次调用都是真实计费，
        // 累计才是真实成本；缓存命中率 = Σcached / Σprompt，不返回 usage 的端点 count 恒为 0
        // 走估算回退。P0-7/P2-10：`lastModel` 记**真正产出内容**的模型（降级链可能换过模型），
        // 按主模型记会让「这条回复是谁产的」变成假话。
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
        const k1ContextBudgetBytes = resolveAgentContextBudget(onlineMessages, online.contextWindow);
        const onlineSend = () => (agentTools.length > 0
          ? runAgentTurn(onlineMessages, {
              mode: workspaceMode,
              tools: agentTools,
              // P1/K1：旧工具结果退役的字符预算；未声明窗口时为 0 → 不传 → 保持 2MB 默认。
              ...(k1ContextBudgetBytes > 0 ? { contextBudgetBytes: k1ContextBudgetBytes } : {}),
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
                // 专属配置生效时才有键（configId+model）；无覆盖时为 {} = 既有解析路径。
                ...charConfigs.chatRequestOptions,
                stream: chatOptions.stream,
                // P0-7：换模型重试要能提示到用户（经 runAgentTurn 透传给 api.js）。
                onModelFallback: noteModelFallback,
              },
              onToken: fullText => {
                meter.markFirstToken();
                if (!isCurrentSession() || controller.signal.aborted) return;
                // agent 工具循环的 token 也要过节流（此前直连 setMessages，每 token 一次整表重渲）。
                streamThrottle.push(fullText);
              },
              onReasoning: fullReasoning => {
                if (!isCurrentSession() || controller.signal.aborted) return;
                reasoningThrottle.push(fullReasoning);
              },
              onToolEvent: event => {
                // 可见的工具过程气泡：start 挂出「正在…」，end 原地改成「完成/失败」。
                // 事件→状态映射复用 toolBubbleState，不在这里重写一遍。
                // 结束后不立刻清掉——用户要能看到「刚才搜过」，它随本轮结束一起消失
                //（下面 clearToolBubble 在各收尾分支统一调用），且不落库。
                // 隐藏只掐「显示」：事件处理照旧，工具循环本身完全不受影响。
                const state = toolBubbleState(event);
                if (state) setToolBubble(state.name, state.status, state.error || '');
              },
              // 逐条确认 + 权限规则：这里是唯一能问到用户的出口，不接的话 registry 会把需要
              // 确认的工具一律拒绝。钩子规则（before_shell / before_tool）**不走这里**：它们
              // 由 permissionRules 单独喂给 runTool（见下）——审批只在「需要确认的工具」上被
              // 调用，而钩子要拦下**任意**工具，写工具按设计不逐条确认（2026-10-11 P1）。
              onToolApproval: call => approveToolCall({
                ...approvalOptionsFromToolCall(call),
                t: tRef.current,
                // 用户点「停止生成」时立刻按拒绝结算，不留悬挂的弹框 Promise。
                signal: controller.signal,
              }),
              // P1：钩子规则 + 用户存储规则合并 —— **两线各自独立修了同一个缺陷**
              //（只给钩子规则会让写工具上的手写 deny 变死键：写工具不逐条确认、
              //  走不到 approveToolCall，所以规则必须经 permissionRules 直达 runTool）。
              // 合并点取 D 线版本（chat/toolApprovalFlow.js 的 readToolPermissionRules）：
              // 它把两组规则的读取与容错收在一处，且 **hooks.js 保持存储无关**——
              // 否则纯 Node 用例会被 expo-file-system 依赖打挂（有测试钉住这条）。
              permissionRules: async () => readToolPermissionRules(await readHookPermissionRules(hookStore, character.id)),
              // ask_user：任务中途向用户提选择题（跨平台 Alert）。
              onAskUser: payload => promptUserChoice({
                ...payload,
                cancelLabel: tRef.current('common.cancel'),
                alert: (...a) => Alert.alert(...a),
              }),
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
              ...charConfigs.chatRequestOptions,
              signal: controller.signal,
           stream: chatOptions.stream,
           onModelFallback: noteModelFallback,
           onChunk: fullText => {
             meter.markFirstToken();
             if (!isCurrentSession() || controller.signal.aborted) return;
             streamThrottle.push(fullText);
           },
           onReasoning: fullReasoning => {
             if (!isCurrentSession() || controller.signal.aborted) return;
             reasoningThrottle.push(fullReasoning);
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
            // 本地模型按 chunk=token 回调，密度比在线流还高——同样走节流器（口径见上一条）。
            streamThrottle.push(fullText);
          },
          // 本地推理模型的思考过程（<think> 流）由适配器拆分后走这里，
          // 与在线路径的 onReasoning 同构：覆写 reasoning 字段，不动 pending。
          onReasoning: fullReasoning => {
            if (!isCurrentSession() || controller.signal.aborted) return;
            reasoningThrottle.push(fullReasoning);
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
                  deps: buildReactiveCompactDeps({
                    store: hookStore, characterId: character.id,
                    summarize: request => sendChatMessage(request, { stream: false, signal: controller.signal, expectedConfigId, expectedConfigFingerprint, ...charConfigs.chatRequestOptions }),
                  }),
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
         setMessages(current => {
           if (!isCurrentSession()) return current;
           const settled = settlePendingMessage(current, pendingAssistantMessage.id, tRef.current);
           // 中止那一轮的工具轨迹不能丢（D 线 5752f6d 的**宿主侧**那一半）：agent 侧已在中止
           // 路径发出 transcript，这里把它挂到结算后的消息上（与成功路径同款 attachToolTrace）。
           // 占位气泡若无正文且无推理，settlePendingMessage 会把它丢掉——那时按 id 匹配不上，
           // 原样返回：没有可挂的消息，也不该凭空造一条。
           return turnTrace
             ? attachToolTrace(settled, [{ id: pendingAssistantMessage.id }], turnTrace)
             : settled;
         });
         return;
       }
        // 解析表情包 / 图片下载指令：回复可能被拆成「文字消息 + 若干媒体消息」。
        const replyParts = buildAssistantReply(reply, sendSessionId);
       const replyText = replyParts.find(item => item.role === ASSISTANT_ID && !item.kind)?.text
         || '';
       // 记账放在拿到终稿之后：生成时长含解析开销，但只是毫秒级，换来「成功请求」口径准确。
       recordStats(replyText);
       clearToolBubble();
        if (isCurrentSession()) {
          setMessages(current => {
            const next = replacePendingWithReply(current, pendingAssistantMessage.id, replyParts, tRef.current);
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
            replyParts,
            tRef.current
          ),
          ownerCharacterId,
        });
      }
     } catch (error) {
       clearToolBubble();
       streamThrottle.flush(); reasoningThrottle.flush(); // 文本/思考是两条独立节流器，都要 flush
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
             ? settlePendingMessage(current, pendingAssistantMessage.id, tRef.current)
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
              new Error(tRef.current(REACTIVE_FAILED_MESSAGE_KEY)),
             tRef.current
           );
           errorRawRef.current[errorMessage.id] = rawText;
           setMessages(current => (
             isCurrentSession()
               ? mergeErrorMessage(current, pendingAssistantMessage.id, errorMessage, tRef.current)
               : current
           ));
         }
         return false;
       }
       if (classifyReplyError(error, isConfigChangedError, isCanceledError) === 'failure') {
        // 失败也记一笔（只计请求数与失败数，token 记 0）——服务商的失败率同样是性价比信号。
        recordStats('', { failed: true });
        const { message: errorMessage, rawText } = buildReplyErrorMessage(pendingAssistantMessage.id, error, tRef.current);
        if (isCurrentSession()) {
          errorRawRef.current[errorMessage.id] = rawText;
        }
        setMessages(current => {
          if (!isCurrentSession()) return current;
          return mergeErrorMessage(current, pendingAssistantMessage.id, errorMessage, tRef.current);
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
     const groupRuntime = await getCharacterApiConfigs(characterId)
       .catch(() => ({ configs: [], activeId: '', chatRequestOptions: {} }));
     const currentConfig = groupRuntime.configs.find(item => item.id === expectedConfigId)
       || groupRuntime.configs.find(item => item.id === groupRuntime.activeId)
       || groupRuntime.configs[0];
     const groupConfigLabel = currentConfig ? String(currentConfig.name || currentConfig.id || '') : '';
     const groupModelName = currentConfig ? String(getActiveModel(currentConfig) || '') : '';
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
       // 与单聊同一套系统注入（chatInjections）：群聊此前完全没有，行为与单聊分叉。
       const groupInject = await resolveChatInjections({
         characterId: String((activeSessionRef.current && activeSessionRef.current.characterId) || ''),
         chatOptions: chatOptionsRef.current,
         stickerSource: stickersRef.current,
       });
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
            text: tRef.current(THINKING_PLACEHOLDER_KEY),
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
               currentTimeText: groupInject.currentTimeText,
               scheduleText: groupInject.scheduleText,
               locationText: groupInject.locationText,
               stickerNames: groupInject.stickerNames,
               stickerEnabled: groupInject.stickerEnabled,
               stickerChance: groupInject.stickerChance,
               downloadImageEnabled: groupInject.downloadImageEnabled,
               downloadImageSources: groupInject.downloadImageSources,
            });
            const speakerMeter = createRequestMeter();
            const reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             ...groupRuntime.chatRequestOptions,
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
              isCurrent() ? settlePendingMessage(current, pendingMessage.id, tRef.current) : current
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
          text: tRef.current(THINKING_PLACEHOLDER_KEY),
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
        // 合议流式同样要节流（此前每 token 直连一次 O(N) 整表 map）；mergeStreamedText 与原来的内联写法逐字段等价，故复用同一装配函数。
        const ensembleThrottle = createTextStreamThrottle({ isCurrentSession: isCurrent, setMessages, pendingId: pendingMessage.id });
        try {
           reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             ...groupRuntime.chatRequestOptions,
             signal: controller.signal,
            stream: chatOptions.stream,
            onModelFallback: noteGroupModelFallback,
            onChunk: fullText => {
              ensembleMeter.markFirstToken();
              if (!isCurrent() || controller.signal.aborted) return;
              ensembleThrottle.push(fullText);
            },
          });
         } catch (error) {
           if (isConfigChangedError(error)) throw error;
           if (isCanceledError(error)) {
             // 停止：合议模式的流式增量只写进了 state（局部变量 working 里仍是占位符），
             // 所以必须按当前 state 结算，否则已生成的部分会被整条丢掉
             ensembleThrottle.flush(); // 先放行窗口里压着的最后一份文本：settle 会把 pending 置 false，迟到的尾沿会被丢弃
             setMessages(current => (
               isCurrent() ? settlePendingMessage(current, pendingMessage.id, tRef.current) : current
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
      // 图片识别（OCR）这次能不能用（开关 + 配置 + 模型名 + 密钥四项都满足）。
      // 在图片循环前解析：循环里的视觉门控需要它来决定「主模型没有识图能力时
      // 是否放行到 OCR 通道」。
      let imageRecognitionPlan = null;
     let expectedConfigId = '';
     let expectedConfigFingerprint = '';
    try {
       const { configs, activeId } = await getCharacterApiConfigs(characterId);
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
      // 图片识别（OCR）配置：只在确实带图片时解析（纯文字消息不白读一次存储）。
      // 用途有二：图片循环的视觉门控（主模型无识图能力时是否放行到 OCR 通道）、
      // 循环之后的识别接线。设置取**角色生效值**（专属 OCR 配置优先，失效则回落全局）。
      if (imageAttachments.length > 0) imageRecognitionPlan = await resolveImageRecognitionPlan(await resolveCharacterOcrSettings(characterId)).catch(() => null);
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
      if (kind === 'image' && !visionEnabled && !(imageRecognitionPlan && imageRecognitionPlan.ready)) {
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
    // 图片识别（OCR）接线：先把图片交给 OCR 模型换成文字描述（描述由 chatMedia 的
    // 上下文投影拼进该消息文本，让看不到图的模型也能理解画面），再决定是否附原图。
    // 失败**绝不静默丢图**：主模型能看图 → 退回直发原图；看不到图 → 明确提示并中止
    //（继续发就是发一条模型看不懂的请求，用户只会收到莫名其妙的回复）。
    if (imageRecognitionPlan && imageRecognitionPlan.ready && imageMessages.length > 0) {
      const recognized = await applyImageRecognitionToMessages(imageMessages, {
        plan: imageRecognitionPlan,
        mainModelVision: visionEnabled,
        signal: abortRef.current ? abortRef.current.signal : null,
      });
      if (isCanceled() || !isSessionGuardCurrent(sessionGuard)) return false;
      if (recognized.decision === 'fail') {
        Alert.alert(tRef.current('chat.send.imageRecognitionFailed.title'), tRef.current('chat.send.imageRecognitionFailed.body'));
        return false;
      }
      if (recognized.ran) imageMessages.forEach(item => { item.includeImage = recognized.attachOriginal; });
    }
    // 视频附件：校验后读成数据 URI（编排已抽到 chat/videoSend.js）。预算与图片分列：
    // 视频请求体大得多，共用一份额度会让一条视频把图片的额度吃光。
    if (videoAttachments.length > 0) {
      if (!videoEnabled) {
        Alert.alert(tRef.current('chat.send.noVideo.title'), tRef.current('chat.send.noVideo.body'));
        return false;
      }
      const prepared = await prepareVideoMessages(videoAttachments, {
        now,
        indexOffset: imageAttachments.length,
        maxVideoBytes: MAX_VIDEO_BYTES,
        getFileInfo: getImageFileInfo,
        isCanceled,
        isGuardCurrent: () => isSessionGuardCurrent(sessionGuard),
      });
      if (!prepared.ok) {
        if (prepared.reason === 'canceled' || prepared.reason === 'guard-changed') return false;
        if (prepared.reason === 'missing') {
          Alert.alert(tRef.current('chat.send.videoMissing.title'), tRef.current('chat.send.videoMissing.body'));
        } else if (prepared.reason === 'read-failed') {
          Alert.alert(tRef.current('chat.send.videoReadFailed.title'), tRef.current('chat.send.videoReadFailed.body'));
        } else {
          Alert.alert(tRef.current('chat.send.videoTooLarge.title'), tRef.current('chat.send.videoTooLarge.body', { max: Math.round(MAX_VIDEO_BYTES / (1024 * 1024)) }));
        }
        return false;
      }
      prepared.messages.forEach(({ message, dataUri }) => {
        mediaMessages.push(message);
        imageMessages.push({ ...message, dataUri, includeVideo: videoEnabled });
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
      userText: voiceMessage ? (promptUserText || VOICE_PLACEHOLDER_TEXT) : mergedText, // 占位文本走 voiceMessages.js:7 的单一常量，不再内联同款字符串（改一处漏一处即复发）：chatMedia.js:55-61 的内联是为避循环依赖，本文件 :71 已 import 该模块
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
       const latest = await getCharacterApiConfigs(characterId);
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
          && capabilitiesForModel(latestConfig, getActiveModel(latestConfig)).supportsVision !== true
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
     // 清空输入与草稿（仅当用户没在此期间改动输入）；实现与历史见 sendInputCleanup.js。
     clearInputAfterSend({ rawText, getInput, setInput, draftTextRef, persistDraftNow, sessionId: sessionGuard.sessionId });
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
          getCharacterApiConfigs(characterId),
          getLocalModelSettings().catch(() => null),
          getActiveLocalModel().catch(() => null),
        ]);
        const current = configs.find(item => item.id === activeId) || configs[0];
         expectedConfigId = String(current?.id || '');
         expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
         includeImage = !!(current && capabilitiesForModel(current, getActiveModel(current)).supportsVision);
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
  // 失败时**必须**给一句可见提示（复用 noLoop 词条）：宿主只在成功时才清空输入框，
  // 静默返回 false 会让用户看到「点了发送、字还在、什么也没发生」。
  const pushSteering = useCallback(rawText => {
    const queue = steeringRef.current;
    const text = String(rawText === undefined || rawText === null ? '' : rawText).trim();
    const queueFull = !queue || !text || !queue.push(text);
    setSteeringNote(tRef.current(queueFull ? 'chat.send.steering.noLoop' : 'chat.send.steering.note'));
    return !queueFull;
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
