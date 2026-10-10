// 工作区主界面：进来就是聊天，左侧一列功能入口，底部一条输入栏。
//
// 布局约定（改版后）：
//   顶部：标题 + 右上角退出叉
//   左侧：竖排入口（新建对话 / 新建项目 / 查找历史 / 综合设置 + 预留位）
//   右侧：聊天消息区，底部一栏「加号 / 语音 / 输入框 / 设置 / 发送」
// 原来的文件面板不再是主视图：已创建文件与历史改动走「查找历史」，
// 导出与环境配置走底部设置列表（通过 onOpenPanel 交给 WorkspacePanel 的子面板）。
//
// 本组件自包含：打开时自己读工作区设置、解析工作区角色、建沙盒 store、拉模型与角色清单，
// 不要求调用方先做一遍初始化——这样它可以独立打开（设置页直接进工作区）。
//
// 指令一条 → runAgentTurn（按当前工作模式暴露工具）→ 流式回显；
// 可附加文本文件（内容并入指令）或图片（多模态）；可录音转文字；
// 不做表情包、不发持久化会话：对话只存在于本次打开期间（「新建对话」= 清空重开）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import {
  appendWorkspaceChatMessages,
  clearWorkspaceChats,
  createWorkspaceChat,
  deleteWorkspaceChat,
  getWorkspaceChats,
  setWorkspaceChatArchived,
  getWorkspaceSettings,
  patchWorkspaceSettings,
  replaceWorkspaceChatMessages,
  saveWorkspaceChatDraft,
  setActiveWorkspaceChat,
} from '../../storage/workspace.js';
import {
  capabilitiesForModel,
  getActiveModel,
  getApiConfigs,
  saveApiConfigs,
} from '../../storage/apiConfigs.js';
import { getActiveLocalModel } from '../../storage/localModels.js';
import { getCharacterLibrary } from '../../storage/characters.js';
import {
  getThinkingSettings,
  getTranscriptionSettings,
  saveThinkingSettings,
} from '../../storage/settings.js';
import { AUTO_COMPACT_RATIO, computeContextUsage, resolveContextWindow } from '../../chat/contextUsage.js';
import { resolveAutoCompactPolicy } from '../../chat/compactionPolicy.js';
import { runCompactionPipeline } from '../../chat/compactionPipeline.js';
import { COMPACTION_RETAIN_RATIO } from '../../chat/compaction.js';
import { estimateMessagesTokens } from '../../localModel/localContext.js';
import { isContextOverflowError, runReactiveCompact } from '../../chat/reactiveCompact.js';
import { extractToolTrace } from '../../chat/toolTrace.js';
import { promptUserChoice } from '../../chat/askUserPrompt.js';
import { writeTranscript } from '../transcripts.js';
import { filterRequestMedia } from '../../prompt/chatPipeline.js';
import { getConfigFingerprint, isCanceledError, sendChatMessage } from '../../network/api.js';
import { resolveTranscription, transcribeAudio } from '../../transcription.js';
import { maskSecrets } from '../../storage/secrets.js';
import { runAgentTurn, workspaceRoundBudget } from '../../agent/loop.js';
import { listToolsForMode } from '../../agent/tools/registry.js';
import { approveToolCall } from '../../chat/toolApprovalFlow.js';
import {
  isImage,
  isTextLike,
  mergeTextAttachments,
  pickAttachment,
  readImageDataUri,
  readTextAttachment,
} from '../../chat/attachments.js';
import useChatRecorder from '../../chat/useChatRecorder.js';
import { readWorkspaceAgents } from '../agents.js';
import { installSampleTeams, readWorkspaceTeams } from '../teams.js';
import { resolveWorkspaceAssistant } from '../assistant.js';
import { createSteeringQueue } from '../../agent/steering.js';
import {
  appendSessionEvent,
  buildSessionEventsExport,
  readSessionEvents,
  sessionEventsPath,
} from '../sessionEvents.js';
import { normalizePlanSteps, shouldOfferPlanApproval } from '../toolDefs/planTool.js';
import { createWorkspaceStore, registerDefaultWorkspaceTools } from '../native.js';
import { ensureWorkspaceMemory, readWorkspaceMemory } from '../memory.js';
import { createReadLog } from '../readLog.js';
import { materializeRepoFile, parseRepoFilePath } from '../repoMaterialize.js';
import { readRepoManifest } from '../repoImport.js';
import { installSampleSkills, readWorkspaceSkills } from '../skills.js';
import { getGithubMcpSettings } from '../../storage/githubMcp.js';
import {
  expandSlashCommand,
  installSampleCommands,
  matchSlashCommands,
  readWorkspaceCommands,
  slashQuery,
} from '../commands.js';
import {
  HOOKS_FILE,
  buildHookContextText,
  collectPromptHooks,
  collectSessionStartNotices,
  collectToolResultNotices,
  collectTurnEndNotices,
  hookPermissionRules,
  installSampleHooks,
  readWorkspaceHooks,
} from '../hooks.js';
import { installWorkspaceTemplate } from '../templates.js';
import { upsertWorkspaceChat } from '../chats.js';
import {
  addPermissionRule,
  clearPermissionRules,
  getEffectivePermissionRules,
} from '../../storage/settings/workspacePermissions.js';
import WorkspaceHistorySheet from '../WorkspaceHistorySheet.js';
import * as Sharing from 'expo-sharing';
import WorkspaceSettingsSheet from '../WorkspaceSettingsSheet.js';
import { hexToRgba } from '../../theme/themes.js';
import {
  buildWorkspaceAgentMessages,
  buildWorkspaceAgentSystemPrompt,
  projectWorkspaceChatHistory,
  toolOrderSignature,
} from '../chat.js';

const MAX_ATTACHMENTS = 3;

let messageSeq = 0;
function nextId() {
  messageSeq += 1;
  return `wsc-${Date.now().toString(36)}-${messageSeq}`;
}

// 输入草稿的内存缓存（模块级，键 `${characterId}:${chatId}`）。
// 为什么要有它：切面板会卸载整个聊天组件（WorkspaceScreen 条件渲染），
// 卸载时落盘是异步的——重新挂载若直接读盘，可能读到落盘前的旧值；
// 内存缓存同步生效，负责「切回来立刻有」，盘上的 chat.draft 负责跨重启。
const draftCache = new Map();
function draftCacheKey(ownerId, chatId) {
  return `${String(ownerId || '')}:${String(chatId || '')}`;
}

export default function ChatPanel({ visible, onOpenPanel, draft = null }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [toolStatus, setToolStatus] = useState('');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('');
  // 已记住的授权（本次会话 + 永久）：打开设置面板时刷新一次即可——
  // 规则只会在「用户点弹框」时变化，而点弹框时用户不在设置面板里。
  const [permissionRules, setPermissionRules] = useState([]);
  // 技能清单（设置面板展示用；发消息时另行直读，两处互不影响）。
  const [workspaceSkills, setWorkspaceSkills] = useState([]);
  // 团队清单（设置面板展示用；发消息时另行直读，两处互不影响）。
  const [workspaceTeams, setWorkspaceTeams] = useState([]);
  // A5 会话级已读登记：read 工具写入、每轮注入「本会话已读」一行；切对话即清
  //（「本会话」的语义边界）。懒初始化——ref 只需要一个稳定实例，不参与渲染。
  const readLogRef = useRef(null);
  if (readLogRef.current === null) readLogRef.current = createReadLog();
  // E1：工具顺序冻结的运行期兜底——同一 mode 下 tools 定义序列漂移会让提供商前缀
  // 缓存全 miss（tools 定义计入缓存键）。顺序契约由 listToolsForMode + 测试保证，
  // 这里只做开发期告警（生产静默），防止未来有人把动态排序混进组装链。
  const toolOrderRef = useRef({});
  // A3 二期：计划进度条——从 update_plan 的工具事件读清单（纯展示，不落盘）；
  // 会话边界（新对话/切对话）清空，与已读登记同款。
  const [agentPlan, setAgentPlan] = useState([]);
  const [planCollapsed, setPlanCollapsed] = useState(false);
  // I1：Steering——agent 运行中输入框保持可用，发送即入队（下一轮请求前注入）；
  // 队列每次发送时新建、turn 结束丢弃（跨轮次的补充没有意义）。
  const steeringRef = useRef(null);
  const [steeringNote, setSteeringNote] = useState('');
  // P0-8：hooks.json 注入类事件的内存记账（session_start 每会话一次；after_turn 排队给下一轮）。
  const hookSessionInjectedRef = useRef(new Set());
  const pendingHookNoticesRef = useRef([]);
  // P0-8：hooks.json 原文（面板展示 + 纯函数校验用；宿主读、面板只展示）。
  const [hooksText, setHooksText] = useState('');
  // I2：read 模式下计划未完成时提议「批准并执行」。**时序关键**：handleSend 的
  // 闭包带着定义时的 mode——不能「切模式后立即调用」（那还是 read 的工具集）。
  // 做法：先切模式，把确认文本挂到 state；effect 在新渲染（mode==='write'）里
  // 用**新的 handleSend** 发起。
  const canApprovePlan = useMemo(
    () => shouldOfferPlanApproval({ mode, plan: agentPlan }),
    [mode, agentPlan]
  );
  const [pendingPlanRun, setPendingPlanRun] = useState(null);
  const approvePlan = useCallback(async () => {
    if (sending || mode !== 'read') return;
    const steps = normalizePlanSteps(agentPlan);
    if (steps.length === 0) return;
    const summary = steps
      .map((item, index) => `${index + 1}. ${item.step}`)
      .join('\n');
    await handleSelectMode('write');
    // 确认消息用用户口吻直述（进对话历史，与 steering 注入语同纪律：不进 i18n）。
    setPendingPlanRun(['我已批准上面的计划，请按计划开始执行：', summary].join('\n'));
  }, [agentPlan, handleSelectMode, mode, sending]);

  // C2 按需物化（给 agent 的 read 工具）：清单内未物化文件被读到、但本地没有时，
  // 单文件拉取回沙盒。三道前置（缺一不发起网络）：是 repos 路径 → 该仓库做过
  // 快速检出（有清单）→ 文件在清单里。token 复用 GitHub 面板的同一份设置。
  const materializeForAgent = useCallback(async path => {
    const store = storeRef.current;
    if (!store || !characterId) return false;
    const target = parseRepoFilePath(path);
    if (!target) return false;
    try {
      const manifest = await readRepoManifest(store, characterId, target);
      if (!manifest) return false;
      if (!manifest.entries.some(item => item.type === 'blob' && item.path === target.rel)) return false;
      const settings = await getGithubMcpSettings();
      const token = settings && settings.enabled
        ? (settings.authMethod === 'oauth' ? settings.githubAccessToken : settings.githubToken)
        : '';
      if (!token) return false;
      const result = await materializeRepoFile({ store, characterId, path, token });
      if (result.ok && readLogRef.current) readLogRef.current.record(path, result.chars);
      return result.ok === true;
    } catch (error) {
      return false;
    }
  }, [characterId]);
  // 斜杠命令（输入框建议列表用；发送时会重读一次拿最新——agent 可能刚建了命令文件）。
  const [workspaceCommands, setWorkspaceCommands] = useState([]);
  // 工作区上下文：角色 / 模式 / 设置快照 / 模型 / 思考强度 / 角色清单 / 上下文占用 / 项目
  const [characterId, setCharacterId] = useState('default');
  const [characterName, setCharacterName] = useState('');
  const [mode, setMode] = useState('ask');
  const [wsSettings, setWsSettings] = useState(null);
  const [models, setModels] = useState([]);
  const [activeModel, setActiveModel] = useState('');
  const [thinking, setThinking] = useState({ enabled: false, level: 'medium' });
  const [characters, setCharacters] = useState([]);
  const [usage, setUsage] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  // 工作区会话（持久化）：列表 + 当前会话。消息随会话存盘，切回旧会话能看回几轮之前的指令。
  const [chatList, setChatList] = useState([]);
  const [activeChatId, setActiveChatId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);

  const recorder = useChatRecorder();
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);
  const scrollRef = useRef(null);
  const storeRef = useRef(null);
  // 拉取/导入用的是打开那一刻的设置快照（中途改根不影响进行中的写入）。
  const wsSettingsRef = useRef(null);
  // recorder 每次渲染都是新对象；把它放进 ref，避免关闭清理 effect 反复触发。
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  // ---- 输入草稿（未发送的输入框内容，按会话各存各的）----
  // 三个 ref 供「卸载时」取值：卸载发生在组件已离开渲染树之后，
  // 清理 effect 的闭包拿不到最新 state，只能提前同步进 ref。
  const inputRef = useRef(input);
  inputRef.current = input;
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;

  // 打字时只写内存（零 IO、不卡输入）；落盘发生在「离开这个输入框」的时点——
  // 卸载（切面板 / 关屏）、切对话、新建对话、发送（清空）。
  const rememberDraft = useCallback((ownerId, chatId, text) => {
    const id = String(chatId || '');
    if (!id) return;
    draftCache.set(draftCacheKey(ownerId, id), String(text === undefined || text === null ? '' : text));
  }, []);

  const persistDraft = useCallback((ownerId, chatId, text) => {
    const id = String(chatId || '');
    if (!id) return;
    const value = String(text === undefined || text === null ? '' : text);
    draftCache.set(draftCacheKey(ownerId, id), value);
    // 落盘失败静默：草稿不值得打断用户（内存缓存还在，切回来照常有）。
    saveWorkspaceChatDraft(ownerId, id, value).catch(() => {});
  }, []);

  // 读草稿：内存优先（同进程内即时、无 IO 竞态），其次盘上的 chat.draft（跨重启）。
  const readDraft = useCallback((ownerId, chatId, fallback) => {
    const id = String(chatId || '');
    if (!id) return '';
    const cached = draftCache.get(draftCacheKey(ownerId, id));
    if (cached !== undefined) return cached;
    return String(fallback === undefined || fallback === null ? '' : fallback);
  }, []);

  // 输入变化：更新界面 + 写内存草稿。落盘刻意不在这里——
  // 每次按键写 AsyncStorage 会拖慢输入，落盘统一放到「离开」的时点。
  const handleInputChange = useCallback(text => {
    setInput(text);
    rememberDraft(characterId, activeChatId, text);
  }, [activeChatId, characterId, rememberDraft]);

  // 跨面板交接：GitHub 工作台的「让助手推送」把一条指令填进输入框。
  // 用 token 判定是否已消费——同一段文本也能重复交接（用户可能连点两次）。
  const consumedDraftRef = useRef(0);
  useEffect(() => {
    if (!draft || !draft.text) return;
    if (consumedDraftRef.current === draft.token) return;
    consumedDraftRef.current = draft.token;
    setSettingsOpen(false);
    setInput(prev => (prev ? `${prev}\n${draft.text}` : draft.text));
  }, [draft]);

  // N2：压缩用的最新消息引用（handleSend 闭包里的 messages 可能落后于本轮追加）+ 重入锁。
  const messagesRef = useRef(messages);
  const compactingRef = useRef(false);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (controllerRef.current) controllerRef.current.abort();
      // 切面板 / 关屏会卸载本组件（WorkspaceScreen 条件渲染）：把最后一次输入落盘。
      // 打字期间不写盘，这里是「防丢」的主兜底（内存缓存负责即时恢复的体验）。
      persistDraft(characterIdRef.current, activeChatIdRef.current, inputRef.current);
    };
  }, [persistDraft]);

  // 关闭时清空这一轮的临时对话与正在生成的请求（下次进来是干净的对话）。
  // 草稿是例外：先落盘保存再清界面输入框——消息「关闭即清空」是有意设计，
  // 输入草稿跟着陪葬是连带误伤（用户切个面板回来就得重打）。
  useEffect(() => {
    if (visible) return;
    if (controllerRef.current) controllerRef.current.abort();
    persistDraft(characterIdRef.current, activeChatIdRef.current, inputRef.current);
    setMessages([]);
    setInput('');
    setAttachments([]);
    setToolStatus('');
    setSending(false);
    setSettingsOpen(false);
    setSettingsSection('');
    setHistoryOpen(false);
    if (recorderRef.current.recording) recorderRef.current.cancel();
  }, [visible, persistDraft]);

  // 上下文占用：按工作区会话（workspaceChats）自身历史估算——压缩对象与占用口径一致。
  // （此前读的是角色单聊 session，与工作区历史不是同一份数据。）
  const loadUsage = useCallback(async ownerId => {
    try {
      const [{ configs, activeId }, localItem, bucket] = await Promise.all([
        getApiConfigs(),
        getActiveLocalModel().catch(() => null),
        getWorkspaceChats(ownerId).catch(() => null),
      ]);
      const active = bucket
        && (bucket.chats.find(item => item.id === bucket.activeId) || bucket.chats[0]);
      const list = (active && active.messages) || [];
      const current = configs.find(item => item.id === activeId) || configs[0];
      const model = current ? getActiveModel(current) : '';
      const caps = capabilitiesForModel(current, model);
      const localContextSize = Number(localItem && localItem.contextSize) || 0;
      const computed = computeContextUsage(list, resolveContextWindow({
        declared: caps.contextWindow,
        localContextSize,
        model,
      }));
      if (mountedRef.current) setUsage(computed);
    } catch (error) {
      if (mountedRef.current) setUsage(null);
    }
  }, []);

  // 载入某个角色的工作区会话：有就接着上次那条（连同消息与输入草稿），
  // 没有就新建一条空会话。草稿优先取内存缓存，其次盘上该会话的 draft 字段。
  const loadChats = useCallback(async ownerId => {
    try {
      const bucket = await getWorkspaceChats(ownerId);
      if (!mountedRef.current) return;
      if (bucket.chats.length) {
        const active = bucket.chats.find(item => item.id === bucket.activeId) || bucket.chats[0];
        setChatList(bucket.chats);
        setActiveChatId(active.id);
        setMessages(active.messages);
        setInput(readDraft(ownerId, active.id, active.draft));
        return;
      }
      const created = await createWorkspaceChat(ownerId);
      if (!mountedRef.current) return;
      setChatList(created ? [created] : []);
      setActiveChatId(created ? created.id : '');
      setMessages([]);
      setInput('');
    } catch (error) {}
  }, [readDraft]);

  // 把 user 消息与 assistant 终稿追加进所在会话。流式期间不落盘（每帧写一次会拖垮存储），
  // 只在发送时与结束/失败时各写一次；按消息 id 去重，重复落盘不会产生重复条目。
  const persistMessages = useCallback(async (ownerId, chatId, list) => {
    const items = (Array.isArray(list) ? list : [list]).filter(item => item && item.id);
    if (!ownerId || !chatId || !items.length) return;
    try {
      const updated = await appendWorkspaceChatMessages(ownerId, chatId, items);
      if (!updated || !mountedRef.current) return;
      setChatList(prev => upsertWorkspaceChat(prev, updated));
    } catch (error) {}
  }, []);

  // N2：工作区会话压缩（四档管线）。展示历史里没有 tool 消息，L0/L1 自然空转，
  // 实际走 L2 摘要 + L3 归档——即「摘要旧史 + 保留尾部」。silent=true 时按 0.8 线自判
  //（每轮自动调用）；手动时 autoRatio=0 强制压缩。失败一律不改会话（压缩是增强）。
  const compactWorkspaceNow = useCallback(async ({ silent = false, list: overrideList = null } = {}) => {
    if (compactingRef.current) return { ok: false, reason: 'busy' };
    const list = Array.isArray(overrideList)
      ? overrideList
      : (Array.isArray(messagesRef.current) ? messagesRef.current : []);
    if (list.length < 2) return { ok: false, reason: 'too-short' };
    compactingRef.current = true;
    try {
      const [{ configs, activeId }, localItem] = await Promise.all([
        getApiConfigs(),
        getActiveLocalModel().catch(() => null),
      ]);
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current) return { ok: false, reason: 'failed' };
      const model = getActiveModel(current);
      const caps = capabilitiesForModel(current, model);
      const localContextSize = Number(localItem && localItem.contextSize) || 0;
      const windowSize = resolveContextWindow({ declared: caps.contextWindow, localContextSize, model });
      // 阈值统一走 compactionPolicy（Z 系采纳 #5：模型感知 + 输出预留 + 缓冲）。
      const policy = resolveAutoCompactPolicy({ contextWindow: windowSize });
      const autoRatio = windowSize > 0 ? policy.thresholdTokens / windowSize : AUTO_COMPACT_RATIO;
      const chatId = activeChatIdRef.current;
      const ownerId = characterIdRef.current;
      const result = await runCompactionPipeline(list, {
        autoRatio: silent ? autoRatio : 0,
        deps: {
          estimateRatio: msgs => computeContextUsage(msgs, windowSize).ratio,
          summarize: request => sendChatMessage(request, {
            stream: false,
            expectedConfigId: String(current.id || ''),
            expectedConfigFingerprint: getConfigFingerprint(current),
          }),
          writeTranscript: jsonl => writeTranscript({ store: storeRef.current, characterId: ownerId, content: jsonl }),
          // P4：保留量按 token 预算（窗口的 16%，对齐 dsh retainRatio），下限仍是 6 条。
          retainTokens: Math.max(0, Math.floor(windowSize * COMPACTION_RETAIN_RATIO)),
          estimateTokens: msg => estimateMessagesTokens([{
            role: msg && msg.role,
            content: String((msg && (msg.content != null ? msg.content : msg.text)) || ''),
          }]),
        },
      });
      if (result.applied.length > 0 && result.messages !== list) {
        if (mountedRef.current) setMessages(result.messages);
        await replaceWorkspaceChatMessages(ownerId, chatId, result.messages);
        return { ok: true, applied: result.applied };
      }
      return { ok: false, reason: 'noop' };
    } catch (error) {
      return { ok: false, reason: 'failed' };
    } finally {
      compactingRef.current = false;
    }
  }, []);

  // 打开设置面板时刷新「已记住的授权」与技能清单（列表与按钮共用这两份数据）。
  // 时机够用：规则只在用户点确认弹框时变化，技能只在用户编辑文件时变化。
  useEffect(() => {
    if (!settingsOpen) return undefined;
    let alive = true;
    getEffectivePermissionRules()
      .then(rules => {
        if (alive) setPermissionRules(Array.isArray(rules) ? rules : []);
      })
      .catch(() => {});
    readWorkspaceSkills(storeRef.current, characterId)
      .then(list => {
        if (alive) setWorkspaceSkills(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
    readWorkspaceTeams(storeRef.current, characterId)
      .then(list => {
        if (alive) setWorkspaceTeams(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [settingsOpen, characterId]);

  // 打开时自解析：设置快照 → 沙盒 store → 工作区角色 → 模型 / 思考 / 角色清单 / 项目。
  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        if (!alive) return;
        setMode(settings.mode);
        setWsSettings(settings);
        wsSettingsRef.current = settings;
        try {
          storeRef.current = createWorkspaceStore(settings);
        } catch (error) {
          storeRef.current = null;
        }

        const resolved = await resolveWorkspaceAssistant(settings.assistantCharacterId);
        if (!alive) return;
        if (resolved.character) {
          setCharacterId(resolved.id);
          setCharacterName(String(resolved.character.name || resolved.id));
          if (resolved.persist) {
            patchWorkspaceSettings({ assistantCharacterId: resolved.id }).catch(() => {});
          }
        }
        const ownerId = resolved.id || settings.assistantCharacterId || 'default';
        loadUsage(ownerId);
        loadChats(ownerId);
        // 斜杠命令：打开面板时读一次供建议列表用（发送时还会重读，见 handleSend）。
        readWorkspaceCommands(storeRef.current, ownerId)
          .then(list => {
            if (alive) setWorkspaceCommands(Array.isArray(list) ? list : []);
          })
          .catch(() => {});
        // P0-8：hooks.json 原文——面板要展示「装了几条、哪条写坏了」，读失败当空（面板显示未配置）。
        try {
          const hookFile = await storeRef.current.readWorkspaceFile({ characterId: ownerId, path: HOOKS_FILE });
          if (alive) setHooksText(String((hookFile && hookFile.content) || ''));
        } catch (error) {
          if (alive) setHooksText('');
        }

        // 首次打开工作区（可改模式）：生成一份 AGENTS.md 模板当起点。
        // 幂等且绝不覆盖已有文件——用户或 agent 改过的内容就是它存在的意义；
        // 无写权限（外部文件夹根）时失败静默，不打扰任何流程。
        if (storeRef.current && settings.mode === 'write') {
          ensureWorkspaceMemory(storeRef.current, ownerId, settings.mode).catch(() => {});
        }

        const { configs, activeId } = await getApiConfigs().catch(() => ({ configs: [], activeId: '' }));
        if (alive) {
          const cfg = (configs || []).find(item => item.id === activeId) || (configs || [])[0] || null;
          setModels(cfg && Array.isArray(cfg.models) ? cfg.models : []);
          setActiveModel(cfg ? getActiveModel(cfg) : '');
        }

        const thinkingSettings = await getThinkingSettings().catch(() => null);
        if (alive && thinkingSettings) setThinking(thinkingSettings);

        const library = await getCharacterLibrary().catch(() => []);
        if (alive) setCharacters(Array.isArray(library) ? library : []);
      } catch (error) {}
    })();
    return () => { alive = false; };
  }, [visible, loadChats, loadUsage]);

  const updateAssistant = useCallback((id, patch) => {
    setMessages(list => list.map(item => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const removeAttachment = useCallback(id => {
    setAttachments(list => list.filter(item => item.id !== id));
  }, []);

  // 新建对话：另开一条会话（旧的留在历史里，随时切回来），而不是把上一条清掉。
  const handleNewChat = useCallback(async () => {
    if (controllerRef.current) controllerRef.current.abort();
    // 先把当前输入存回原会话，再开新的（新会话的输入框是干净的）。
    persistDraft(characterId, activeChatId, input);
    setMessages([]);
    setInput('');
    setAttachments([]);
    setToolStatus('');
    setSending(false);
    setSettingsSection('');
    // A5：新对话 = 新会话 → 已读登记清零（它记的是「这次对话读过了什么」）。
    if (readLogRef.current) readLogRef.current.clear();
    // A3 二期：计划进度条同属会话边界——新对话清空。
    setAgentPlan([]);
    try {
      const created = await createWorkspaceChat(characterId);
      if (!created || !mountedRef.current) return;
      setActiveChatId(created.id);
      setChatList(prev => upsertWorkspaceChat(prev, created));
    } catch (error) {}
  }, [activeChatId, characterId, input, persistDraft]);

  // 切到历史里的某条会话：先中止在途生成，把当前输入存回原会话，
  // 再把目标那条的消息与草稿读进界面（A→B→A 回来，A 的草稿还在）。
  const handleSelectChat = useCallback(async id => {
    const target = chatList.find(item => item.id === id);
    if (!target) return;
    if (controllerRef.current) controllerRef.current.abort();
    persistDraft(characterId, activeChatId, input);
    setActiveChatId(id);
    setMessages(target.messages);
    setInput(readDraft(characterId, id, target.draft));
    setAttachments([]);
    setToolStatus('');
    setSending(false);
    setHistoryOpen(false);
    // A5：切对话 = 换会话 → 已读登记清零（不把上一条会话的阅读史带过去）。
    if (readLogRef.current) readLogRef.current.clear();
    // A3 二期：计划进度条同属会话边界——切对话清空（不带旧计划过去）。
    setAgentPlan([]);
    await setActiveWorkspaceChat(characterId, id).catch(() => {});
  }, [activeChatId, characterId, chatList, input, persistDraft, readDraft]);

  // I5：归档/恢复会话——切 storage 标记后刷新本地列表；归档的是当前会话时
  // 顺带切到下一个未归档会话（不留在一个「看不见」的会话里）。
  const handleArchiveChat = useCallback(async (chatId, archived) => {
    try {
      await setWorkspaceChatArchived(characterId, chatId, archived);
    } catch (error) {}
    try {
      const bucket = await getWorkspaceChats(characterId);
      const chats = (bucket && bucket.chats) || [];
      if (mountedRef.current) setChatList(chats);
      if (archived === true && String(activeChatId) === String(chatId)) {
        const next = chats.find(item => item.id !== chatId && item.archived !== true);
        if (next) await handleSelectChat(next.id);
      }
    } catch (error) {}
  }, [activeChatId, characterId, handleSelectChat]);

  const handleDeleteChat = useCallback(async id => {
    setHistoryBusy(true);
    try {
      const bucket = await deleteWorkspaceChat(characterId, id);
      if (!bucket || !mountedRef.current) return;
      setChatList(bucket.chats);
      // 删掉的正是当前会话时，切到新的活跃会话（可能已空）
      if (String(bucket.activeId) !== String(activeChatId)) {
        const target = bucket.chats.find(item => item.id === bucket.activeId);
        setActiveChatId(bucket.activeId || '');
        setMessages(target ? target.messages : []);
        setInput(target ? readDraft(characterId, target.id, target.draft) : '');
      }
      if (!bucket.chats.length) {
        const created = await createWorkspaceChat(characterId);
        if (!created || !mountedRef.current) return;
        setChatList([created]);
        setActiveChatId(created.id);
        setMessages([]);
        setInput('');
      }
    } catch (error) {
    } finally {
      if (mountedRef.current) setHistoryBusy(false);
    }
  }, [activeChatId, characterId]);

  const handleClearChats = useCallback(async () => {
    setHistoryBusy(true);
    try {
      await clearWorkspaceChats(characterId).catch(() => {});
      const created = await createWorkspaceChat(characterId);
      if (!mountedRef.current) return;
      setChatList(created ? [created] : []);
      setActiveChatId(created ? created.id : '');
      setMessages([]);
      setInput('');
      setHistoryOpen(false);
    } catch (error) {
    } finally {
      if (mountedRef.current) setHistoryBusy(false);
    }
  }, [characterId]);

  // ---- 设置面板回调（都写回存储，改完即生效） ----

  const handleSelectModel = useCallback(async name => {
    try {
      const { configs, activeId } = await getApiConfigs();
      const next = (configs || []).map(item => (
        item.id === activeId ? { ...item, activeModel: String(name) } : item
      ));
      await saveApiConfigs(next, activeId);
      if (mountedRef.current) {
        setActiveModel(String(name));
        loadUsage(characterId);
      }
    } catch (error) {}
  }, [characterId, loadUsage]);

  // 思考强度：off = 关闭思考；其余档位对应 low/medium/high（全局设置，保存即生效）。
  const handleSelectThinking = useCallback(async choice => {
    if (!['off', 'low', 'medium', 'high'].includes(choice)) return;
    const next = {
      enabled: choice !== 'off',
      level: choice === 'off' ? (thinking.level || 'medium') : choice,
      display: thinking.display || 'fold',
    };
    setThinking(next);
    try {
      const saved = await saveThinkingSettings(next);
      if (mountedRef.current && saved) setThinking(saved);
    } catch (error) {
      getThinkingSettings()
        .then(current => { if (mountedRef.current && current) setThinking(current); })
        .catch(() => {});
    }
  }, [thinking]);

  const handleSelectMode = useCallback(async choice => {
    if (!['ask', 'read', 'write'].includes(choice)) return;
    setMode(choice);
    try {
      await patchWorkspaceSettings({ mode: choice });
      const settings = await getWorkspaceSettings();
      if (mountedRef.current) {
        setWsSettings(settings);
        wsSettingsRef.current = settings;
      }
    } catch (error) {}
  }, []);

  const handleSelectCharacter = useCallback(async id => {
    const next = String(id || '');
    if (!next) return;
    setCharacterId(next);
    const found = (Array.isArray(characters) ? characters : []).find(item => item && item.id === next);
    setCharacterName(found ? String(found.name || next) : next);
    try {
      await patchWorkspaceSettings({ assistantCharacterId: next });
      loadUsage(next);
      // 会话按角色分区：切角色要换一整套历史，不能把上一个角色的对话留在界面上。
      await loadChats(next);
    } catch (error) {}
  }, [characters, loadChats, loadUsage]);

  // 导入文件：选一个文本文件复制进沙盒（角色随后就能读它）。
  // 安装示例技能（3 个，幂等：已有的绝不覆盖）——技能是文件，用户在文件面板里
  // 自由编辑，这里只负责给一个能跑的起点。
  const handleInstallSampleSkills = useCallback(async () => {
    let installed = 0;
    try {
      installed = await installSampleSkills(storeRef.current, characterId);
    } catch (error) {}
    try {
      const list = await readWorkspaceSkills(storeRef.current, characterId);
      setWorkspaceSkills(Array.isArray(list) ? list : []);
    } catch (error) {}
    if (installed > 0) {
      Alert.alert(
        t('workspace.settings.skills.installDoneTitle'),
        t('workspace.settings.skills.installDone', { count: installed })
      );
    } else {
      Alert.alert(
        t('workspace.settings.skills.installNoneTitle'),
        t('workspace.settings.skills.installNone')
      );
    }
  }, [characterId, t]);

  const handleInstallSampleTeams = useCallback(async () => {
    let installed = 0;
    try {
      installed = await installSampleTeams(storeRef.current, characterId);
    } catch (error) {}
    try {
      const list = await readWorkspaceTeams(storeRef.current, characterId);
      setWorkspaceTeams(Array.isArray(list) ? list : []);
    } catch (error) {}
    if (installed > 0) {
      Alert.alert(
        t('workspace.settings.teams.installDoneTitle'),
        t('workspace.settings.teams.installDone', { count: installed })
      );
    } else {
      Alert.alert(
        t('workspace.settings.teams.installNoneTitle'),
        t('workspace.settings.teams.installNone')
      );
    }
  }, [characterId, t]);

  // 斜杠命令建议：输入以 / 开头、且还在打命令名（没出炉空格）时才出现，
  // 选中即把 `/名字 ` 填回输入框（走 handleInputChange，草稿缓存同步）。
  const slashSuggestions = useMemo(() => {
    if (sending) return [];
    const query = slashQuery(input);
    if (query === null) return [];
    return matchSlashCommands(workspaceCommands, query);
  }, [input, sending, workspaceCommands]);

  // 安装示例命令（3 个，幂等：同名的绝不覆盖），与示例技能同一套惯例。
  const handleInstallSampleCommands = useCallback(async () => {
    let installed = 0;
    try {
      installed = await installSampleCommands(storeRef.current, characterId);
    } catch (error) {}
    try {
      const list = await readWorkspaceCommands(storeRef.current, characterId);
      setWorkspaceCommands(Array.isArray(list) ? list : []);
    } catch (error) {}
    if (installed > 0) {
      Alert.alert(
        t('workspace.settings.commands.installDoneTitle'),
        t('workspace.settings.commands.installDone', { count: installed })
      );
    } else {
      Alert.alert(
        t('workspace.settings.commands.installNoneTitle'),
        t('workspace.settings.commands.installNone')
      );
    }
  }, [characterId, t]);

  // P0-8：安装示例 hooks.json——**已存在就绝不覆盖**（用户可能已经写了自己的规则，
  // 覆盖等于静默销毁他的配置）；结果如实汇报，装完重读原文刷新面板。
  const handleInstallSampleHooks = useCallback(async () => {
    let installed = false;
    try {
      installed = await installSampleHooks(storeRef.current, characterId);
    } catch (error) {}
    try {
      const file = await storeRef.current.readWorkspaceFile({ characterId, path: HOOKS_FILE });
      setHooksText(String((file && file.content) || ''));
    } catch (error) {
      setHooksText('');
    }
    Alert.alert(
      installed
        ? t('workspace.settings.hooks.installDoneTitle')
        : t('workspace.settings.hooks.installNoneTitle'),
      installed
        ? t('workspace.settings.hooks.installDone')
        : t('workspace.settings.hooks.installNone')
    );
  }, [characterId, t]);

  // 工作区模板（T9）：一键铺起始文件；幂等不覆盖，结果如实汇报（创建/跳过/失败）。
  const handleInstallTemplate = useCallback(async templateId => {
    let result = { created: [], skipped: [], failed: [] };
    try {
      result = await installWorkspaceTemplate(storeRef.current, characterId, templateId);
    } catch (error) {}
    const base = t('workspace.settings.templates.done', {
      created: result.created.length,
      skipped: result.skipped.length,
    });
    const failed = result.failed.length > 0
      ? `\n${t('workspace.settings.templates.doneFailed', { count: result.failed.length })}`
      : '';
    Alert.alert(t('workspace.settings.templates.doneTitle'), `${base}${failed}`);
  }, [characterId, t]);

  // E4：导出会话事件流（读 jsonl → 导出文本落盘 → 系统分享；无事件如实提示）。
  // 落盘到 `.easychat/sessions/<id>.export.txt`——分享失败也能在文件面板找到。
  const exportSessionEvents = useCallback(async () => {
    const id = String(activeChatId || '').trim();
    if (!id || !storeRef.current) return;
    try {
      const events = await readSessionEvents(storeRef.current, characterId, id);
      if (events.length === 0) {
        Alert.alert(t('workspace.settings.events.title'), t('workspace.settings.events.empty'));
        return;
      }
      const text = buildSessionEventsExport(events, { title: id });
      const path = sessionEventsPath(id).replace(/\.jsonl$/, '.export.txt');
      await storeRef.current.writeWorkspaceFile({ characterId, path, content: text });
      let uri = null;
      try {
        uri = await storeRef.current.fileUri({ characterId, path });
      } catch (error) {}
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (available && uri) {
        await Sharing.shareAsync(uri, { dialogTitle: t('workspace.settings.events.title') });
      } else {
        Alert.alert(t('workspace.settings.events.title'), t('workspace.settings.events.saved', { path }));
      }
    } catch (error) {
      Alert.alert(t('workspace.settings.events.title'), t('workspace.settings.events.fail'));
    }
  }, [activeChatId, characterId, t]);

  // 清除全部授权（永久 + 本次会话）：清完重读一次回填界面。
  // 存储失败也重读：以盘上的真实状态为准，界面不撒谎。
  const handleClearPermissionRules = useCallback(async () => {
    try {
      await clearPermissionRules();
    } catch (error) {}
    try {
      const rules = await getEffectivePermissionRules();
      setPermissionRules(Array.isArray(rules) ? rules : []);
    } catch (error) {
      setPermissionRules([]);
    }
  }, []);

  // P0-6：手写一条规则（设置面板的表单）。落盘走 addPermissionRule——与弹框
  // 「永远允许」同一条链路（同 effect+tool+match 去重），写完重读回填界面。
  const handleAddPermissionRule = useCallback(async rule => {
    try {
      await addPermissionRule(rule);
    } catch (error) {}
    try {
      const rules = await getEffectivePermissionRules();
      setPermissionRules(Array.isArray(rules) ? rules : []);
    } catch (error) {}
  }, []);

  // P1-11：保留口径（快照条数 / 回滚基线份数 / 事件流上限）。落盘后**重建 store**——
  // 生效口径是随 store 带进三个旁路模块的，不重建就会出现「设置改了但本轮还是老上限」。
  const handleChangeRetention = useCallback(async next => {
    try {
      const settings = await patchWorkspaceSettings({ retention: next });
      if (mountedRef.current) {
        setWsSettings(settings);
        wsSettingsRef.current = settings;
      }
      try {
        storeRef.current = createWorkspaceStore(settings);
      } catch (error) {}
    } catch (error) {}
  }, []);

  const handleImportFile = useCallback(async () => {
    if (importBusy) return;
    const store = storeRef.current;
    if (!store) {
      Alert.alert(t('workspace.settings.title'), t('workspace.panel.err.fileSystem'));
      return;
    }
    setImportBusy(true);
    try {
      const asset = await pickAttachment();
      if (!asset) return;
      if (!isTextLike(asset.name, asset.mime)) {
        Alert.alert(t('workspace.settings.import.errTitle'), t('workspace.settings.import.errBody'));
        return;
      }
      const text = await readTextAttachment(asset.uri);
      const name = String(asset.name || '').split('/').pop() || 'imported.txt';
      await store.writeWorkspaceFile({ characterId, path: `imports/${name}`, content: text });
      Alert.alert(
        t('workspace.settings.import.doneTitle'),
        t('workspace.settings.import.done', { name })
      );
    } catch (error) {
      Alert.alert(
        t('workspace.settings.import.errTitle'),
        maskSecrets((error && error.message) || t('workspace.settings.import.errBody'))
      );
    } finally {
      if (mountedRef.current) setImportBusy(false);
    }
  }, [characterId, importBusy, t]);

  // 下载失败的文案：project.js 只给错误码与英文细节，中文提示在这一层取（i18n 收口）。
  // ---- 聊天 ----

  const onPickAttachment = useCallback(async () => {
    try {
      const asset = await pickAttachment();
      if (!asset) return;
      if (isImage(asset.name, asset.mime)) {
        const dataUri = await readImageDataUri(asset.uri, asset.mime);
        setAttachments(list => [...list, { id: nextId(), kind: 'image', name: asset.name, dataUri }].slice(0, MAX_ATTACHMENTS));
        return;
      }
      if (isTextLike(asset.name, asset.mime)) {
        const text = await readTextAttachment(asset.uri);
        setAttachments(list => [...list, { id: nextId(), kind: 'text', name: asset.name, text }].slice(0, MAX_ATTACHMENTS));
        return;
      }
      Alert.alert(t('workspace.chat.attach.err.title'), t('workspace.chat.attach.err.body'));
    } catch (error) {
      Alert.alert(
        t('workspace.chat.attach.err.title'),
        maskSecrets((error && error.message) || t('workspace.chat.attach.err.body'))
      );
    }
  }, [t]);

  const onStopVoice = useCallback(async () => {
    if (voiceBusy) return;
    setVoiceBusy(true);
    try {
      const audio = await recorder.stop();
      if (!audio || !audio.uri) return;
      const [{ configs, activeId }, transcriptionSettings] = await Promise.all([
        getApiConfigs(),
        getTranscriptionSettings().catch(() => ({ activeId: '', configs: [] })),
      ]);
      const activeChat = configs.find(item => item.id === activeId) || configs[0] || null;
      const dedicated = (transcriptionSettings.configs || []).find(item => item.id === transcriptionSettings.activeId) || null;
      const target = resolveTranscription({ chatConfig: activeChat, dedicated });
      if (target.source === 'none') {
        Alert.alert(t('workspace.chat.voice.none.title'), t('workspace.chat.voice.none.body'));
        return;
      }
      const result = await transcribeAudio({ config: target, fileUri: audio.uri, mime: audio.mime });
      const text = String(result.text || '').trim();
      if (text) setInput(prev => (prev ? `${prev} ${text}` : text));
    } catch (error) {
      Alert.alert(t('workspace.chat.voice.err.title'), maskSecrets((error && error.message) || t('workspace.chat.voice.err.body')));
    } finally {
      if (mountedRef.current) setVoiceBusy(false);
    }
  }, [recorder, t, voiceBusy]);

  const handleStop = useCallback(() => {
    if (controllerRef.current) controllerRef.current.abort();
  }, []);

  // I2：overrideText——计划批准链路在模式切换后的新渲染里带确认文本发起。
  const handleSend = useCallback(async overrideText => {
    // onPress={handleSend} 会把 press 事件当第一参传入；overrideText 只认**字符串**
    // （批准链路传字符串）——其余（含事件对象）一律当「无覆盖」，用输入框内容。
    const hasOverride = typeof overrideText === 'string';
    const text = String(hasOverride ? overrideText : input).trim();
    // N2：手动压缩命令 `/compact`（工作区会话）。
    if (!sending && text === '/compact') {
      if (!hasOverride) {
        setInput('');
        persistDraft(characterId, activeChatId, '');
      }
      const result = await compactWorkspaceNow({ silent: false });
      if (result.ok) {
        Alert.alert(t('workspace.chat.compact.title'), t('workspace.chat.compact.done', { applied: result.applied.join('+') }));
      } else if (result.reason === 'noop' || result.reason === 'too-short') {
        Alert.alert(t('workspace.chat.compact.title'), t('workspace.chat.compact.noop'));
      } else if (result.reason !== 'busy') {
        Alert.alert(t('workspace.chat.compact.title'), t('workspace.chat.compact.fail'));
      }
      return;
    }
    // I1：Steering——agent 运行中发送 = 中途补充指令（不新开 turn、不中断工具链）。
    // 附件不支持（补充指令是纯文本语义）；空文本忽略。
    if (sending) {
      if (!text) return;
      if (attachments.length > 0) {
        Alert.alert(t('workspace.chat.steering.title'), t('workspace.chat.steering.attachments'));
        return;
      }
      if (steeringRef.current && steeringRef.current.push(text)) {
        setInput('');
        persistDraft(characterId, activeChatId, '');
        setSteeringNote(t('workspace.chat.steering.note'));
      }
      return;
    }
    const textAttachments = attachments.filter(item => item.kind === 'text');
    const imageAttachments = attachments.filter(item => item.kind === 'image');
    const userText = mergeTextAttachments(text, textAttachments);
    const images = imageAttachments.map(item => item.dataUri);
    if (!userText && images.length === 0) return;

    // 斜杠命令展开：发送时按**最新**命令表展开（agent 可能刚在工作区里建了命令文件，
    // 打开面板时读的那份会过期）；气泡与落盘照旧保存用户输入原文，展开文本只进这一轮请求。
    let outgoingText = userText;
    try {
      const freshCommands = await readWorkspaceCommands(storeRef.current, characterId);
      setWorkspaceCommands(Array.isArray(freshCommands) ? freshCommands : []);
      const expanded = expandSlashCommand(userText, freshCommands);
      if (expanded) outgoingText = expanded.text;
    } catch (error) {}

    // P0-8：提交前钩子（before_prompt）与注入（session_start / 上一轮的 after_turn）。
    // 必须放在**落库与置 sending 之前**：拦下时不该留下已发出的消息或卡住的「正在生成」。
    let hookText = '';
    try {
      const hooks = await readWorkspaceHooks(storeRef.current, characterId);
      const promptHooks = collectPromptHooks(hooks, outgoingText);
      if (promptHooks.blocks.length > 0) {
        Alert.alert(t('chat.hooks.blocked.title'), promptHooks.blocks.join('\n'));
        return;
      }
      const sessionKey = String(activeChatId || '');
      const sessionNotices = sessionKey && !hookSessionInjectedRef.current.has(sessionKey)
        ? collectSessionStartNotices(hooks)
        : [];
      if (sessionNotices.length > 0 && sessionKey) hookSessionInjectedRef.current.add(sessionKey);
      hookText = buildHookContextText([
        ...pendingHookNoticesRef.current,
        ...sessionNotices,
        ...promptHooks.notices,
      ]);
      // after_turn 的提醒排队给下一轮（内存队列，重启即丢）。
      pendingHookNoticesRef.current = collectTurnEndNotices(hooks);
    } catch (error) {}

    const userMessage = {
      id: nextId(),
      role: 'user',
      content: userText || (images.length ? t('workspace.chat.imageTag') : ''),
      at: Date.now(),
    };
    const assistantId = nextId();
    const history = messages;
    // 会话与角色在这里定住：生成过程中用户可能切会话或切角色，
    // 落盘仍要写回开始生成时那一条，不能跟着界面状态漂走。
    const chatId = activeChatId;
    const ownerId = characterId;
    let assistantFinal = { id: assistantId, role: 'assistant', content: '', isError: false, at: Date.now() };
    // P5：本轮工具轨迹（onTranscript 回抛；挂到助手终稿上持久化，供下轮 agent 历史展开）。
    let turnTrace = null;
    setMessages(list => [...list, userMessage, { id: assistantId, role: 'assistant', content: '' }]);
    // 发出去了：清空输入框、同时把该会话的草稿清掉（内存 + 盘），
    // 否则下次切回来会把已经发过的话又填回输入框。
    // I2：批准链路（overrideText）不碰输入框、草稿与附件——用户可能正打着别的话。
    if (!hasOverride) {
      persistDraft(ownerId, chatId, '');
      setInput('');
      setAttachments([]);
    }
    setSending(true);
    setToolStatus('');
    persistMessages(ownerId, chatId, [userMessage]);
    // E4：会话事件流（旁路审计）——user 事件。不 await、写失败静默（事件流绝不挡消息链路）。
    appendSessionEvent(storeRef.current, ownerId, chatId, 'user', {
      text: String(userMessage.content || '').slice(0, 1000),
    });

    const controller = new AbortController();
    controllerRef.current = controller;
    // I1：本轮的 Steering 队列（handleSend 的 sending 分支往里 push，loop 每轮前 drain）。
    steeringRef.current = createSteeringQueue();
    setSteeringNote('');

    // 先注册工具、再拼提示词：提示词里要不要写「可以跑 Python / 可以执行命令」，判据是
    // **注册表里真的有**（开关开着但原生模块缺失、或根是外部文件夹时并不存在），
    // 所以必须以后者为准——否则提示词会承诺一个调不动的能力，模型会反复尝试然后乱解释。
    let tools = [];
    if (mode !== 'ask') {
      try {
        registerDefaultWorkspaceTools(wsSettingsRef.current || wsSettings, {
          readLog: readLogRef.current,
          materializer: materializeForAgent,
        });
        tools = listToolsForMode(mode);
        // E1：工具顺序冻结兜底——同一 mode 下 tools 序列漂移 = 前缀缓存全 miss
        //（tools 定义计入缓存键）。开发期告警、生产静默；mode 切换不算漂移。
        const orderSignature = toolOrderSignature(tools);
        const prevOrder = toolOrderRef.current[mode];
        if (prevOrder && prevOrder !== orderSignature && typeof __DEV__ !== 'undefined' && __DEV__) {
          console.warn('[cache] 工具顺序在会话内发生变化（会打碎前缀缓存）：', prevOrder, '→', orderSignature);
        }
        toolOrderRef.current[mode] = orderSignature;
      } catch (error) {}
    }
    // 工作区记忆（AGENTS.md）：每轮直读、不缓存——agent 可能刚在上一轮里改过它
    //（自我演进通路），缓存一旦判断失误模型就会按旧指令工作；读失败当没有，不打扰聊天。
    const memory = await readWorkspaceMemory(storeRef.current, ownerId);
    // 技能清单（渐进披露第一层）：同样每轮直读——技能目录不存在时只有一次 list IO。
    const skills = mode === 'ask' ? [] : await readWorkspaceSkills(storeRef.current, ownerId);
    // E3：分身档案清单（渐进披露第一层）——同样每轮直读；run_subagent 没注册时
    // 提示词自动不注入（buildWorkspaceAgentSystemPrompt 内部判据）。
    const agents = mode === 'ask' ? [] : await readWorkspaceAgents(storeRef.current, ownerId);
    // 团队清单（持久化团队）：同样每轮直读；run_team 没注册时提示词自动不注入。
    const teams = mode === 'ask' ? [] : await readWorkspaceTeams(storeRef.current, ownerId);
    const systemPrompt = buildWorkspaceAgentSystemPrompt({
      mode,
      characterName,
      tools: tools.map(item => item.function.name),
      memory,
      skills,
      agents,
      teams,
      // A5：本会话已读清单（本轮注入的 read 结果里，上一轮读过的会出现在这行）。
      readLog: readLogRef.current ? readLogRef.current.list() : [],
      // P0-8：hooks.json 的注入类事件（放在 readLog 之前，见该函数的缓存契约）。
      hookText,
    });
    let request = buildWorkspaceAgentMessages({
      systemPrompt,
      history: projectWorkspaceChatHistory(history),
      // 斜杠命令在这里生效：outgoingText = 用户输入原文，或命令展开后的文本。
      userText: outgoingText,
      images,
    });
    try {
      const { configs, activeId } = await getApiConfigs();
      const cfg = configs.find(item => item.id === activeId) || configs[0] || null;
      request = filterRequestMedia(request, { allowVision: Boolean(cfg && cfg.supportsVision), allowAudio: false });
    } catch (error) {}

    try {
      let overflowRetried = false;
      while (true) {
        try {
          await runAgentTurn(request, {
        mode,
        tools,
        // 轮次预算（A1）：可改 16 / 只读 10——写任务要跑「改-验」循环，天然更长。
        maxRounds: workspaceRoundBudget(mode),
        // I1：Steering 队列（用户中途补充指令，每轮请求前注入）。
        steering: steeringRef.current,
        signal: controller.signal,
        requestOptions: { stream: true },
        onToken: fullText => {
          assistantFinal = { ...assistantFinal, content: fullText, isError: false };
          if (!mountedRef.current || controller.signal.aborted) return;
          updateAssistant(assistantId, { content: fullText, isError: false });
        },
        onToolEvent: event => {
          if (!mountedRef.current || !event) return;
          if (event.phase === 'start') {
            // E4：事件流（旁路）——工具调用事实（含轮次，审计「第几步做了什么」）。
            appendSessionEvent(storeRef.current, ownerId, chatId, 'tool_call', {
              name: event.name,
              round: event.round,
            });
            // A3 二期：update_plan 的清单推进度条（状态展示；传空清单 = 清空）。
            if (event.name === 'update_plan') {
              const steps = normalizePlanSteps(event.args && event.args.plan);
              setAgentPlan(steps);
              if (steps.length > 0) setPlanCollapsed(false);
            }
          }
          setToolStatus(event.phase === 'start' ? t('workspace.chat.tool.reading', { name: event.name }) : '');
        },
        // 先查已记住的权限规则（本次会话 / 永远允许），没命中才弹三选项框。
        // 工作区钩子（hooks.json）的 before_shell 预置禁令在这里注入（每次调用直读，
        // 本轮内 agent 改了钩子文件也立即生效）；钩子只收紧、不放松。
        onToolApproval: async call => {
          let extraRules = [];
          try {
            const hooks = await readWorkspaceHooks(storeRef.current, characterId);
            extraRules = hookPermissionRules(hooks);
          } catch (error) {}
          return approveToolCall({
            name: call && call.name,
            args: call && call.args,
            t,
            signal: controller.signal,
            extraRules,
          });
        },
        // ask_user：任务中途向用户提选择题（跨平台 Alert）。
        onAskUser: payload => promptUserChoice({
          ...payload,
          cancelLabel: t('common.cancel'),
          alert: (...a) => Alert.alert(...a),
        }),
        // D4-1：结果增强钩子——hooks.json 的 on_tool_result（按工具名精确匹配，
        // 往成功结果尾部追加提醒）。每次调用直读（本轮内 agent 改了钩子立即生效）；
        // registry 侧兜底：错误结果不增强、钩子抛错按原结果返回。
        onToolResult: async (call, result) => {
          try {
            const hooks = await readWorkspaceHooks(storeRef.current, characterId);
            const notices = collectToolResultNotices(hooks, call && call.name);
            if (notices.length === 0) return result;
            return {
              content: `${result.content}\n\n[工作区钩子] ${notices.join('；')}`,
              isError: result.isError === true,
            };
          } catch (error) {
            return result;
          }
        },
        context: { characterId },
        // P5：本轮 agent 追加消息（含 tool）回抛，提取工具轨迹持久化。
        onTranscript: msgs => { turnTrace = extractToolTrace(msgs); },
          });
          break;
        } catch (error) {
          // P2：上下文超限 → 压缩历史 → 重试一次（对齐 dsh condense-and-retry）。
          if (!overflowRetried && isContextOverflowError(error)) {
            overflowRetried = true;
            let compactedOk = false;
            try {
              const { configs, activeId } = await getApiConfigs();
              const cfg = configs.find(item => item.id === activeId) || configs[0];
              const compacted = await runReactiveCompact({
                messages: request,
                error,
                deps: {
                  summarize: req => sendChatMessage(req, {
                    stream: false,
                    ...(cfg ? { expectedConfigId: String(cfg.id || ''), expectedConfigFingerprint: getConfigFingerprint(cfg) } : {}),
                  }),
                },
              });
              if (compacted.compacted) {
                request = compacted.messages;
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
      if (mode !== 'ask' && mountedRef.current && !controller.signal.aborted) {
        loadUsage(characterId);
      }
    } catch (error) {
      if (controller.signal.aborted || isCanceledError(error)) {
        // 已经流出的内容就当终稿；一个字都没出才落「已停止」。
        if (!String(assistantFinal.content || '').trim()) {
          assistantFinal = { ...assistantFinal, content: t('workspace.chat.stopped'), isError: true };
        }
        setMessages(list => list.map(item => (
          item.id === assistantId && !String(item.content || '').trim()
            ? { ...item, content: assistantFinal.content, isError: assistantFinal.isError }
            : item
        )));
      } else {
        assistantFinal = {
          ...assistantFinal,
          content: maskSecrets((error && error.message) || t('workspace.chat.err')),
          isError: true,
        };
        updateAssistant(assistantId, { content: assistantFinal.content, isError: true });
      }
    } finally {
      // P5：把本轮工具轨迹挂到终稿上（展示无感；下轮投影成 agent 历史）。
      if (turnTrace) assistantFinal = { ...assistantFinal, toolTrace: turnTrace };
      // 助手终稿一次性落盘（含被中止 / 报错的情况），流式期间不写。
      persistMessages(ownerId, chatId, [{ ...assistantFinal, at: Date.now() }]);
      // E4：事件流（旁路）——助手终稿（中止/报错形态如实带 isError）。
      appendSessionEvent(storeRef.current, ownerId, chatId, 'assistant', {
        text: String(assistantFinal.content || '').slice(0, 1000),
        ...(assistantFinal.isError ? { isError: true } : {}),
      });
      if (mountedRef.current) {
        setSending(false);
        setToolStatus('');
        setSteeringNote(''); // I1：本轮结束，补充指令的提示与队列一并清掉
      }
      controllerRef.current = null;
      steeringRef.current = null;
      // N2：本轮结束后按 0.8 线静默压缩（用本轮终稿拼出准确历史，避免闭包滞后）。
      if (mode !== 'ask') {
        compactWorkspaceNow({
          silent: true,
          list: [...history, userMessage, { ...assistantFinal, at: Date.now() }],
        }).catch(() => {});
      }
    }
  }, [activeChatId, attachments, characterId, characterName, compactWorkspaceNow, input, loadUsage, materializeForAgent, messages, mode, persistMessages, sending, t, updateAssistant, wsSettings]);

  // I1：运行中不再禁用发送——有文字就可用（发送按钮 → steering 入队）；附件在
  // 运行时由 handleSend 明确拒绝（补充指令是纯文本语义）。
  const canSend = input.trim().length > 0 || attachments.length > 0;

  // I2：模式切到 write 后的新渲染里发起批准链路（此刻 handleSend 闭包已带 write，
  // 工具集/预算/提示词全按 write 走）。setPendingPlanRun(null) 防重入。
  useEffect(() => {
    if (!pendingPlanRun) return;
    if (mode !== 'write' || sending) return;
    setPendingPlanRun(null);
    handleSend(pendingPlanRun);
  }, [handleSend, mode, pendingPlanRun, sending]);
  const lastAssistantId = messages.length && messages[messages.length - 1].role === 'assistant'
    ? messages[messages.length - 1].id
    : '';

  // 新消息或流式追加时滚到底部（长回复时跟随）。
  useEffect(() => {
    const timer = setTimeout(() => {
      if (scrollRef.current && scrollRef.current.scrollToEnd) {
        scrollRef.current.scrollToEnd({ animated: true });
      }
    }, 40);
    return () => clearTimeout(timer);
  }, [messages, toolStatus]);

  // 对话面板（工作区单屏内的「对话」领域）：不再自套 Modal、不再自带顶栏与左栏——
  // 那是单屏的职责。顶部一条紧凑动作行保留「新建对话 / 查找历史」。
  return (
    <View style={styles.embeddedRoot}>
      <KeyboardAvoidingView
        style={[styles.container, styles.containerEmbedded]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.embeddedBar}>
            <TouchableOpacity style={styles.embeddedAction} onPress={handleNewChat} activeOpacity={0.8}>
              <Ionicons name="add-circle-outline" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.embeddedActionText}>{t('workspace.rail.newChat')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.embeddedAction} onPress={() => setHistoryOpen(true)} activeOpacity={0.8}>
              <Ionicons name="time-outline" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.embeddedActionText}>{t('workspace.rail.history')}</Text>
            </TouchableOpacity>
        </View>

        <View style={styles.mainRow}>
          <View style={styles.chatColumn}>
            {onOpenPanel ? (
              <TouchableOpacity
                style={styles.filesLink}
                onPress={() => onOpenPanel('viewer')}
                activeOpacity={0.8}
              >
                <Ionicons name="folder-open-outline" size={14} color={theme.colors.primarySoft} />
                <Text style={styles.filesLinkText} numberOfLines={1}>
                  {t('workspace.home.filesLink')}
                </Text>
                <Ionicons name="chevron-forward" size={13} color={theme.colors.textFaint} />
              </TouchableOpacity>
            ) : null}

            {settingsOpen ? (
              <ScrollView contentContainerStyle={styles.body}>
                <WorkspaceSettingsSheet
                  embedded
                  section={settingsSection}
                  onToggleSection={setSettingsSection}
                  models={models}
                  activeModel={activeModel}
                  onSelectModel={handleSelectModel}
                  thinking={thinking}
                  onSelectThinking={handleSelectThinking}
                  mode={mode}
                  onSelectMode={handleSelectMode}
                  characters={characters}
                  characterId={characterId}
                  onSelectCharacter={handleSelectCharacter}
                  usage={usage}
                  onImportFile={handleImportFile}
                  importBusy={importBusy}
                  onOpenPanel={section => { if (onOpenPanel) onOpenPanel(section); }}
                  permissionRules={permissionRules}
                  onClearPermissionRules={handleClearPermissionRules}
                  onAddPermissionRule={handleAddPermissionRule}
                  retention={wsSettings ? wsSettings.retention : undefined}
                  onChangeRetention={handleChangeRetention}
                  skills={workspaceSkills}
                  onInstallSampleSkills={handleInstallSampleSkills}
                  teams={workspaceTeams}
                  onInstallSampleTeams={handleInstallSampleTeams}
                  commands={workspaceCommands}
                  onInstallSampleCommands={handleInstallSampleCommands}
                  hooksText={hooksText}
                  onInstallSampleHooks={handleInstallSampleHooks}
                  onInstallTemplate={handleInstallTemplate}
                  onExportSessionEvents={exportSessionEvents}
                />
              </ScrollView>
            ) : (
            <>
            <ScrollView ref={scrollRef} contentContainerStyle={styles.body}>
              {messages.length === 0 ? (
                <Text style={styles.intro}>{t('workspace.chat.intro')}</Text>
              ) : null}
              {messages.map(item => (
                <View
                  key={item.id}
                  style={[styles.bubbleRow, item.role === 'user' ? styles.bubbleRowUser : styles.bubbleRowAssistant]}
                >
                  <View style={[
                    styles.bubble,
                    item.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
                    item.isError ? styles.bubbleError : null,
                  ]}>
                    {/* selectable：RN 的 Text 在 Android 上默认不可选，不写它就长按不出
                        选择手柄。只加在消息正文上——状态行/标签等 UI 文本不加（会吃长按）。 */}
                    {item.role === 'assistant' && !item.content && sending && item.id === lastAssistantId ? (
                      <ActivityIndicator size="small" color={theme.colors.primary} />
                    ) : (
                      <Text style={styles.bubbleText} selectable>{item.content}</Text>
                    )}
                  </View>
                </View>
              ))}
            </ScrollView>

            {/* A3 二期：计划进度条（update_plan 的清单，只读展示）——多步任务执行中
                对用户可见「做到哪一步了」；会话边界清空，纯展示不落盘。 */}
            {agentPlan.length > 0 ? (
              <View style={styles.planPanel}>
                <TouchableOpacity
                  style={styles.planHeader}
                  onPress={() => setPlanCollapsed(value => !value)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="list-outline" size={14} color={theme.colors.primary} />
                  <Text style={styles.planTitle} numberOfLines={1}>
                    {t('workspace.chat.plan.title', {
                      done: agentPlan.filter(item => item.status === 'done').length,
                      total: agentPlan.length,
                    })}
                  </Text>
                  <Ionicons
                    name={planCollapsed ? 'chevron-down' : 'chevron-up'}
                    size={14}
                    color={theme.colors.textFaint}
                  />
                </TouchableOpacity>
                {planCollapsed ? null : agentPlan.map((item, index) => (
                  <View key={`${index}-${item.step}`} style={styles.planRow}>
                    <Ionicons
                      name={item.status === 'done'
                        ? 'checkmark-circle'
                        : (item.status === 'in_progress' ? 'play-circle' : 'ellipse-outline')}
                      size={14}
                      color={item.status === 'done' ? theme.colors.primary : theme.colors.textMuted}
                    />
                    <Text
                      style={[styles.planStep, item.status === 'done' && styles.planStepDone]}
                      numberOfLines={1}
                    >
                      {item.step}
                    </Text>
                  </View>
                ))}
                {/* I2：read 模式 + 计划未完成 → 提议「批准并执行」（切模式 + 注入确认消息）。 */}
                {canApprovePlan ? (
                  <TouchableOpacity
                    style={styles.planApprovalButton}
                    onPress={() => { if (!sending) approvePlan(); }}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="checkmark-done-outline" size={14} color={theme.colors.primary} />
                    <Text style={styles.planApprovalText}>
                      {t('workspace.chat.planApproval.action')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            {toolStatus ? (
              <View style={styles.statusBar}>
                <ActivityIndicator size="small" color={theme.colors.primaryMuted} />
                <Text style={styles.statusText} numberOfLines={1}>{toolStatus}</Text>
              </View>
            ) : null}

            {/* I1：Steering 提示——「补充指令已入队」，本轮结束自动消失。 */}
            {steeringNote ? (
              <View style={styles.statusBar}>
                <Ionicons name="chatbubble-ellipses-outline" size={14} color={theme.colors.primary} />
                <Text style={styles.statusText} numberOfLines={1}>{steeringNote}</Text>
              </View>
            ) : null}

            {attachments.length > 0 ? (
              <View style={styles.attachmentBar}>
                {attachments.map(item => (
                  <View key={item.id} style={styles.attachmentChip}>
                    <Ionicons
                      name={item.kind === 'image' ? 'image-outline' : 'document-text-outline'}
                      size={14}
                      color={theme.colors.primarySoft}
                    />
                    <Text style={styles.attachmentName} numberOfLines={1}>{item.name}</Text>
                    <TouchableOpacity onPress={() => removeAttachment(item.id)} hitSlop={6}>
                      <Ionicons name="close" size={14} color={theme.colors.textFaint} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}

            {recorder.recording || voiceBusy ? (
              <View style={styles.recordingBar}>
                <Ionicons name="mic" size={16} color={theme.colors.danger} />
                <Text style={styles.recordingText}>
                  {voiceBusy ? t('workspace.chat.voice.busy') : t('workspace.chat.recording')}
                </Text>
                {recorder.recording ? (
                  <TouchableOpacity onPress={onStopVoice} hitSlop={8}>
                    <Text style={styles.recordingAction}>{t('workspace.chat.voice.stop')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            {slashSuggestions.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.slashBar}
                keyboardShouldPersistTaps="handled"
              >
                {slashSuggestions.map(item => (
                  <TouchableOpacity
                    key={item.name}
                    style={styles.slashChip}
                    onPress={() => handleInputChange(`/${item.name} `)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.slashChipText}>/{item.name}</Text>
                    {item.description ? (
                      <Text style={styles.slashChipDescription} numberOfLines={1}>{item.description}</Text>
                    ) : null}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : null}

            <View style={styles.inputBar}>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={onPickAttachment}
                disabled={sending}
                accessibilityLabel={t('workspace.chat.attach.a11y')}
              >
                <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={recorder.recording
                  ? onStopVoice
                  : () => recorder.start().catch(error => Alert.alert(
                    t('workspace.chat.voice.err.title'),
                    maskSecrets((error && error.message) || t('workspace.chat.voice.err.body'))
                  ))}
                disabled={sending || voiceBusy}
                accessibilityLabel={t('workspace.chat.record.a11y')}
              >
                <Ionicons
                  name={recorder.recording ? 'mic' : 'mic-outline'}
                  size={22}
                  color={recorder.recording ? theme.colors.danger : theme.colors.primarySoft}
                />
              </TouchableOpacity>
              <TextInput
                style={styles.input}
                value={input}
                onChangeText={handleInputChange}
                placeholder={t('workspace.chat.placeholder')}
                placeholderTextColor={theme.colors.textFaint}
                multiline
                // I1：运行中不再锁输入框——此时打的字会作为「补充指令」入队（handleSend
                // 的 sending 分支）。原先这里写 `!sending`，等于把 Steering 入口锁死：
                // 队列与提示都在，但用户根本没法输入（本轮修正）。
                editable={!sending || !!steeringRef.current}
              />
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => setSettingsOpen(true)}
                accessibilityLabel={t('workspace.settings.title')}
              >
                <Ionicons name="options-outline" size={22} color={theme.colors.primarySoft} />
              </TouchableOpacity>
              {sending ? (
                <>
                  {/* I1：运行中打的字不丢——非空时给「补充指令」键（与停止键并存，
                      发送只入队、不打断本轮）。 */}
                  {input.trim() ? (
                    <TouchableOpacity
                      style={styles.sendButton}
                      onPress={handleSend}
                      accessibilityLabel={t('workspace.chat.steer.a11y')}
                    >
                      <Ionicons name="chatbubble-ellipses-outline" size={18} color={theme.colors.text} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity style={[styles.sendButton, styles.stopButton]} onPress={handleStop} accessibilityLabel={t('workspace.chat.stop.a11y')}>
                    <Ionicons name="stop" size={18} color={theme.colors.text} />
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
                  onPress={handleSend}
                  disabled={!canSend}
                  accessibilityLabel={t('workspace.chat.send.a11y')}
                >
                  <Ionicons name="arrow-up" size={20} color={theme.colors.text} />
                </TouchableOpacity>
              )}
            </View>
            </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      <WorkspaceHistorySheet
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        chats={chatList}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onDeleteChat={handleDeleteChat}
        onArchiveChat={handleArchiveChat}
        onClearAll={handleClearChats}
        busy={historyBusy}
      />
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 44 },
  // embedded：外层由 WorkspaceScreen 提供容器与安全区，这里不再重复留白。
  embeddedRoot: { flex: 1 },
  containerEmbedded: { paddingTop: 0 },
  embeddedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  embeddedAction: { flexDirection: 'row', alignItems: 'center', marginRight: 16 },
  embeddedActionText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600', marginLeft: 4 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 8,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800' },
  exitButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  mainRow: { flex: 1, flexDirection: 'row' },
  rail: {
    width: 76,
    paddingTop: 10,
    paddingHorizontal: 6,
    borderRightWidth: tokens.border.thin,
    borderRightColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceAlt,
  },
  railItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: tokens.radius.md,
    marginBottom: 6,
  },
  railLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(10),
    lineHeight: fonts.scaled(14),
    textAlign: 'center',
    marginTop: 4,
  },
  // 预留位：把后续入口接在这里，保持左列重心在顶部。
  railSpacer: { flex: 1 },
  chatColumn: { flex: 1 },
  filesLink: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  filesLinkText: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(11),
    marginHorizontal: 6,
  },
  body: { paddingHorizontal: 14, paddingBottom: 16, paddingTop: 6 },
  intro: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 8 },
  bubbleRow: { flexDirection: 'row', marginTop: 10 },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubbleRowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '86%',
    borderRadius: tokens.radius.md || tokens.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: tokens.border.thin,
  },
  bubbleUser: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  bubbleAssistant: { backgroundColor: theme.colors.surface, borderColor: theme.colors.surfaceBorder },
  bubbleError: { borderColor: theme.colors.danger || theme.colors.surfaceBorder },
  bubbleText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
  statusBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 4 },
  statusText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 6, flex: 1 },
  // A3 二期：计划进度条（贴着输入区的只读卡片；完成项划线弱化）。
  planPanel: {
    marginHorizontal: 12,
    marginBottom: 4,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  planHeader: { flexDirection: 'row', alignItems: 'center' },
  planTitle: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12.5), fontWeight: '600', marginLeft: 6 },
  planRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  planStep: { color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, flex: 1 },
  planStepDone: { color: theme.colors.textFaint, textDecorationLine: 'line-through' },
  // I2：计划批准按钮（计划卡片内的轻量行按钮，不引入大按钮组件）。
  planApprovalButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: hexToRgba(theme.colors.primary, 0.14),
  },
  planApprovalText: {
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
    marginLeft: 6,
    flex: 1,
  },
  attachmentBar: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 10, paddingBottom: 4 },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 8,
    marginTop: 6,
  },
  attachmentName: { color: theme.colors.text, fontSize: fonts.scaled(11), marginHorizontal: 5, maxWidth: 140 },
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  recordingText: { color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, flex: 1 },
  recordingAction: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '600' },
  // 斜杠命令建议条：输入 / 时出现在输入行上方（横向滚动，点击填入命令名）。
  slashBar: {
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  slashChip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
    maxWidth: 240,
  },
  slashChipText: {
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
  },
  slashChipDescription: {
    marginLeft: 6,
    flexShrink: 1,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  iconButton: { paddingHorizontal: 5, paddingBottom: 8 },
  input: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    maxHeight: 120,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  sendButtonDisabled: { opacity: 0.5 },
  stopButton: { backgroundColor: theme.colors.surfaceBorder },
});
