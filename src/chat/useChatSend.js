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
import { runAgentTurn } from '../agent/loop.js';
import { registerChatTools, unregisterChatTools } from './chatTools.js';
import { TOOL_BUBBLE_KIND } from './chatConstants.js';
import { approveToolCall } from './toolApprovalFlow.js';
import { registerDefaultWorkspaceTools } from '../workspace/native.js';
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
import { buildLocationText, placeToLocation, resolveActivePlace } from '../location/geo.js';
import { settlePendingMessage } from './chatHelpers.js';
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
        const onlineMessages = filterRequestMedia(requestMessages, onlineMedia);
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
        if (workspaceMode !== 'ask') {
          try {
            registerDefaultWorkspaceTools(workspaceSettings);
          } catch (error) {}
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
        // token 是估算（在线 API 不返回 usage），口径与上下文占用同一估算器，服务商之间可比。
        let resolvedProvider = null;
        const meter = createRequestMeter();
        recordStats = (completionText, extra = {}) => {
          try {
            const timing = meter.finish();
            const isLocal = Boolean(resolvedProvider && resolvedProvider.kind === 'local');
            recordSessionRequest(sendSessionId, {
              configId: isLocal ? 'local' : (expectedConfigId || 'unknown'),
              configLabel: isLocal
                ? tRef.current('chat.stats.localProvider')
                : (onlineConfigLabel || expectedConfigId || ''),
              model: isLocal ? String(resolvedProvider.modelName || '') : onlineModelName,
              promptTokens: estimatePromptTokens(requestMessages),
              completionTokens: estimateReplyTokens(completionText || ''),
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
              signal: controller.signal,
              requestOptions: {
                expectedConfigId,
                expectedConfigFingerprint,
                stream: chatOptions.stream,
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
              // 用户在弹框上犹豫多久都不算超时：runTool 把审批放在超时竞速之外。
              onToolApproval: call => approveToolCall({
                name: call && call.name,
                args: call && call.args,
                t: tRef.current,
                // 用户点「停止生成」时立刻按拒绝结算，不留悬挂的弹框 Promise。
                signal: controller.signal,
              }),
              context: { characterId: character.id, sessionId: sendSessionId },
              allowChatTools: chatToolsEnabled,
            })
          : sendChatMessage(onlineMessages, {
              expectedConfigId,
              expectedConfigFingerprint,
              signal: controller.signal,
           stream: chatOptions.stream,
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
        const reply = await sendWithModelProvider({
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
       setMessages(current => {
        if (!isCurrentSession()) return current;
        return replacePendingWithReply(current, pendingAssistantMessage.id, replyParts);
      });
      if (isCurrentSession()) {
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
    branchesRefreshToken,
  };
}
