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
  getWorkspaceSettings,
  patchWorkspaceSettings,
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
import { getMessagesBySession, getSessions } from '../../storage/sessions.js';
import {
  getThinkingSettings,
  getTranscriptionSettings,
  saveThinkingSettings,
} from '../../storage/settings.js';
import { computeContextUsage, resolveContextWindow } from '../../chat/contextUsage.js';
import { filterRequestMedia } from '../../prompt/chatPipeline.js';
import { isCanceledError } from '../../network/api.js';
import { resolveTranscription, transcribeAudio } from '../../transcription.js';
import { maskSecrets } from '../../storage/secrets.js';
import { runAgentTurn } from '../../agent/loop.js';
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
import { resolveWorkspaceAssistant } from '../assistant.js';
import { createWorkspaceStore, registerDefaultWorkspaceTools } from '../native.js';
import { ensureWorkspaceMemory, readWorkspaceMemory } from '../memory.js';
import { installSampleSkills, readWorkspaceSkills } from '../skills.js';
import {
  expandSlashCommand,
  installSampleCommands,
  matchSlashCommands,
  readWorkspaceCommands,
  slashQuery,
} from '../commands.js';
import { upsertWorkspaceChat } from '../chats.js';
import {
  clearPermissionRules,
  getEffectivePermissionRules,
} from '../../storage/settings/workspacePermissions.js';
import WorkspaceHistorySheet from '../WorkspaceHistorySheet.js';
import WorkspaceSettingsSheet from '../WorkspaceSettingsSheet.js';
import {
  buildWorkspaceAgentMessages,
  buildWorkspaceAgentSystemPrompt,
  projectWorkspaceChatHistory,
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

  // 上下文占用：取该工作区角色最近的一个单聊会话，按当前模型声明的窗口估算
  //（与 ChatScreen.maybeAutoSummarize 同一口径，到 80% 自动压缩）。
  const loadUsage = useCallback(async ownerId => {
    try {
      const [sessions, { configs, activeId }, localItem] = await Promise.all([
        getSessions(),
        getApiConfigs(),
        getActiveLocalModel().catch(() => null),
      ]);
      const session = (Array.isArray(sessions) ? sessions : [])
        .filter(item => item && item.type !== 'group'
          && String(item.characterId || '') === String(ownerId || ''))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
      if (!session) {
        if (mountedRef.current) setUsage(null);
        return;
      }
      const list = await getMessagesBySession(session.id).catch(() => []);
      const current = configs.find(item => item.id === activeId) || configs[0];
      const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
      const localContextSize = Number(localItem && localItem.contextSize) || 0;
      const computed = computeContextUsage(list, resolveContextWindow({
        declared: caps.contextWindow,
        localContextSize,
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
    await setActiveWorkspaceChat(characterId, id).catch(() => {});
  }, [activeChatId, characterId, chatList, input, persistDraft, readDraft]);

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

  const handleSend = useCallback(async () => {
    if (sending) return;
    const text = input.trim();
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
    setMessages(list => [...list, userMessage, { id: assistantId, role: 'assistant', content: '' }]);
    // 发出去了：清空输入框、同时把该会话的草稿清掉（内存 + 盘），
    // 否则下次切回来会把已经发过的话又填回输入框。
    persistDraft(ownerId, chatId, '');
    setInput('');
    setAttachments([]);
    setSending(true);
    setToolStatus('');
    persistMessages(ownerId, chatId, [userMessage]);

    const controller = new AbortController();
    controllerRef.current = controller;

    // 先注册工具、再拼提示词：提示词里要不要写「可以跑 Python / 可以执行命令」，判据是
    // **注册表里真的有**（开关开着但原生模块缺失、或根是外部文件夹时并不存在），
    // 所以必须以后者为准——否则提示词会承诺一个调不动的能力，模型会反复尝试然后乱解释。
    let tools = [];
    if (mode !== 'ask') {
      try {
        registerDefaultWorkspaceTools(wsSettingsRef.current || wsSettings);
        tools = listToolsForMode(mode);
      } catch (error) {}
    }
    // 工作区记忆（AGENTS.md）：每轮直读、不缓存——agent 可能刚在上一轮里改过它
    //（自我演进通路），缓存一旦判断失误模型就会按旧指令工作；读失败当没有，不打扰聊天。
    const memory = await readWorkspaceMemory(storeRef.current, ownerId);
    // 技能清单（渐进披露第一层）：同样每轮直读——技能目录不存在时只有一次 list IO。
    const skills = mode === 'ask' ? [] : await readWorkspaceSkills(storeRef.current, ownerId);
    const systemPrompt = buildWorkspaceAgentSystemPrompt({
      mode,
      characterName,
      tools: tools.map(item => item.function.name),
      memory,
      skills,
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
      await runAgentTurn(request, {
        mode,
        tools,
        signal: controller.signal,
        requestOptions: { stream: true },
        onToken: fullText => {
          assistantFinal = { ...assistantFinal, content: fullText, isError: false };
          if (!mountedRef.current || controller.signal.aborted) return;
          updateAssistant(assistantId, { content: fullText, isError: false });
        },
        onToolEvent: event => {
          if (!mountedRef.current || !event) return;
          setToolStatus(event.phase === 'start' ? t('workspace.chat.tool.reading', { name: event.name }) : '');
        },
        // 先查已记住的权限规则（本次会话 / 永远允许），没命中才弹三选项框。
        onToolApproval: call => approveToolCall({
          name: call && call.name,
          args: call && call.args,
          t,
          signal: controller.signal,
        }),
        context: { characterId },
      });
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
      // 助手终稿一次性落盘（含被中止 / 报错的情况），流式期间不写。
      persistMessages(ownerId, chatId, [{ ...assistantFinal, at: Date.now() }]);
      if (mountedRef.current) {
        setSending(false);
        setToolStatus('');
      }
      controllerRef.current = null;
    }
  }, [activeChatId, attachments, characterId, characterName, input, loadUsage, messages, mode, persistMessages, sending, t, updateAssistant, wsSettings]);

  const canSend = !sending && (input.trim().length > 0 || attachments.length > 0);
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
                  skills={workspaceSkills}
                  onInstallSampleSkills={handleInstallSampleSkills}
                  commands={workspaceCommands}
                  onInstallSampleCommands={handleInstallSampleCommands}
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

            {toolStatus ? (
              <View style={styles.statusBar}>
                <ActivityIndicator size="small" color={theme.colors.primaryMuted} />
                <Text style={styles.statusText} numberOfLines={1}>{toolStatus}</Text>
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
                editable={!sending}
              />
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => setSettingsOpen(true)}
                accessibilityLabel={t('workspace.settings.title')}
              >
                <Ionicons name="options-outline" size={22} color={theme.colors.primarySoft} />
              </TouchableOpacity>
              {sending ? (
                <TouchableOpacity style={[styles.sendButton, styles.stopButton]} onPress={handleStop} accessibilityLabel={t('workspace.chat.stop.a11y')}>
                  <Ionicons name="stop" size={18} color={theme.colors.text} />
                </TouchableOpacity>
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
