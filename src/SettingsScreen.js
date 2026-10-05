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
  capabilitiesForModel,
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
  FieldLabel,
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
import { runOAuthWebFlow } from './mcp/oauth.js';
import { captureOAuthCallback, GITHUB_OAUTH_REDIRECT, openSystemBrowser } from './mcp/oauthBridge.js';
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
  });
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
  // GitHub MCP 连接：设置、PAT 输入与忙碌态（网页认证/PAT 都走 connectGithubMcpWithToken）。
  const [githubMcp, setGithubMcp] = useState(null);
  const [githubPat, setGithubPat] = useState('');
  const [githubBusy, setGithubBusy] = useState(false);
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
      Alert.alert('保存失败', '请检查存储空间或权限。');
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
      Alert.alert('保存失败', '请检查存储空间或权限。');
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
      Alert.alert('保存失败', '请检查存储空间或权限。');
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
        Alert.alert('检测成功', result.modelFound === false
          ? `${result.message}\n（模型名可能不正确，但接口已连通）`
          : result.message);
      } else if (result.needsProbe) {
        Alert.alert('列表接口不可用', '该服务的模型列表接口无法访问，请在「扩展 → 生图」中试生成验证。');
      } else {
        Alert.alert('检测失败', result.error || '无法连接');
      }
    } catch (error) {
      Alert.alert('检测失败', (error && error.message) || '无法连接');
    } finally {
      setImageGenTesting('');
    }
  }, [imageGenTesting]);

  const toggleMoments = useCallback(async () => {
    const next = !momentsEnabled;
    setMomentsEnabled(next);
    try {
      await saveMomentsSettings({ enabled: next });
    } catch (error) {
      setMomentsEnabled(!next);
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, [momentsEnabled]);

  const updateChatOption = useCallback(async (key, value) => {
    const next = { ...chatOptionsRef.current, [key]: value };
    chatOptionsRef.current = next;
    setChatOptions(next);
    try {
      await saveChatOptions(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
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
      Alert.alert('保存失败', '请检查存储空间或权限。');
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

  const connectGithubWeb = useCallback(async () => {
    if (githubBusy) return;
    setGithubBusy(true);
    try {
      const tokens = await runOAuthWebFlow({
        serverUrl: (githubMcp && githubMcp.endpoint) || undefined,
        redirectUri: GITHUB_OAUTH_REDIRECT,
        fetchImpl: (url, options) => fetch(url, options),
        openBrowser: openSystemBrowser,
        awaitCallback: () => captureOAuthCallback(),
      });
      const summary = await connectGithubMcpWithToken({
        token: tokens.accessToken,
        authMethod: 'oauth',
      });
      githubMcpSummaryRef.current = summary;
      await afterGithubConnect();
    } catch (error) {
      Alert.alert(t('settings.github.err.title'), githubAlertText(error, t));
    } finally {
      setGithubBusy(false);
    }
  }, [afterGithubConnect, githubBusy, githubMcp, t]);

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
      Alert.alert('保存失败', '请检查存储空间或权限。');
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
        .catch(() => Alert.alert('保存失败', '请检查存储空间或权限。'));
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
              .catch(() => Alert.alert('保存失败', '请检查存储空间或权限。'));
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
        if (apiMountedRef.current) Alert.alert('读取配置失败', '请重新打开应用后重试。');
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
      if (apiMountedRef.current) Alert.alert('保存失败', '请检查存储空间或权限。');
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
      '有未保存的修改',
      '当前配置的改动还没有保存。要放弃这些修改并切换吗？',
      [
        { text: '继续编辑', style: 'cancel', onPress: () => resolve(false) },
        {
          text: '放弃并切换',
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
      Alert.alert('无法打开链接', url);
    });
  };

  const deleteConfig = () => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    const target = current.configs.find(item => item.id === current.activeId);
    if (!target || current.configs.length <= 1) {
      Alert.alert('无法删除', '至少保留一套 API 配置。');
      return;
    }
    Alert.alert('删除配置', `确定删除“${target.name}”吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
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
      if (apiMountedRef.current) Alert.alert('已保存', 'API 配置已保存到本机。');
    } catch (error) {
      if (apiMountedRef.current) Alert.alert('保存失败', '请检查存储空间或权限。');
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
      Alert.alert('模型不能为空', '请至少添加一个模型。');
      return;
    }
     const trimmedBaseUrl = String(selected.baseUrl || '').trim();
     if (!trimmedBaseUrl) {
       Alert.alert('地址不能为空', '请填写 API 地址。');
       return;
     }
     if (!/^https?:\/\//i.test(trimmedBaseUrl)) {
       Alert.alert('地址格式无效', 'API 地址必须以 http:// 或 https:// 开头。');
       return;
     }
     if (/^http:\/\//i.test(trimmedBaseUrl)) {

      const confirmed = await new Promise(resolve => {
        Alert.alert(
          '当前使用 HTTP',
          '该地址不是 HTTPS，API Key 会以明文传输，存在被窃听的风险。仍要保存吗？',
          [
            { text: '取消', style: 'cancel', onPress: () => resolve(false) },
            { text: '仍然保存', style: 'destructive', onPress: () => resolve(true) }
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
    });
    updateField({
      modelCapabilities: { ...(selected.modelCapabilities || {}), [name]: entry },
    });
    setCapabilityEditorModel('');
  };

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
          onTimeoutError: () => new Error('超时'),
          onAbortError: () => new Error('检测已取消'),
          onAbortEventError: () => new Error('检测已取消'),
          onCancelError: () => new Error('检测已取消'),
          onNetworkError: () => new Error('网络错误'),
          onHttpError: () => new Error('请求失败'),
          parse: xhr => xhr.responseText,
          onParseError: () => new Error('请求失败'),
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
      Alert.alert('请先填写 API 地址和 Key');
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
      Alert.alert('未检测到模型', '无法获取模型列表，请检查 API 地址和 Key。');
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
      Alert.alert('未检测到模型', '无法获取模型列表，请检查 API 地址和 Key。');
      return;
    }
    const matched = query ? all.filter(model => model.toLowerCase().includes(query)) : all;
    if (matched.length === 0) {
      Alert.alert('未找到匹配的模型', `接口返回的模型里没有匹配「${modelDraft.trim()}」的项。`);
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
    const caps = capabilitiesForModel(selected, name);
    setCapabilityDraft({
      supportsThinking: caps.supportsThinking,
      supportsVision: caps.supportsVision,
      supportsVideo: caps.supportsVideo,
      supportsAudio: caps.supportsAudio,
      thinkingField: caps.thinkingField,
      thinkingFormat: caps.thinkingFormat,
      contextWindow: caps.contextWindow > 0 ? String(caps.contextWindow) : '',
    });
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
      Alert.alert('至少保留一个模型', '模型列表不能为空。');
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
      Alert.alert('无法打开', '请手动访问 GitHub：https://github.com/pppxxxy/easychat2')
    );
  };

  const checkUpdate = () => {
    Linking.openURL('https://github.com/pppxxxy/easychat2/releases').catch(() =>
      Alert.alert('无法打开', '请手动访问 GitHub Releases 页面检查更新。')
    );
  };

  // ---- 折叠头摘要行：收起时一眼看到关键状态 ----
  const apiSummary = active
    ? [String(active.name || '').trim() || '未命名配置', String(active.activeModel || '').trim()]
      .filter(Boolean).join(' · ')
    : '未配置';
  const personaSummary = String(userName || '').trim() || '未填写';
  const appearanceSummary = [
    (themes.find(item => item.id === themeId) || {}).label || '',
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
  const experienceSummary = `${experienceEnabledCount} 项已开启`;
  const inlineImageSummary = inlineImage.enabled
    ? `已开启${activeImageProvider ? ` · ${activeImageProvider.label}` : ''}`
    : '未开启';
  const vectorSummary = vectorPayload.enabled === true ? '已开启' : '未开启';
  const githubSummary = githubMcp && githubMcp.enabled && githubMcp.connectedAt > 0 ? '已连接' : '未连接';
  const workspaceSummary = workspaceMode === 'write' ? '读写模式' : (workspaceMode === 'read' ? '只读模式' : '询问模式');
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
    connectGithubPat,
    connectGithubWeb,
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
            <Text style={styles.title}>设置</Text>
            <TouchableOpacity
              style={[styles.searchToggle, searchOpen && styles.searchToggleActive]}
              onPress={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              activeOpacity={0.8}
              accessibilityLabel={searchOpen ? '关闭设置搜索' : '搜索设置项'}
            >
              <Ionicons name={searchOpen ? 'close' : 'search'} size={18} color={theme.colors.primarySoft} />
            </TouchableOpacity>
          </View>
          <FieldHint style={styles.hint}>配置 API、用户人设与全局对话预设。</FieldHint>
          {searchOpen ? (
            <View style={styles.searchBox}>
              <TextField
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="搜索设置项，例如：流式 / 温度 / 备份"
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
                  <Text style={styles.searchEmpty}>没有找到匹配的设置项。</Text>
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
            title="API 配置"
            icon="key-outline"
            open={isSectionOpen('api')}
            onToggle={next => toggleSection('api', next)}
            right={(
              <View style={styles.summaryRow}>
                <Text style={styles.collapseSummary} numberOfLines={1}>{apiSummary}</Text>
                <TopicButton
                  style={styles.topicButtonSpaced}
                  onPress={() => setTopic('chat-api')}
                  accessibilityLabel="查看 API 配置教学"
                />
                <TouchableOpacity
                  style={[styles.pillButton, (!loaded || apiSaving) && styles.buttonDisabled]}
                  onPress={addConfig}
                  disabled={!loaded || apiSaving}
                  activeOpacity={0.8}
                >
                  <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.pillButtonText}>新建</Text>
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
            title="用户人设"
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
                  accessibilityLabel="查看用户人设教学"
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
            title="外观与语言"
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
            title="对话体验"
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
            title="功能扩展"
            icon="extension-puzzle-outline"
            open={isSectionOpen('extensions')}
            onToggle={next => toggleSection('extensions', next)}
            right={(
              <View style={styles.summaryRow}>
                <Text style={styles.collapseSummary} numberOfLines={1}>{inlineImageSummary}</Text>
                <TopicButton
                  onPress={() => setTopic('inline-image')}
                  accessibilityLabel="查看对话配图教学"
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
            title="向量记忆"
            icon="git-network-outline"
            open={isSectionOpen('vector')}
            onToggle={next => toggleSection('vector', next)}
            right={(
              <View style={styles.summaryRow}>
                <Text style={styles.collapseSummary} numberOfLines={1}>{vectorSummary}</Text>
                <TopicButton
                  onPress={() => setTopic('vector-api')}
                  accessibilityLabel="查看向量记忆教学"
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
            title="关于"
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
            <Text style={styles.modalTitle}>选择厂商 / 协议</Text>
            <FieldHint style={styles.hint}>选中后会自动填好地址与鉴权，只需再补 API Key。</FieldHint>
            <ScrollView style={styles.vendorList} keyboardShouldPersistTaps="handled">
              <Text style={styles.vendorSectionLabel}>推荐平台（官方直连）</Text>
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
                      {vendor.category.map(item => (item === 'image' ? '生图' : '对话')).join(' / ')}
                    </Text>
                  </View>
                  <Text style={styles.vendorBaseUrl}>{vendor.baseUrl || '地址由控制台提供'}</Text>
                  <Text style={styles.vendorNote}>{vendor.note}</Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.vendorSectionLabel}>协议</Text>
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
                      <Text style={styles.vendorCategory}>暂未开放</Text>
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
            <Text style={styles.modalTitle}>可用模型</Text>
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
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>确认模型能力</Text>
            <FieldHint style={styles.hint}>
              {capabilityEditorModel ? `模型：${capabilityEditorModel}。` : ''}
              每个模型单独一套：决定聊天页是否开放「思考」、图片/视频上传与语音识别。
              确认后还需点表单里的「保存配置」才会写入本机。
            </FieldHint>
            <View style={styles.capabilityRow}>
              <Text style={styles.capabilityLabel}>支持思考（推理模型）</Text>
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
            {capabilityDraft.supportsThinking ? (
              <>
                <FieldLabel style={styles.label}>思考参数字段名</FieldLabel>
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
              </>
            ) : null}
            <View style={styles.capabilityRow}>
              <Text style={styles.capabilityLabel}>支持识图（多模态模型）</Text>
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
              <Text style={styles.capabilityLabel}>支持视频（聊天视频附件 / 悬浮窗帧序列观屏）</Text>
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
              <Text style={styles.capabilityLabel}>支持语音识别（音频兜底发送）</Text>
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
            <FieldLabel style={styles.label}>上下文窗口（tokens）</FieldLabel>
            <TextField
              value={capabilityDraft.contextWindow}
              onChangeText={value => setCapabilityDraft(current => ({
                ...current,
                contextWindow: String(value || '').replace(/[^0-9]/g, ''),
              }))}
              keyboardType="number-pad"
              placeholder="如 128000；留空 = 默认 32000"
            />
            <FieldHint style={styles.hint}>用于工作区面板的上下文占用显示与 80% 自动压缩；不确定可留空。</FieldHint>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                onPress={() => setCapabilityOpen(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.selectButton}
                onPress={confirmCapability}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>确认保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <DisclaimerModal
        visible={disclaimerOpen}
        title="免责条款"
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
      <WorkspacePanel
        visible={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
        characterId={characterId}
      />

      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title="教学"
      />
    </KeyboardAvoidingView>
  );
}
