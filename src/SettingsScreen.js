import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';

import { normalizeChatUrl } from './network/api.js';
import vendorXhr from './network/vendorHttp.js';
import { useTheme } from './theme/ThemeContext.js';
import { useApp } from './context/AppContext.js';
import DisclaimerModal from './onboarding/disclaimer.js';
import { useTranslation } from './i18n/I18nContext.js';
import PluginPanel from './PluginPanel.js';
import PresetPanel from './PresetPanel.js';
import TtsPanel from './TtsPanel.js';
import TranscriptionPanel from './TranscriptionPanel.js';
import { useNavigation } from '@react-navigation/native';
import {
  createApiConfig,
  rawCapabilityForModel,
  getApiConfigs,
  normalizeCapabilityEntry,
  getChatOptions,
  getGlobalPresetSettings,
  getGlobalPresets,
  getImageGenSettings,
  getInlineImageSettings,
  getLocationSettings,
  getMomentsSettings,
  saveMomentsSettings,
  getThinkingSettings,
  getUiSections,
  getWorkspaceSettings,
  patchWorkspaceSettings,
  clearGithubMcpCredentials,
  connectGithubMcpWithToken,
  getGithubMcpSettings,
  saveApiConfigs,
  saveChatOptions,
  saveInlineImageSettings,
  saveImageGenSettings,
  saveThinkingSettings,
  saveUiSections,
  updateLocationSettings,
} from './storage.js';
import { IMAGE_PROVIDERS } from './imageGen/providers.js';
import { detectImageProvider } from './imageGen/index.js';
import { pickWorkspaceFolder } from './workspace/picker.js';
import { API_PROTOCOL_PRESETS, CHAT_API_VENDORS, getChatApiVendor } from './network/apiVendors.js';
import {
  Card,
  FieldHint,
  TextField,
  TopicButton,
  CollapsibleSection,
} from './ui/index.js';
import ChapterModal from './books/ChapterModal.js';
import TutorialModal from './TutorialModal.js';
import DiagnosticsModal from './DiagnosticsModal.js';
import BackupPanel from './BackupPanel.js';
import LocalModelPanel from './LocalModelPanel.js';
import WorkspacePanel from './WorkspacePanel.js';
import WorkspaceChat from './workspace/WorkspaceChat.js';
import useVectorSettings from './settings/useVectorSettings.js';
import useUserProfile from './settings/useUserProfile.js';
import SamplingCard from './settings/SamplingCard.js';
import { searchSettings, settingsSectionLabel } from './settings/searchIndex.js';
import { createSettingsStyles } from './settings/settingsStyles.js';
import ApiSection from './settings/sections/ApiSection.js';
import PersonaSection from './settings/sections/PersonaSection.js';
import AppearanceSection from './settings/sections/AppearanceSection.js';
import ExperienceSection from './settings/sections/ExperienceSection.js';
import ExtensionsSection from './settings/sections/ExtensionsSection.js';
import VectorSection from './settings/sections/VectorSection.js';
import WorkspaceSection from './settings/sections/WorkspaceSection.js';
import GithubSection from './settings/sections/GithubSection.js';
import AboutSection from './settings/sections/AboutSection.js';

// 接口协议选项：openai（Chat Completions，最通用）、openai-responses（/v1/responses）、
// anthropic（/v1/messages）。切换时按协议给出对应默认鉴权头。
const CHAT_PROTOCOL_OPTIONS = [
  { id: 'openai', label: 'OpenAI', auth: { header: 'Authorization', prefix: 'Bearer ' } },
  { id: 'openai-responses', label: 'Responses', auth: { header: 'Authorization', prefix: 'Bearer ' } },
  { id: 'anthropic', label: 'Anthropic', auth: { header: 'x-api-key', prefix: '' } },
];

// 应用版本号：报 bug / 对「检测更新」时都需要它能被一眼看到（expo-constants 读取
// app.json 的 expo.version）。
const APP_VERSION = Constants.expoConfig ? String(Constants.expoConfig.version || '') : '';

// GitHub 令牌创建页（方式二「打开令牌页」的落地页）。
// 为什么不做网页授权：GitHub 的远程 MCP 不提供动态客户端注册（RFC 7591 的 /register
// 端点不存在）——流程会在「注册应用」一步失败，浏览器根本不会打开，用户看到的就是
// 「点了按钮没跳转」。令牌页一定可用，且能顺带把权限勾选问清楚。
const GITHUB_TOKEN_PAGE_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:user&description=EasyChat2';

// 思考参数预设：字段名 + 取值格式的组合。做成「折叠 + 点击选择」而不是手输——
// 字段名/格式配错时服务端通常**静默忽略**（思考开关看着开了却不生效，很难查）。
// 每项标注适用模型；只有选「自定义」才露出字段名输入框。
const THINKING_PRESETS = [
  {
    id: 'reasoning_effort',
    field: 'reasoning_effort',
    format: 'effort',
    name: 'reasoning_effort（档位）',
    hint: 'OpenAI o 系列 / GPT-5 / Grok / DeepSeek-R1：取 low、medium、high，由「思考档位」设置决定',
  },
  {
    id: 'thinking_bool',
    field: 'thinking',
    format: 'boolean',
    name: 'thinking: true（布尔开关）',
    hint: 'Claude 3.7 之前的 Anthropic 接口、部分国产模型：只有开/关，没有档位',
  },
  {
    id: 'thinking_object',
    field: 'thinking',
    format: 'object',
    name: 'thinking: { type: "enabled", depth }（对象）',
    hint: 'Claude 3.7+ / 智谱 GLM / 阿里百炼部分模型：对象形式，带 depth 档位',
  },
  {
    id: 'enable_thinking',
    field: 'enable_thinking',
    format: 'boolean',
    name: 'enable_thinking: true（布尔开关）',
    hint: '通义千问 Qwen3 系 / 部分国产开源模型：字段名不同，取值格式与上一项一致',
  },
  {
    id: 'reasoning_object',
    field: 'reasoning',
    format: 'object',
    name: 'reasoning: { type, depth }（对象）',
    hint: '部分聚合网关 / 新接口：reasoning 对象。走 OpenAI Responses 协议时无需设置（协议层自动带 effort）',
  },
  {
    id: 'custom',
    field: '',
    format: '',
    name: '自定义…',
    hint: '手动填写字段名与格式。不确定时优先选上面带模型名的项——配错会被服务端静默忽略',
  },
];

// 当前生效配置的快照：识别「有未保存的修改」的基线，加载/落盘后刷新。
function snapshotActiveConfig(state) {
  const active = state && state.configs ? state.configs.find(item => item.id === state.activeId) : null;
  return active ? JSON.stringify(active) : '';
}

export default function SettingsScreen() {
  const [configs, setConfigs] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const {
    vectorPayload,
    vectorRef,
    vectorTesting,
    vectorTopKDraft,
    setVectorTopKDraft,
    vectorMaxCharsDraft,
    setVectorMaxCharsDraft,
    currentVectorConfig,
    loadVectorSettings,
    flushVectorMemory,
    updateVectorConfig,
    toggleVectorEnabled,
    addVectorConfig,
    selectVectorConfig,
    removeVectorConfig,
    testVector,
  } = useVectorSettings();
  const {
    userName,
    setUserName,
    userPersona,
    setUserPersona,
    userAvatarUri,
    userProfileSaved,
    personas,
    setPersonas,
    activePersonaId,
    loadUserProfile,
    saveUserProfileDelayed,
    changeUserAvatar,
    selectPersona,
    addPersona,
    removePersona,
    pickUserAvatar,
    saveUserProfileNow,
  } = useUserProfile();
  const [detectingModels, setDetectingModels] = useState(false);
  const [modelList, setModelList] = useState([]);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState('');
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  // 能力弹层当前编辑的模型名——能力按「模型」一份，不再按整个 API 配置。
  const [capabilityEditorModel, setCapabilityEditorModel] = useState('');
  const [capabilityDraft, setCapabilityDraft] = useState({
    supportsThinking: false,
    supportsVision: false,
    supportsVideo: false,
    supportsAudio: false,
    thinkingField: 'reasoning_effort',
    thinkingFormat: 'effort',
    // 上下文窗口（tokens，字符串在编辑，确认时解析为数字；空 = 0 = 用默认）。
    contextWindow: '',
    // 单次回复最大输出 tokens（空 = 0 = 用默认 32000）。
    maxOutput: '',
    // 「自定义参数」总开关：默认关闭，关闭时上面这些高级项按默认值发送。
    customParams: false,
  });
  // 思考参数选择器的展开态（折叠起来、点击才展开选预设）。
  const [thinkingPresetOpen, setThinkingPresetOpen] = useState(false);
  const [presetEntryOpen, setPresetEntryOpen] = useState(false);
  const [pluginEntryOpen, setPluginEntryOpen] = useState(false);
  const [ttsEntryOpen, setTtsEntryOpen] = useState(false);
  const [transcriptionEntryOpen, setTranscriptionEntryOpen] = useState(false);
  const [momentsEnabled, setMomentsEnabled] = useState(false);
  const [topic, setTopic] = useState(null);
  const [enabledPresetCount, setEnabledPresetCount] = useState(0);
  const [chatOptions, setChatOptions] = useState({ streaming: true, fullWidth: false, richHtml: true, keepDraft: false, timeAware: false, bubbleStyle: 'rounded' });
  const chatOptionsRef = useRef({ streaming: true, fullWidth: false, richHtml: true, keepDraft: false, timeAware: false, bubbleStyle: 'rounded' });
  const [workspaceMode, setWorkspaceMode] = useState('ask');
  const workspaceModeRef = useRef('ask');
  const [workspaceFolder, setWorkspaceFolder] = useState({ kind: 'app', uri: '', name: '' });
  const [commandExecution, setCommandExecution] = useState(false);
  const [workspaceFolderBusy, setWorkspaceFolderBusy] = useState(false);
  // 异步保存（选文件夹 / 命令开关）回来时组件可能已卸载，setState 前先查这个 ref。
  const settingsMountedRef = useRef(true);
  const characterId = (character && character.id) || 'default';
  const [thinkingDisplay, setThinkingDisplay] = useState('fold');
  const [inlineImage, setInlineImage] = useState({
    enabled: false,
    providerId: '',
    stylePrefix: '',
    size: '832*1216',
    maxPromptChars: 400,
    imagePosition: 'end',
  });
  const [inlineImageProviders, setInlineImageProviders] = useState([]);
  // 生图服务商各自的配置（来自 @easychat2_image_gen），对话配图面板里可就地编辑。
  const [imageGenProviders, setImageGenProviders] = useState({});
  const [imageGenTesting, setImageGenTesting] = useState('');
  const imageGenRef = useRef({});
  const imageGenActiveRef = useRef('');
  const inlineImageRef = useRef({
    enabled: false,
    providerId: '',
    stylePrefix: '',
    size: '832*1216',
    maxPromptChars: 400,
    imagePosition: 'end',
  });
  const apiStateRef = useRef({ configs: [], activeId: '', loaded: false });
  // 未保存修改的判定基线：最近一次加载/落盘时的当前配置快照。
  const apiBaselineRef = useRef('');
  const apiBusyRef = useRef(false);
  const apiMountedRef = useRef(true);
  const modelRequestRef = useRef(null);
  const modelSourceRef = useRef(null);
  const [apiSaving, setApiSaving] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [localModelOpen, setLocalModelOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // 工作区主界面是聊天（WorkspaceChat）；文件 / 环境配置 / 历史这些子面板由它按需打开，
  // 用 initialSection 指定要直接展开的那一项。
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [workspacePanelSection, setWorkspacePanelSection] = useState('');
  // GitHub MCP 连接：设置、PAT 输入与忙碌态。
  // 两个按钮的进行中状态必须分开：此前共用 githubBusy，点「打开令牌页」时亮的是
  // 上面「连接」按钮的「连接中…」，用户以为状态串了、也看不出自己点的那步在干嘛。
  const [githubMcp, setGithubMcp] = useState(null);
  const [githubPat, setGithubPat] = useState('');
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubPageBusy, setGithubPageBusy] = useState(false);
  const { theme, fonts, tokens, themes, themeId, setThemeId, fontScales, fontScaleId, setFontScaleId, reloadAppearance } = useTheme();
  const { t, localeId, setLocaleId, locales } = useTranslation();
  const { refreshAppData, character } = useApp();

  const styles = useMemo(() => createSettingsStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // ---- 折叠卡状态：受控 CollapsibleSection，展开/收起记忆到 @easychat2_ui_sections ----
  const [sectionOpen, setSectionOpen] = useState({});
  const sectionOpenRef = useRef({});
  const sectionSaveTimerRef = useRef(null);
  const sectionOffsetsRef = useRef({});
  const scrollRef = useRef(null);

  useEffect(() => {
    getUiSections()
      .then(stored => {
        sectionOpenRef.current = { ...stored };
        setSectionOpen({ ...stored });
      })
      .catch(() => {});
    return () => {
      if (sectionSaveTimerRef.current) clearTimeout(sectionSaveTimerRef.current);
    };
  }, []);

  // 未显式记录时按使用频率决定默认：只有 API 未配置 / 人设未填写才默认展开。
  const isSectionOpen = id => {
    if (typeof sectionOpen[id] === 'boolean') return sectionOpen[id];
    if (id === 'api') return configs.length === 0 || !activeId;
    if (id === 'persona') {
      return !String(userName || '').trim() && !String(userPersona || '').trim();
    }
    return false;
  };

  const toggleSection = (id, next) => {
    const value = next === undefined ? !isSectionOpen(id) : next === true;
    const merged = { ...sectionOpenRef.current, [id]: value };
    sectionOpenRef.current = merged;
    setSectionOpen(merged);
    if (sectionSaveTimerRef.current) clearTimeout(sectionSaveTimerRef.current);
    sectionSaveTimerRef.current = setTimeout(() => {
      saveUiSections(sectionOpenRef.current).catch(() => {});
    }, 300);
    // 输入类卡展开时上滚，避免键盘弹起遮住正在编辑的字段。
    if (value && (id === 'api' || id === 'persona')) {
      const y = sectionOffsetsRef.current[id];
      if (typeof y === 'number' && scrollRef.current) {
        setTimeout(() => {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
        }, 200);
      }
    }
  };

  // ---- 设置搜索：页头放大镜 → 实时过滤索引 → 点击展开对应卡并闪烁高亮 ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [flashSection, setFlashSection] = useState('');
  const flashTimerRef = useRef(null);

  const searchResults = useMemo(() => searchSettings(searchQuery), [searchQuery]);

  const navigateToSection = id => {
    toggleSection(id, true);
    const y = sectionOffsetsRef.current[id];
    if (typeof y === 'number' && scrollRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
      }, 80);
    }
    setFlashSection(id);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashSection(''), 800);
    setSearchOpen(false);
    setSearchQuery('');
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const refreshPresetCount = useCallback(() => {
    Promise.all([getGlobalPresets(), getGlobalPresetSettings()])
      .then(([list, enabled]) => {
        setEnabledPresetCount(
          list.filter(preset => enabled[preset.id] === true).length
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshPresetCount();
  }, [refreshPresetCount]);

  // 位置感知开关：依赖「真实地图分享」（在扩展页开启）的状态，回到本页时需要刷新。
  // 仅当真实地图开启时该开关才显示（由渲染层判断 locationSettings.enabled）。
  const navigation = useNavigation();
  const [locationSettings, setLocationSettings] = useState(null);
  useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function') return undefined;
    const load = () => {
      getLocationSettings()
        .then(value => setLocationSettings(value))
        .catch(() => {});
    };
    load();
    const unsubscribe = navigation.addListener('focus', load);
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [navigation]);

  useEffect(() => {
    getChatOptions()
      .then(options => {
        chatOptionsRef.current = options;
        setChatOptions(options);
      })
      .catch(() => {});
    getThinkingSettings()
      .then(settings => setThinkingDisplay(settings.display))
      .catch(() => {});
    getWorkspaceSettings()
      .then(settings => {
        workspaceModeRef.current = settings.mode;
        setWorkspaceMode(settings.mode);
        setWorkspaceFolder(settings.location);
        setCommandExecution(settings.allowCommandExecution);
      })
      .catch(() => {});
    loadVectorSettings();

    getInlineImageSettings()
      .then(settings => {
        inlineImageRef.current = settings;
        setInlineImage(settings);
      })
      .catch(() => {});
    getMomentsSettings()
      .then(settings => setMomentsEnabled(settings.enabled === true))
      .catch(() => {});
    getImageGenSettings()
      .then(settings => {
        const active = settings.activeProvider || (IMAGE_PROVIDERS[0] && IMAGE_PROVIDERS[0].id) || '';
        imageGenActiveRef.current = settings.activeProvider || '';
        setImageGenProviders(settings.providers || {});
        imageGenRef.current = settings.providers || {};
        setInlineImageProviders(Object.keys(settings.providers || {}));
        setInlineImage(current => {
          const next = {
            ...current,
            providerId: current.providerId || active,
          };
          inlineImageRef.current = next;
          return next;
        });
      })
      .catch(() => {});
  }, []);

  const updateThinkingDisplay = useCallback(async display => {
    setThinkingDisplay(display);
    try {
      const current = await getThinkingSettings();
      await saveThinkingSettings({ ...current, display });
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  const activeImageProvider = useMemo(
    () => IMAGE_PROVIDERS.find(item => item.id === inlineImage.providerId) || null,
    [inlineImage.providerId]
  );

  const updateInlineImage = useCallback(async patch => {
    const next = { ...inlineImageRef.current, ...patch };
    inlineImageRef.current = next;
    setInlineImage(next);
    try {
      const saved = await saveInlineImageSettings(next);
      inlineImageRef.current = saved;
      setInlineImage(saved);
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  // 就地编辑某个生图服务商的配置（地址/Key/模型/额外参数），立即落盘 @easychat2_image_gen。
  const updateImageGenProvider = useCallback(async (providerId, patch) => {
    const providers = {
      ...(imageGenRef.current || {}),
      [providerId]: { ...((imageGenRef.current || {})[providerId] || {}), ...patch },
    };
    imageGenRef.current = providers;
    setImageGenProviders(providers);
    try {
      // 保留原有的 activeProvider，避免只写 providers 时把它重置掉。
      const saved = await saveImageGenSettings({
        activeProvider: imageGenActiveRef.current,
        providers,
      });
      const list = saved.providers || {};
      imageGenRef.current = list;
      setImageGenProviders(list);
      setInlineImageProviders(Object.keys(list));
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  const testImageGenProvider = useCallback(async provider => {
    if (imageGenTesting) return;
    setImageGenTesting(provider.id);
    try {
      const config = (imageGenRef.current || {})[provider.id] || {};
      const models = [...new Set(String(config.model || provider.defaultModel || '')
        .split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
      const result = await detectImageProvider({
        provider,
        config: {
          baseUrl: String(config.baseUrl || provider.baseUrl || '').trim(),
          apiKey: String(config.apiKey || '').trim(),
          model: models[0] || provider.defaultModel || '',
        },
        model: models[0] || provider.defaultModel || '',
      });
      if (result.ok) {
        Alert.alert(t('settings.inlineImage.detectOk.title'), result.modelFound === false
          ? t('settings.inlineImage.detectOk.modelMaybeWrong', { message: result.message })
          : result.message);
      } else if (result.needsProbe) {
        Alert.alert(t('settings.inlineImage.probeUnavailable.title'), t('settings.inlineImage.probeUnavailable.body'));
      } else {
        Alert.alert(t('settings.inlineImage.detectFail.title'), result.error || t('settings.inlineImage.detectFail.fallback'));
      }
    } catch (error) {
      Alert.alert(t('settings.inlineImage.detectFail.title'), (error && error.message) || t('settings.inlineImage.detectFail.fallback'));
    } finally {
      setImageGenTesting('');
    }
  }, [imageGenTesting, t]);

  const toggleMoments = useCallback(async () => {
    const next = !momentsEnabled;
    setMomentsEnabled(next);
    try {
      await saveMomentsSettings({ enabled: next });
    } catch (error) {
      setMomentsEnabled(!next);
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, [momentsEnabled]);

  const updateChatOption = useCallback(async (key, value) => {
    const next = { ...chatOptionsRef.current, [key]: value };
    chatOptionsRef.current = next;
    setChatOptions(next);
    try {
      await saveChatOptions(next);
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  // 位置感知开关：单独写 @easychat2_location.awareness（与真实地图分享同域）。
  // 失败时回读真实值，UI 不会停在「看起来开了其实没写进去」的状态。
  const toggleLocationAwareness = useCallback(async value => {
    try {
      const saved = await updateLocationSettings(current => ({ ...current, awareness: value === true }));
      setLocationSettings(saved);
    } catch (error) {
      Alert.alert(t('settings.location.awareness.title'), t('settings.location.awareness.saveFailed'));
      getLocationSettings().then(setLocationSettings).catch(() => {});
    }
  }, [t]);

  const updateWorkspaceMode = useCallback(async mode => {
    workspaceModeRef.current = mode;
    setWorkspaceMode(mode);
    try {
      // 局部更新：整体 save 会把 location / allowCommandExecution 归一化回默认值，
      // 表现为「切一下模式，刚选好的文件夹和命令开关就没了」。
      const saved = await patchWorkspaceSettings({ mode });
      setCommandExecution(saved.allowCommandExecution);
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  // —— GitHub MCP 连接 ——
  // 网页认证：发现授权服务器 → 动态注册 → 系统浏览器授权（PKCE）→ 回调换令牌。
  // 任何一步失败都提示改用 PAT；令牌方式是稳定兜底。
  // data 层错误带稳定 code：这里按 code 映射成用户文案（纯模块不做 i18n）。
  const GITHUB_ERROR_KEYS = {
    GITHUB_TOKEN_EMPTY: 'settings.github.err.empty',
    GITHUB_ENDPOINT_HTTPS: 'settings.github.err.endpoint',
    GITHUB_NOT_CONNECTED: 'settings.github.err.notConnected',
    MCP_AUTH_FAILED: 'settings.github.err.auth',
    MCP_HTTP_ERROR: 'settings.github.err.mcpHttp',
    MCP_INVALID_RESPONSE: 'settings.github.err.mcpResponse',
    OAUTH_METADATA_NOT_FOUND: 'settings.github.err.metadata',
    OAUTH_NO_REGISTRATION: 'settings.github.err.registration',
    MCP_TIMEOUT: 'settings.github.err.mcpTimeout',
    OAUTH_STATE_MISMATCH: 'settings.github.err.state',
    OAUTH_TIMEOUT: 'settings.github.err.timeout',
    OAUTH_ACCESS_DENIED: 'settings.github.err.denied',
    OAUTH_TOKEN_EXCHANGE: 'settings.github.err.exchange',
    OAUTH_BROWSER_UNAVAILABLE: 'settings.github.err.browser',
  };
  const githubAlertText = (error, translate) => {
    const key = error && error.code && GITHUB_ERROR_KEYS[error.code];
    return key ? translate(key) : ((error && error.message) || translate('settings.github.err.body'));
  };
  const githubMcpSummaryRef = useRef({ allowedCount: 0, confirmCount: 0, deniedCount: 0 });
  const loadGithubMcp = useCallback(async () => {
    try { setGithubMcp(await getGithubMcpSettings()); } catch (error) { setGithubMcp(null); }
  }, []);

  useEffect(() => { loadGithubMcp(); }, [loadGithubMcp]);

  const afterGithubConnect = useCallback(async () => {
    await loadGithubMcp();
    Alert.alert(
      t('settings.github.done.title'),
      t('settings.github.done.body', {
        count: githubMcpSummaryRef.current.allowedCount,
        confirm: githubMcpSummaryRef.current.confirmCount,
        denied: githubMcpSummaryRef.current.deniedCount,
      })
    );
  }, [loadGithubMcp, t]);

  const connectGithubPat = useCallback(async () => {
    if (githubBusy) return;
    const token = githubPat.trim();
    if (!token) {
      Alert.alert(t('settings.github.err.title'), t('settings.github.err.empty'));
      return;
    }
    setGithubBusy(true);
    try {
      const summary = await connectGithubMcpWithToken({ token, authMethod: 'pat' });
      githubMcpSummaryRef.current = summary;
      setGithubPat('');
      await afterGithubConnect();
    } catch (error) {
      Alert.alert(t('settings.github.err.title'), githubAlertText(error, t));
    } finally {
      setGithubBusy(false);
    }
  }, [afterGithubConnect, githubBusy, githubPat, t]);

  // 方式二：打开 GitHub 令牌创建页（不是 OAuth 网页授权）。
  // GitHub 的远程 MCP 不支持动态客户端注册，网页授权必然在「注册应用」一步失败、
  // 浏览器根本打不开——用户的实际观感就是「点了按钮没跳转」。令牌页则一定可用：
  // 在那里生成 PAT（权限已预勾选），复制回来粘贴到上面的输入框即可。
  const openGithubTokenPage = useCallback(async () => {
    if (githubPageBusy) return;
    setGithubPageBusy(true);
    try {
      await Linking.openURL(GITHUB_TOKEN_PAGE_URL);
    } catch (error) {
      Alert.alert(t('settings.github.err.title'), t('settings.github.err.openPage'));
    } finally {
      setGithubPageBusy(false);
    }
  }, [githubPageBusy, t]);

  const disconnectGithub = useCallback(() => {
    Alert.alert(t('settings.github.disconnect.title'), t('settings.github.disconnect.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.github.disconnect.ok'),
        style: 'destructive',
        onPress: () => { clearGithubMcpCredentials().then(loadGithubMcp).catch(() => {}); },
      },
    ]);
  }, [loadGithubMcp, t]);

  // 选文件夹：系统选择器（SAF）已经带 takePersistableUriPermission，重启后仍有效。
  // 取消不是错误，不提示；失败才提示。
  const chooseWorkspaceFolder = useCallback(async () => {
    if (workspaceFolderBusy) return;
    setWorkspaceFolderBusy(true);
    try {
      const picked = await pickWorkspaceFolder();
      if (!picked) return;
      const saved = await patchWorkspaceSettings({ location: { kind: 'saf', uri: picked.uri, name: picked.name } });
      setWorkspaceFolder(saved.location);
      setCommandExecution(saved.allowCommandExecution);
    } catch (error) {
      Alert.alert(t('settings.workspace.folder.err.title'), (error && error.message) || t('settings.workspace.folder.err.body'));
    } finally {
      setWorkspaceFolderBusy(false);
    }
  }, [t, workspaceFolderBusy]);

  const resetWorkspaceFolder = useCallback(async () => {
    try {
      const saved = await patchWorkspaceSettings({ location: { kind: 'app', uri: '', name: '' } });
      setWorkspaceFolder(saved.location);
      setCommandExecution(saved.allowCommandExecution);
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  // 命令执行的开关放在确认弹框之后：这是「模型生成的命令会在手机里真的跑」的开关，
  // 不能一点就生效。
  const toggleCommandExecution = useCallback((value) => {
    if (!value) {
      patchWorkspaceSettings({ allowCommandExecution: false })
        .then(saved => {
          if (settingsMountedRef.current) setCommandExecution(saved.allowCommandExecution);
        })
        .catch(() => Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission')));
      return;
    }
    Alert.alert(
      t('settings.workspace.shell.confirm.title'),
      t('settings.workspace.shell.confirm.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.workspace.shell.confirm.ok'),
          style: 'destructive',
          onPress: () => {
            patchWorkspaceSettings({ allowCommandExecution: true })
              .then(saved => {
                if (settingsMountedRef.current) setCommandExecution(saved.allowCommandExecution);
              })
              .catch(() => Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission')));
          },
        },
      ]
    );
  }, [t]);

  useEffect(() => {
    settingsMountedRef.current = true;
    return () => { settingsMountedRef.current = false; };
  }, []);

  useEffect(() => {
    apiMountedRef.current = true;
    getApiConfigs()
      .then(({ configs: list, activeId: id }) => {
        if (!apiMountedRef.current) return;
        apiStateRef.current = { configs: list, activeId: id, loaded: true };
        apiBaselineRef.current = snapshotActiveConfig(apiStateRef.current);
        setConfigs(list);
        setActiveId(id);
        setLoaded(true);
      })
      .catch(() => {
        if (apiMountedRef.current) Alert.alert(t('settings.api.loadFailed.title'), t('settings.api.loadFailed.body'));
      });
    loadUserProfile();
    return () => {
      apiMountedRef.current = false;
      const request = modelRequestRef.current;
      modelRequestRef.current = null;
      modelSourceRef.current = null;
      request?.cancel?.();
    };
  }, [loadUserProfile]);

  const active = useMemo(
    () => configs.find(item => item.id === activeId) || configs[0] || null,
    [configs, activeId]
  );
  const activeVendor = useMemo(
    () => getChatApiVendor(active && active.vendorId),
    [active]
  );

  const invalidateModels = () => {
    const request = modelRequestRef.current;
    modelRequestRef.current = null;
    modelSourceRef.current = null;
    request?.cancel?.();
    setDetectingModels(false);
    setModelList([]);
    setModelModalVisible(false);
  };

  const canChangeApi = () => apiMountedRef.current && apiStateRef.current.loaded && !apiBusyRef.current;

  const persist = async (list, id) => {
    const saved = await saveApiConfigs(list, id);
    if (!apiMountedRef.current) return saved;
    invalidateModels();
    apiStateRef.current = { ...saved, loaded: true };
    apiBaselineRef.current = snapshotActiveConfig(apiStateRef.current);
    setConfigs(saved.configs);
    setActiveId(saved.activeId);
    return saved;
  };

  const changeConfig = async (list, id) => {
    if (!canChangeApi()) return;
    apiBusyRef.current = true;
    setApiSaving(true);
    invalidateModels();
    try {
      await persist(list, id);
    } catch (error) {
      if (apiMountedRef.current) Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    } finally {
      apiBusyRef.current = false;
      if (apiMountedRef.current) setApiSaving(false);
    }
  };

  const updateField = patch => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    if (!current.configs.some(item => item.id === current.activeId)) return;
    if ('baseUrl' in patch || 'apiKey' in patch) invalidateModels();
    const list = current.configs.map(item => (item.id === current.activeId ? { ...item, ...patch } : item));
    apiStateRef.current = { ...current, configs: list };
    setConfigs(list);
  };

  // 切换接口协议：顺带按协议重置默认鉴权头（用户仍可在保存前手改）。
  // 切换协议会改变端点与请求格式，视为与地址变更同级，需作废已探测的模型列表。
  const changeProtocol = protocol => {
    if (!canChangeApi()) return;
    const option = CHAT_PROTOCOL_OPTIONS.find(item => item.id === protocol);
    if (!option) return;
    invalidateModels();
    updateField({
      protocol,
      authHeader: option.auth.header,
      authScheme: option.auth.prefix,
    });
  };

  // 切走前确认未保存的修改。selectConfig/applyVendorPreset 原本会把改了一半的草稿
  // 连同整个列表静默落盘（未经校验），现在让用户显式选择：继续编辑，或还原到基线
  // 快照后再切换。
  const confirmDiscardDirtyApi = () => new Promise(resolve => {
    const state = apiStateRef.current;
    if (snapshotActiveConfig(state) === apiBaselineRef.current) {
      resolve(true);
      return;
    }
    Alert.alert(
      t('settings.api.dirty.title'),
      t('settings.api.dirty.body'),
      [
        { text: t('settings.api.dirty.keep'), style: 'cancel', onPress: () => resolve(false) },
        {
          text: t('settings.api.dirty.discard'),
          style: 'destructive',
          onPress: () => {
            const baseline = apiBaselineRef.current ? JSON.parse(apiBaselineRef.current) : null;
            const list = baseline
              ? state.configs.map(item => (item.id === state.activeId ? { ...baseline } : item))
              : state.configs;
            apiStateRef.current = { ...state, configs: list };
            setConfigs(list);
            resolve(true);
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });

  const selectConfig = async id => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    if (id === current.activeId || !current.configs.some(item => item.id === id)) return;
    if (!(await confirmDiscardDirtyApi())) return;
    return changeConfig(apiStateRef.current.configs, id);
  };

  const addConfig = () => {
    if (!canChangeApi()) return;
    setVendorPickerOpen(true);
  };

  const applyVendorPreset = async preset => {
    if (!canChangeApi() || !preset) return;
    if (!(await confirmDiscardDirtyApi())) return;
    setVendorPickerOpen(false);
    const list = apiStateRef.current.configs;
    const auth = preset.auth || {};
    const created = createApiConfig({
      name: preset.name,
      baseUrl: preset.baseUrl || '',
      vendorId: preset.id,
      protocol: preset.protocol || 'openai',
      authHeader: auth.header || 'Authorization',
      authScheme: auth.prefix === undefined ? 'Bearer ' : auth.prefix,
      apiKeyUrl: preset.apiKeyUrl || '',
      models: [],
      activeModel: '',
    });
    return changeConfig([...list, created], created.id);
  };

  const openApiKeyUrl = url => {
    if (!url) return;
    Linking.openURL(url).catch(() => {
      Alert.alert(t('settings.api.openLinkFailed'), url);
    });
  };

  const deleteConfig = () => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    const target = current.configs.find(item => item.id === current.activeId);
    if (!target || current.configs.length <= 1) {
      Alert.alert(t('settings.api.deleteBlocked.title'), t('settings.api.deleteBlocked.body'));
      return;
    }
    Alert.alert(t('settings.api.delete.title'), t('settings.api.delete.body', { name: target.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          if (!canChangeApi()) return;
          const latest = apiStateRef.current;
          if (latest.configs.length <= 1 || !latest.configs.some(item => item.id === target.id)) return;
          const next = latest.configs.filter(item => item.id !== target.id);
          const nextActive = latest.activeId === target.id ? next[0].id : latest.activeId;
          return changeConfig(next, nextActive);
        },
      },
    ]);
  };

  const performSave = async () => {
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected) return;
    apiBusyRef.current = true;
    setApiSaving(true);
    try {
      const trimmedModels = (selected.models || [])
        .map(item => String(item || '').trim())
        .filter(Boolean);
      const activeModel = trimmedModels.includes(selected.activeModel)
        ? selected.activeModel
        : trimmedModels[0];
      const trimmed = current.configs.map(item =>
        item.id === selected.id
          ? {
              ...item,
               name: String(item.name || '').trim() || '未命名配置',
               baseUrl: String(item.baseUrl || '').trim(),
               apiKey: String(item.apiKey || '').trim(),

              models: trimmedModels,
              activeModel,
            }
          : item
      );
      await persist(trimmed, selected.id);
      if (apiMountedRef.current) Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error) {
      if (apiMountedRef.current) Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    } finally {
      apiBusyRef.current = false;
      if (apiMountedRef.current) setApiSaving(false);
    }
  };

  const save = async () => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected) return;
    const trimmedModels = (selected.models || [])
      .map(item => String(item || '').trim())
      .filter(Boolean);
    if (trimmedModels.length === 0) {
      Alert.alert(t('settings.api.noModels.title'), t('settings.api.noModels.body'));
      return;
    }
     const trimmedBaseUrl = String(selected.baseUrl || '').trim();
     if (!trimmedBaseUrl) {
       Alert.alert(t('settings.api.noAddress.title'), t('settings.api.noAddress.body'));
       return;
     }
     if (!/^https?:\/\//i.test(trimmedBaseUrl)) {
       Alert.alert(t('settings.api.badAddress.title'), t('settings.api.badAddress.body'));
       return;
     }
     if (/^http:\/\//i.test(trimmedBaseUrl)) {

      const confirmed = await new Promise(resolve => {
        Alert.alert(
          t('settings.api.http.title'),
          t('settings.api.http.body'),
          [
            { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('settings.api.http.saveAnyway'), style: 'destructive', onPress: () => resolve(true) }
          ],
          { cancelable: true, onDismiss: () => resolve(false) }
        );
      });
      if (!confirmed || !apiMountedRef.current) return;
    }
    await performSave();
  };

  // 能力弹层的确认：把「该模型的能力」写回草稿。仍点位模型能力，不写盘——
  // 与草稿/保存分离的既有语义一致（点「保存配置」才落盘）。
  const confirmCapability = () => {
    const name = capabilityEditorModel;
    setCapabilityOpen(false);
    if (!name || !canChangeApi()) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected) return;
    const entry = normalizeCapabilityEntry({
      supportsThinking: capabilityDraft.supportsThinking === true,
      thinkingField: String(capabilityDraft.thinkingField || '').trim() || 'reasoning_effort',
      thinkingFormat: ['effort', 'boolean', 'object'].includes(capabilityDraft.thinkingFormat)
        ? capabilityDraft.thinkingFormat
        : 'effort',
      supportsVision: capabilityDraft.supportsVision === true,
      supportsVideo: capabilityDraft.supportsVideo === true,
      supportsAudio: capabilityDraft.supportsAudio === true,
      contextWindow: Math.max(0, Math.floor(Number(capabilityDraft.contextWindow)) || 0),
      maxOutput: Math.max(0, Math.floor(Number(capabilityDraft.maxOutput)) || 0),
      // 显示值显式写回：关掉开关时也保留用户填过的值（生效与否由该标记决定）。
      customParams: capabilityDraft.customParams === true,
    });
    updateField({
      modelCapabilities: { ...(selected.modelCapabilities || {}), [name]: entry },
    });
    setCapabilityEditorModel('');
  };

  // 当前思考参数命中的预设（找不到 = 自定义）：折叠标题用它显示「现在用的是哪种」。
  const matchedThinkingPreset = THINKING_PRESETS.find(preset => (
    preset.id !== 'custom'
    && preset.field === capabilityDraft.thinkingField
    && preset.format === capabilityDraft.thinkingFormat
  )) || null;

  // 拉取该 API 配置的模型清单（GET /models，含 /v1 回退）。抽出来给「检测模型」与
  // 「搜索」共用，避免两处各写一遍 XHR/鉴权/解析。isCurrent 供取消/竞态校验。
  const fetchProviderModels = async (selected, request, isCurrent) => {
    const selectedProtocol = selected.protocol || 'openai';
    const base = normalizeChatUrl(selected.baseUrl).replace(/\/chat\/completions$/i, '');
    const fallback = /\/v1$/i.test(base) ? base.replace(/\/v1$/i, '') : `${base}/v1`;
    const urls = [`${base}/models`, `${fallback}/models`];
    let result = [];
    for (const url of urls) {
      if (!isCurrent()) return result;
      if (result.length) break;
      try {
        const detectAuthHeader = String(selected.authHeader || (selectedProtocol === 'anthropic' ? 'x-api-key' : 'Authorization'));
        const detectAuthScheme = selected.authScheme === undefined
          ? (selectedProtocol === 'anthropic' ? '' : 'Bearer ')
          : String(selected.authScheme);
        const headers = { [detectAuthHeader]: `${detectAuthScheme}${selected.apiKey.trim()}` };
        if (selectedProtocol === 'anthropic') headers['anthropic-version'] = String(selected.anthropicVersion || '2023-06-01');
        const text = await vendorXhr({
          method: 'GET',
          url,
          headers,
          timeoutMs: 15000,
          nativeTimeout: true,
          cancelHandle: request,
          onTimeoutError: () => new Error(t('settings.api.err.timeout')),
          onAbortError: () => new Error(t('settings.api.err.cancelled')),
          onAbortEventError: () => new Error(t('settings.api.err.cancelled')),
          onCancelError: () => new Error(t('settings.api.err.cancelled')),
          onNetworkError: () => new Error(t('settings.api.err.network')),
          onHttpError: () => new Error(t('settings.api.err.request')),
          parse: xhr => xhr.responseText,
          onParseError: () => new Error(t('settings.api.err.request')),
        });
        if (!isCurrent()) return result;
        const data = JSON.parse(text);
        if (Array.isArray(data?.data)) {
          result = [...new Set(data.data.map(item => String(item?.id || '')).filter(Boolean))];
        }
      } catch (error) {}
    }
    return result;
  };

  // 统一的开检前置：返回选中的配置，校验失败返回 null（并给提示）。
  const beginModelRequest = () => {
    if (!canChangeApi() || modelRequestRef.current) return null;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected?.apiKey.trim() || !selected?.baseUrl.trim()) {
      Alert.alert(t('settings.api.fillRequired'));
      return null;
    }
    invalidateModels();
    const request = { cancel: null };
    modelRequestRef.current = request;
    const isCurrent = () => apiMountedRef.current && modelRequestRef.current === request;
    setDetectingModels(true);
    return { selected, request, isCurrent };
  };

  const endModelRequest = () => {
    modelRequestRef.current = null;
    setDetectingModels(false);
  };

  const detectModels = async () => {
    const ctx = beginModelRequest();
    if (!ctx) return;
    const { selected, request, isCurrent } = ctx;
    const result = await fetchProviderModels(selected, request, isCurrent);
    if (!isCurrent()) return;
    endModelRequest();
    if (result.length) {
      modelSourceRef.current = selected;
      setModelList(result);
      setModelModalVisible(true);
    } else {
      Alert.alert(t('settings.api.noModelsDetected.title'), t('settings.api.noModelsDetected.body'));
    }
  };

  // 搜索：按输入框内容从接口返回的模型里筛出匹配项。空输入 = 列出全部。
  const searchModels = async () => {
    const ctx = beginModelRequest();
    if (!ctx) return;
    const { selected, request, isCurrent } = ctx;
    const query = modelDraft.trim().toLowerCase();
    const all = await fetchProviderModels(selected, request, isCurrent);
    if (!isCurrent()) return;
    endModelRequest();
    if (all.length === 0) {
      Alert.alert(t('settings.api.noModelsDetected.title'), t('settings.api.noModelsDetected.body'));
      return;
    }
    const matched = query ? all.filter(model => model.toLowerCase().includes(query)) : all;
    if (matched.length === 0) {
      Alert.alert(t('settings.api.noMatch.title'), t('settings.api.noMatch.body', { query: modelDraft.trim() }));
      return;
    }
    modelSourceRef.current = selected;
    setModelList(matched);
    setModelModalVisible(true);
  };

  const applyModel = model => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    const source = modelSourceRef.current;
    if (!selected || !source || selected.id !== source.id
      || selected.baseUrl !== source.baseUrl || selected.apiKey !== source.apiKey) return;
    const models = Array.isArray(selected.models) ? selected.models : [];
    const nextModels = models.includes(model) ? models : [...models, model];
    updateField({ models: nextModels, activeModel: model });
    setModelModalVisible(false);
    // 从「可用模型」列表添加/选中后，顺手确认这个模型的能力。
    openCapabilityEditor(model);
  };

  const addModel = () => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    const model = modelDraft.trim();
    if (!selected || !model) return;
    const models = Array.isArray(selected.models) ? selected.models : [];
    if (models.includes(model)) {
      updateField({ activeModel: model });
      setModelDraft('');
      openCapabilityEditor(model);
      return;
    }
    updateField({ models: [...models, model], activeModel: model });
    setModelDraft('');
    // 新模型不继承任何旧能力值：添加后立即让用户确认这个模型的能力。
    openCapabilityEditor(model);
  };

  const selectActiveModel = model => {
    if (!canChangeApi()) return;
    updateField({ activeModel: model });
  };

  // 打开某模型的能力弹层：条目不存在（新模型未确认）时按全不支持起稿。
  const openCapabilityEditor = modelName => {
    const name = String(modelName || '').trim();
    if (!name || !canChangeApi()) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected) return;
    // 回填用**原始**能力：customParams 关闭时也要把上次填过的值带出来，
    // 用户重新打开总开关就能看到原值（是否生效由开关决定，不由回填清空）。
    const caps = rawCapabilityForModel(selected, name);
    setCapabilityDraft({
      supportsThinking: caps.supportsThinking,
      supportsVision: caps.supportsVision,
      supportsVideo: caps.supportsVideo,
      supportsAudio: caps.supportsAudio,
      thinkingField: caps.thinkingField,
      thinkingFormat: caps.thinkingFormat,
      contextWindow: caps.contextWindow > 0 ? String(caps.contextWindow) : '',
      maxOutput: caps.maxOutput > 0 ? String(caps.maxOutput) : '',
      customParams: caps.customParams === true,
    });
    setThinkingPresetOpen(false);
    setCapabilityEditorModel(name);
    setCapabilityOpen(true);
  };

  const removeModel = model => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected) return;
    const models = Array.isArray(selected.models) ? selected.models : [];
    if (models.length <= 1) {
      Alert.alert(t('settings.api.keepOne.title'), t('settings.api.keepOne.body'));
      return;
    }
    const nextModels = models.filter(item => item !== model);
    const activeModel = selected.activeModel === model ? nextModels[0] : selected.activeModel;
    updateField({ models: nextModels, activeModel });
  };

  const openTutorial = () => {
    setTutorialOpen(true);
  };

  const openDisclaimer = () => {
    setDisclaimerOpen(true);
  };

  const openGitHub = () => {
    Linking.openURL('https://github.com/pppxxxy/easychat2').catch(() =>
      Alert.alert(t('settings.about.cantOpen.title'), t('settings.about.cantOpen.github'))
    );
  };

  const checkUpdate = () => {
    Linking.openURL('https://github.com/pppxxxy/easychat2/releases').catch(() =>
      Alert.alert(t('settings.about.cantOpen.title'), t('settings.about.cantOpen.releases'))
    );
  };

  // ---- 折叠头摘要行：收起时一眼看到关键状态 ----
  const apiSummary = active
    ? [String(active.name || '').trim() || t('settings.api.unnamed'), String(active.activeModel || '').trim()]
      .filter(Boolean).join(' · ')
    : t('settings.summary.unconfigured');
  const personaSummary = String(userName || '').trim() || t('settings.summary.personaEmpty');
  const appearanceSummary = [
    (themes.find(item => item.id === themeId) || {}).labelKey
      ? t(themes.find(item => item.id === themeId).labelKey)
      : '',
    localeId === 'en' ? 'English' : '',
  ].filter(Boolean).join(' · ');
  const experienceEnabledCount = [
    chatOptions.streaming === true,
    chatOptions.fullWidth === true,
    chatOptions.richHtml !== false,
    chatOptions.keepDraft === true,
    chatOptions.timeAware === true,
    locationSettings && locationSettings.awareness === true,
    momentsEnabled === true,
  ].filter(Boolean).length;
  const experienceSummary = t('settings.summary.enabledCount', { count: experienceEnabledCount });
  const inlineImageSummary = inlineImage.enabled
    ? (activeImageProvider
      ? `${t('settings.summary.on')} · ${activeImageProvider.label}`
      : t('settings.summary.on'))
    : t('settings.summary.off');
  const vectorSummary = vectorPayload.enabled === true ? t('settings.summary.on') : t('settings.summary.off');
  const githubSummary = githubMcp && githubMcp.enabled && githubMcp.connectedAt > 0
    ? t('settings.summary.connected')
    : t('settings.summary.disconnected');
  const workspaceSummary = workspaceMode === 'write'
    ? t('settings.workspace.summary.write')
    : (workspaceMode === 'read' ? t('settings.workspace.summary.read') : t('settings.workspace.summary.ask'));
  const aboutSummary = APP_VERSION ? `v${APP_VERSION}` : '';

  // 折叠头吸顶：只把「已收起」的卡设为 sticky（展开的卡较高，吸顶会遮挡其内容）。
  // 子节点顺序：0=页头，1..N=各卡（与下方渲染顺序一致）。
  const SECTION_RENDER_ORDER = ['api', 'sampling', 'persona', 'appearance', 'experience', 'extensions', 'vector', 'workspace', 'github', 'about'];
  const stickyHeaderIndices = SECTION_RENDER_ORDER
    .map((id, index) => (isSectionOpen(id) ? null : index + 1))
    .filter(value => value !== null);

  // 各卡片内容已拆到 settings/sections/*；这里汇总它们需要的状态与回调，
  // 一次展开传入，避免每张卡重复接线。
  const sectionProps = {
    styles,
    theme,
    t,
    // API 配置
    activeId,
    active,
    activeVendor,
    configs,
    CHAT_PROTOCOL_OPTIONS,
    modelDraft,
    setModelDraft,
    detectingModels,
    selectConfig,
    updateField,
    changeProtocol,
    addModel,
    searchModels,
    selectActiveModel,
    openCapabilityEditor,
    removeModel,
    detectModels,
    openApiKeyUrl,
    save,
    deleteConfig,
    // 用户人设
    userName,
    setUserName,
    userPersona,
    setUserPersona,
    userAvatarUri,
    userProfileSaved,
    personas,
    setPersonas,
    activePersonaId,
    saveUserProfileDelayed,
    changeUserAvatar,
    selectPersona,
    addPersona,
    removePersona,
    pickUserAvatar,
    saveUserProfileNow,
    // 外观与语言
    themes,
    themeId,
    setThemeId,
    fontScales,
    fontScaleId,
    setFontScaleId,
    locales,
    localeId,
    setLocaleId,
    thinkingDisplay,
    updateThinkingDisplay,
    // 对话体验
    chatOptions,
    updateChatOption,
    setPresetEntryOpen,
    enabledPresetCount,
    locationSettings,
    toggleLocationAwareness,
    momentsEnabled,
    toggleMoments,
    // 功能扩展
    inlineImage,
    updateInlineImage,
    inlineImageProviders,
    imageGenProviders,
    activeImageProvider,
    updateImageGenProvider,
    imageGenTesting,
    testImageGenProvider,
    setPluginEntryOpen,
    setTtsEntryOpen,
    setTranscriptionEntryOpen,
    // 向量记忆
    vectorPayload,
    vectorRef,
    vectorTesting,
    vectorTopKDraft,
    setVectorTopKDraft,
    vectorMaxCharsDraft,
    setVectorMaxCharsDraft,
    currentVectorConfig,
    flushVectorMemory,
    updateVectorConfig,
    toggleVectorEnabled,
    addVectorConfig,
    selectVectorConfig,
    removeVectorConfig,
    testVector,
    // 工作区
    workspaceMode,
    updateWorkspaceMode,
    workspaceFolder,
    workspaceFolderBusy,
    resetWorkspaceFolder,
    chooseWorkspaceFolder,
    commandExecution,
    toggleCommandExecution,
    setWorkspaceOpen,
    // GitHub
    githubMcp,
    githubPat,
    setGithubPat,
    githubBusy,
    githubPageBusy,
    connectGithubPat,
    openGithubTokenPage,
    disconnectGithub,
    // 关于
    appVersion: APP_VERSION,
    openTutorial,
    openDisclaimer,
    openGitHub,
    checkUpdate,
    setDiagnosticsOpen,
    setBackupOpen,
    setLocalModelOpen,
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickyHeaderIndices={stickyHeaderIndices}
      >
        <View style={styles.pageHeader}>
          <View style={styles.pageHeaderTop}>
            <Text style={styles.title}>{t('settings.title')}</Text>
            <TouchableOpacity
              style={[styles.searchToggle, searchOpen && styles.searchToggleActive]}
              onPress={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              activeOpacity={0.8}
              accessibilityLabel={searchOpen ? t('settings.search.a11yClose') : t('settings.search.a11yOpen')}
            >
              <Ionicons name={searchOpen ? 'close' : 'search'} size={18} color={theme.colors.primarySoft} />
            </TouchableOpacity>
          </View>
          <FieldHint style={styles.hint}>{t('settings.subtitle')}</FieldHint>
          {searchOpen ? (
            <View style={styles.searchBox}>
              <TextField
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('settings.search.placeholder')}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searchQuery.trim() ? (
                searchResults.length > 0 ? (
                  <View style={styles.searchResults}>
                    {searchResults.map((item, index) => (
                      <TouchableOpacity
                        key={`${item.sectionId}-${item.label}-${index}`}
                        style={styles.searchResultRow}
                        onPress={() => navigateToSection(item.sectionId)}
                        activeOpacity={0.75}
                      >
                        <Text style={styles.searchResultLabel}>{item.label}</Text>
                        <Text style={styles.searchResultSection}>{settingsSectionLabel(item.sectionId)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.searchEmpty}>{t('settings.search.empty')}</Text>
                )
              ) : null}
            </View>
          ) : null}
        </View>

        <Card
          style={[styles.sectionCard, flashSection === 'api' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.api = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.api.title')}
            icon="key-outline"
            open={isSectionOpen('api')}
            onToggle={next => toggleSection('api', next)}
            right={(
              <View style={styles.summaryRow}>
                <Text style={styles.collapseSummary} numberOfLines={1}>{apiSummary}</Text>
                <TopicButton
                  style={styles.topicButtonSpaced}
                  onPress={() => setTopic('chat-api')}
                  accessibilityLabel={t('settings.api.a11yTutorial')}
                />
                <TouchableOpacity
                  style={[styles.pillButton, (!loaded || apiSaving) && styles.buttonDisabled]}
                  onPress={addConfig}
                  disabled={!loaded || apiSaving}
                  activeOpacity={0.8}
                >
                  <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.pillButtonText}>{t('settings.api.add')}</Text>
                </TouchableOpacity>
              </View>
            )}
          >
          <ApiSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

<SamplingCard
          open={isSectionOpen('sampling')}
          onToggle={next => toggleSection('sampling', next)}
          flash={flashSection === 'sampling'}
        />

        <Card
          style={[styles.sectionCard, flashSection === 'persona' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.persona = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.persona.title')}
            icon="person-circle-outline"
            open={isSectionOpen('persona')}
            onToggle={next => toggleSection('persona', next)}
            right={(
              <View style={styles.summaryRow}>
                {userAvatarUri ? (
                  <Image source={{ uri: userAvatarUri }} style={styles.summaryAvatar} />
                ) : null}
                <Text style={styles.collapseSummary} numberOfLines={1}>{personaSummary}</Text>
                <TopicButton
                  onPress={() => setTopic('user-persona')}
                  accessibilityLabel={t('settings.persona.a11yTutorial')}
                />
              </View>
            )}
          >
          <PersonaSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <Card
          style={[styles.sectionCard, flashSection === 'appearance' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.appearance = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.appearance.title')}
            icon="color-palette-outline"
            open={isSectionOpen('appearance')}
            onToggle={next => toggleSection('appearance', next)}
            right={<Text style={styles.collapseSummary} numberOfLines={1}>{appearanceSummary}</Text>}
          >
          <AppearanceSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <Card
          style={[styles.sectionCard, flashSection === 'experience' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.experience = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.experience.title')}
            icon="chatbubbles-outline"
            open={isSectionOpen('experience')}
            onToggle={next => toggleSection('experience', next)}
            right={<Text style={styles.collapseSummary} numberOfLines={1}>{experienceSummary}</Text>}
          >
          <ExperienceSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <Card
          style={[styles.sectionCard, flashSection === 'extensions' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.extensions = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.extensions.title')}
            icon="extension-puzzle-outline"
            open={isSectionOpen('extensions')}
            onToggle={next => toggleSection('extensions', next)}
            right={(
              <View style={styles.summaryRow}>
                <Text style={styles.collapseSummary} numberOfLines={1}>{inlineImageSummary}</Text>
                <TopicButton
                  onPress={() => setTopic('inline-image')}
                  accessibilityLabel={t('settings.inlineImage.a11yTutorial')}
                />
              </View>
            )}
          >
          <ExtensionsSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <Card
          style={[styles.sectionCard, flashSection === 'vector' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.vector = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.vector.title')}
            icon="git-network-outline"
            open={isSectionOpen('vector')}
            onToggle={next => toggleSection('vector', next)}
            right={(
              <View style={styles.summaryRow}>
                <Text style={styles.collapseSummary} numberOfLines={1}>{vectorSummary}</Text>
                <TopicButton
                  onPress={() => setTopic('vector-api')}
                  accessibilityLabel={t('settings.vector.a11yTutorial')}
                />
              </View>
            )}
          >
          <VectorSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <Card
          style={[styles.sectionCard, flashSection === 'workspace' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.workspace = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.workspace.title')}
            icon="briefcase-outline"
            open={isSectionOpen('workspace')}
            onToggle={next => toggleSection('workspace', next)}
            right={<Text style={styles.collapseSummary} numberOfLines={1}>{workspaceSummary}</Text>}
          >
          <WorkspaceSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <Card
          style={[styles.sectionCard, flashSection === 'github' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.github = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.github.title')}
            icon="logo-github"
            open={isSectionOpen('github')}
            onToggle={next => toggleSection('github', next)}
            right={<Text style={styles.collapseSummary} numberOfLines={1}>{githubSummary}</Text>}
          >
          <GithubSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <Card
          style={[styles.sectionCard, flashSection === 'about' && styles.sectionCardFlash]}
          onLayout={event => { sectionOffsetsRef.current.about = event.nativeEvent.layout.y; }}
        >
          <CollapsibleSection
            title={t('settings.about.title')}
            icon="information-circle-outline"
            open={isSectionOpen('about')}
            onToggle={next => toggleSection('about', next)}
            right={<Text style={styles.collapseSummary} numberOfLines={1}>{aboutSummary}</Text>}
          >
          <AboutSection {...sectionProps} />
          </CollapsibleSection>
        </Card>

        <TtsPanel
          visible={ttsEntryOpen}
          onClose={() => setTtsEntryOpen(false)}
        />

        <TranscriptionPanel
          visible={transcriptionEntryOpen}
          onClose={() => setTranscriptionEntryOpen(false)}
        />

        <PresetPanel
          visible={presetEntryOpen}
          onClose={() => {
            setPresetEntryOpen(false);
            refreshPresetCount();
          }}
        />

        <PluginPanel
          visible={pluginEntryOpen}
          onClose={() => setPluginEntryOpen(false)}
        />

      </ScrollView>

      <Modal
        visible={vendorPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setVendorPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setVendorPickerOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t('settings.vendorPicker.title')}</Text>
            <FieldHint style={styles.hint}>{t('settings.vendorPicker.hint')}</FieldHint>
            <ScrollView style={styles.vendorList} keyboardShouldPersistTaps="handled">
              <Text style={styles.vendorSectionLabel}>{t('settings.vendorPicker.recommended')}</Text>
              {CHAT_API_VENDORS.map(vendor => (
                <TouchableOpacity
                  key={vendor.id}
                  style={styles.vendorRow}
                  onPress={() => applyVendorPreset(vendor)}
                  activeOpacity={0.8}
                >
                  <View style={styles.vendorRowHead}>
                    <Text style={styles.vendorName}>{vendor.name}</Text>
                    <Text style={styles.vendorCategory}>
                      {vendor.category.map(item => (item === 'image' ? t('settings.vendorPicker.categoryImage') : t('settings.vendorPicker.categoryChat'))).join(' / ')}
                    </Text>
                  </View>
                  <Text style={styles.vendorBaseUrl}>{vendor.baseUrl || t('settings.vendorPicker.urlFromConsole')}</Text>
                  <Text style={styles.vendorNote}>{vendor.note}</Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.vendorSectionLabel}>{t('settings.vendorPicker.protocols')}</Text>
              {API_PROTOCOL_PRESETS.map(preset => (
                <TouchableOpacity
                  key={preset.id}
                  style={[styles.vendorRow, preset.disabled && styles.vendorRowDisabled]}
                  onPress={() => applyVendorPreset(preset)}
                  disabled={preset.disabled}
                  activeOpacity={0.8}
                >
                  <View style={styles.vendorRowHead}>
                    <Text style={[styles.vendorName, preset.disabled && styles.vendorNameDisabled]}>
                      {preset.name}
                    </Text>
                    {preset.disabled ? (
                      <Text style={styles.vendorCategory}>{t('settings.vendorPicker.comingSoon')}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.vendorNote}>{preset.note}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={modelModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModelModalVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setModelModalVisible(false)}
        >
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t('settings.modelModal.title')}</Text>
            <ScrollView
              style={styles.modalList}
              contentContainerStyle={styles.modalListContent}
              keyboardShouldPersistTaps="handled"
            >
              {modelList.map(model => (
                <TouchableOpacity
                  key={model}
                  style={styles.modalRow}
                  onPress={() => applyModel(model)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.modalRowText}>{model}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={capabilityOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCapabilityOpen(false)}
      >
        <View style={[styles.modalBackdrop, styles.capabilityBackdrop]}>
          <View style={[styles.modalSheet, styles.capabilitySheet]}>
            <Text style={styles.modalTitle}>{t('settings.capability.title')}</Text>
            <FieldHint style={styles.hint}>
              {capabilityEditorModel ? t('settings.capability.modelLine', { model: capabilityEditorModel }) : ''}
              {t('settings.capability.hint')}
            </FieldHint>
            <ScrollView style={styles.capabilityScroll} contentContainerStyle={styles.capabilityScrollContent}>
            <View style={styles.capabilityRow}>
              <Text style={styles.capabilityLabel}>{t('settings.capability.thinking')}</Text>
              <Switch
                value={capabilityDraft.supportsThinking}
                onValueChange={value => setCapabilityDraft(current => ({
                  ...current,
                  supportsThinking: value,
                }))}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            <View style={styles.capabilityRow}>
              <Text style={styles.capabilityLabel}>{t('settings.capability.vision')}</Text>
              <Switch
                value={capabilityDraft.supportsVision}
                onValueChange={value => setCapabilityDraft(current => ({
                  ...current,
                  supportsVision: value,
                }))}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            <View style={styles.capabilityRow}>
              <Text style={styles.capabilityLabel}>{t('settings.capability.video')}</Text>
              <Switch
                value={capabilityDraft.supportsVideo === true}
                onValueChange={value => setCapabilityDraft(current => ({
                  ...current,
                  supportsVideo: value,
                }))}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            <View style={styles.capabilityRow}>
              <Text style={styles.capabilityLabel}>{t('settings.capability.audio')}</Text>
              <Switch
                value={capabilityDraft.supportsAudio}
                onValueChange={value => setCapabilityDraft(current => ({
                  ...current,
                  supportsAudio: value,
                }))}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            <View style={styles.capabilityRow}>
              <View style={styles.capabilityLabelBlock}>
                <Text style={styles.capabilityLabelStacked}>{t('settings.capability.customParams')}</Text>
                <Text style={styles.capabilitySubLabel}>
                  {t('settings.capability.customParamsHint')}
                </Text>
              </View>
              <Switch
                value={capabilityDraft.customParams === true}
                onValueChange={value => setCapabilityDraft(current => ({
                  ...current,
                  customParams: value,
                }))}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>

            {capabilityDraft.customParams === true ? (
              <>
                {capabilityDraft.supportsThinking ? (
                  <View style={styles.paramBox}>
                    <TouchableOpacity
                      style={styles.collapseHeader}
                      onPress={() => setThinkingPresetOpen(open => !open)}
                      activeOpacity={0.8}
                    >
                      <View style={styles.collapseHeaderText}>
                        <Text style={styles.paramLabel}>{t('settings.capability.thinkingParams')}</Text>
                        <Text style={styles.collapseValue} numberOfLines={1}>
                          {matchedThinkingPreset ? matchedThinkingPreset.name : t('settings.capability.customPreset')}
                        </Text>
                      </View>
                      <Ionicons
                        name={thinkingPresetOpen ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={theme.colors.textMuted}
                      />
                    </TouchableOpacity>
                    {thinkingPresetOpen ? (
                      <View style={styles.presetList}>
                        {THINKING_PRESETS.map(preset => {
                          const active = preset.id === 'custom'
                            ? !matchedThinkingPreset
                            : !!(matchedThinkingPreset && matchedThinkingPreset.id === preset.id);
                          return (
                            <TouchableOpacity
                              key={preset.id}
                              style={[styles.presetItem, active && styles.presetItemActive]}
                              onPress={() => setCapabilityDraft(current => ({
                                ...current,
                                thinkingField: preset.id === 'custom'
                                  ? current.thinkingField
                                  : preset.field,
                                thinkingFormat: preset.id === 'custom'
                                  ? current.thinkingFormat
                                  : preset.format,
                              }))}
                              activeOpacity={0.8}
                            >
                              <Text style={[styles.presetName, active && styles.presetNameActive]}>
                                {preset.name}
                              </Text>
                              <Text style={styles.presetHint}>{preset.hint}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ) : null}
                    {!matchedThinkingPreset ? (
                      <View style={styles.customThinkingBlock}>
                        <TextField
                          value={capabilityDraft.thinkingField}
                          onChangeText={thinkingField => setCapabilityDraft(current => ({
                            ...current,
                            thinkingField,
                          }))}
                          autoCapitalize="none"
                          autoCorrect={false}
                          placeholder="reasoning_effort"
                        />
                        <View style={styles.thinkingFormatRow}>
                          {['effort', 'boolean', 'object'].map(format => {
                            const active = capabilityDraft.thinkingFormat === format;
                            return (
                              <TouchableOpacity
                                key={format}
                                style={[styles.formatChip, active && styles.formatChipActive]}
                                onPress={() => setCapabilityDraft(current => ({
                                  ...current,
                                  thinkingFormat: format,
                                }))}
                                activeOpacity={0.8}
                              >
                                <Text style={[styles.formatChipText, active && styles.formatChipTextActive]}>
                                  {format}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                <View style={styles.paramBox}>
                  <View style={styles.paramField}>
                    <Text style={styles.paramLabel}>{t('settings.capability.contextWindow')}</Text>
                    <TextField
                      value={capabilityDraft.contextWindow}
                      onChangeText={value => setCapabilityDraft(current => ({
                        ...current,
                        contextWindow: String(value || '').replace(/[^0-9]/g, ''),
                      }))}
                      keyboardType="number-pad"
                      placeholder={t('settings.capability.contextWindowPlaceholder')}
                    />
                  </View>
                  <View style={[styles.paramField, styles.paramFieldLast]}>
                    <Text style={styles.paramLabel}>{t('settings.capability.outputLength')}</Text>
                    <TextField
                      value={capabilityDraft.maxOutput}
                      onChangeText={value => setCapabilityDraft(current => ({
                        ...current,
                        maxOutput: String(value || '').replace(/[^0-9]/g, ''),
                      }))}
                      keyboardType="number-pad"
                      placeholder={t('settings.capability.outputLengthPlaceholder')}
                    />
                  </View>
                  <FieldHint style={styles.paramHint}>
                    {t('settings.capability.advancedHint')}
                  </FieldHint>
                </View>
              </>
            ) : (
              <FieldHint style={styles.hint}>
                {t('settings.capability.customParamsOff')}
              </FieldHint>
            )}
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                onPress={() => setCapabilityOpen(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.selectButton}
                onPress={confirmCapability}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>{t('settings.capability.confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <DisclaimerModal
        visible={disclaimerOpen}
        title={t('settings.about.disclaimer')}
        onClose={() => setDisclaimerOpen(false)}
      />

      <TutorialModal
        visible={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
      />

      <DiagnosticsModal
        visible={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
      />
      <BackupPanel
        visible={backupOpen}
        onClose={() => setBackupOpen(false)}
        onImported={async () => {
          await refreshAppData();
          await reloadAppearance();
        }}
      />
      <LocalModelPanel
        visible={localModelOpen}
        onClose={() => setLocalModelOpen(false)}
      />
      <WorkspaceChat
        visible={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
        onOpenPanel={section => {
          setWorkspacePanelSection(String(section || ''));
          setWorkspacePanelOpen(true);
        }}
      />
      <WorkspacePanel
        visible={workspacePanelOpen}
        onClose={() => setWorkspacePanelOpen(false)}
        characterId={characterId}
        initialSection={workspacePanelSection}
      />

      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title={t('settings.tutorial.title')}
      />
    </KeyboardAvoidingView>
  );
}
