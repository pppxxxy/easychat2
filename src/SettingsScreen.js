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
import { hexToRgba } from './theme/themes.js';
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
  updateLocationSettings,
  THINKING_DISPLAYS,
} from './storage.js';
import { IMAGE_PROVIDERS } from './imageGen/providers.js';
import { BUBBLE_STYLES } from './theme/themes.js';
import { detectImageProvider } from './imageGen/index.js';
import { pickWorkspaceFolder } from './workspace/picker.js';
import { WORKSPACE_ROOT_KINDS } from './workspace/location.js';
import { isShellAvailable } from './workspace/shell.js';
import { API_PROTOCOL_PRESETS, CHAT_API_VENDORS, getChatApiVendor } from './network/apiVendors.js';
import {
  Card,
  DangerButton,
  FieldHint,
  FieldLabel,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  TextField,
  TopicButton,
  CollapsibleSection,
  CollapsibleSelect,
} from './ui/index.js';
import ChapterModal from './books/ChapterModal.js';
import TutorialModal from './TutorialModal.js';
import DiagnosticsModal from './DiagnosticsModal.js';
import BackupPanel from './BackupPanel.js';
import LocalModelPanel from './LocalModelPanel.js';
import WorkspacePanel from './WorkspacePanel.js';
import WorkspaceChat from './workspace/WorkspaceChat.js';
import WorkspaceCapabilitiesCard from './WorkspaceCapabilitiesCard.js';
import { runOAuthWebFlow } from './mcp/oauth.js';
import { captureOAuthCallback, GITHUB_OAUTH_REDIRECT, openSystemBrowser } from './mcp/oauthBridge.js';
import useVectorSettings from './settings/useVectorSettings.js';
import useUserProfile from './settings/useUserProfile.js';
import SamplingCard from './settings/SamplingCard.js';
import { createSettingsStyles } from './settings/settingsStyles.js';

const INLINE_IMAGE_POSITION_OPTIONS = [
  { value: 'start', label: '开头', meta: '取回复首段' },
  { value: 'middle', label: '高潮（正中）', meta: '取回复中段' },
  { value: 'end', label: '结尾（默认）', meta: '取回复末段' },
];

const WORKSPACE_MODE_OPTIONS = [
  { id: 'ask', labelKey: 'settings.workspace.mode.ask', hintKey: 'settings.workspace.hint.ask' },
  { id: 'read', labelKey: 'settings.workspace.mode.read', hintKey: 'settings.workspace.hint.read' },
  { id: 'write', labelKey: 'settings.workspace.mode.write', hintKey: 'settings.workspace.hint.write' },
];

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

// 密钥输入的显隐切换：填 Key 时核对内容是高频动作，secureTextEntry 一锁到底只能盲填。
function SecretTextField({ value, onChangeText, placeholder, onEndEditing, theme, styles }) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.secretRow}>
      <TextField
        value={value}
        onChangeText={onChangeText}
        onEndEditing={onEndEditing}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={!visible}
        style={styles.secretInput}
      />
      <TouchableOpacity
        style={styles.secretToggle}
        onPress={() => setVisible(next => !next)}
        activeOpacity={0.7}
        accessibilityLabel={visible ? '隐藏密钥' : '显示密钥'}
      >
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={17} color={theme.colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
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
  // GitHub MCP 连接：设置、PAT 输入与忙碌态（网页认证/PAT 都走 connectGithubMcpWithToken）。
  const [githubMcp, setGithubMcp] = useState(null);
  const [githubPat, setGithubPat] = useState('');
  const [githubBusy, setGithubBusy] = useState(false);
  const { theme, fonts, tokens, themes, themeId, setThemeId, fontScales, fontScaleId, setFontScaleId, reloadAppearance } = useTheme();
  const { t, localeId, setLocaleId, locales } = useTranslation();
  const { refreshAppData, character } = useApp();

  const styles = useMemo(() => createSettingsStyles(theme, fonts, tokens), [theme, fonts, tokens]);

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

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.pageHeader}>
          <Text style={styles.title}>设置</Text>
          <FieldHint style={styles.hint}>配置 API、用户人设与全局对话预设。</FieldHint>
        </View>

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="key-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>API 配置</Text>
            </View>
            <View style={styles.headerActions}>
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
          </View>
          <CollapsibleSelect
            label="当前配置"
            value={activeId}
            options={configs.map(item => ({
              value: item.id,
              label: item.name || '未命名配置',
              meta: `${item.baseUrl || '未填写地址'} · ${item.activeModel || '未填写模型'}`,
            }))}
            onSelect={id => selectConfig(id)}
            placeholder="未选择配置"
            emptyHint="暂无配置，点右上角「新建」"
            style={styles.configSelect}
          />

          {active ? (
            <>
              <FieldLabel style={styles.label}>配置名称</FieldLabel>
              <TextField
                value={active.name}
                onChangeText={name => updateField({ name })}
                placeholder="例如：DeepSeek 主力"
              />
              <FieldLabel style={styles.label}>API 地址</FieldLabel>
              <TextField
                value={active.baseUrl}
                onChangeText={baseUrl => updateField({ baseUrl })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://api.deepseek.com"
              />
              <FieldHint style={styles.hint}>可填根地址，或带 /v1、/v1/chat/completions 的完整地址。</FieldHint>
              <FieldLabel style={styles.label}>接口协议</FieldLabel>
              <View style={styles.thinkingFormatRow}>
                {CHAT_PROTOCOL_OPTIONS.map(option => {
                  const isActive = (active.protocol || 'openai') === option.id;
                  return (
                    <TouchableOpacity
                      key={option.id}
                      style={[styles.formatChip, isActive && styles.formatChipActive]}
                      onPress={() => changeProtocol(option.id)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.formatChipText, isActive && styles.formatChipTextActive]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <FieldHint style={styles.hint}>
                {(active.protocol || 'openai') === 'anthropic'
                  ? 'Anthropic Messages 协议：端点 /v1/messages，鉴权 x-api-key；不支持内联音频。'
                  : (active.protocol === 'openai-responses'
                    ? 'OpenAI Responses 协议：端点 /v1/responses，事件式流式。'
                    : 'OpenAI 兼容协议：端点 /v1/chat/completions，最通用。')}
              </FieldHint>
              <FieldLabel style={styles.label}>模型列表</FieldLabel>
              <View style={styles.modelRow}>
                <TextField
                  style={styles.modelInput}
                  value={modelDraft}
                  onChangeText={setModelDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="输入模型名后点击添加"
                  onSubmitEditing={addModel}
                />
                <TouchableOpacity
                  style={styles.detectButton}
                  onPress={addModel}
                  activeOpacity={0.8}
                >
                  <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.detectButtonText}>添加</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.detectButton, styles.modelSearchButton, detectingModels && styles.buttonDisabled]}
                  onPress={searchModels}
                  disabled={detectingModels}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="按输入内容搜索接口上的模型"
                >
                  <Ionicons name="search" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.detectButtonText}>搜索</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.modelChips}>
                {(active.models || []).map(model => {
                  const isActive = active.activeModel === model;
                  return (
                    <View
                      key={model}
                      style={[styles.modelChip, isActive && styles.modelChipActive]}
                    >
                      <TouchableOpacity
                        style={styles.modelChipMain}
                        onPress={() => selectActiveModel(model)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[styles.modelChipText, isActive && styles.modelChipTextActive]}
                          numberOfLines={1}
                        >
                          {model}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => openCapabilityEditor(model)}
                        hitSlop={6}
                        accessibilityLabel={`配置模型 ${model} 的能力`}
                        style={styles.modelChipCaps}
                      >
                        <Ionicons
                          name="options-outline"
                          size={13}
                          color={(active.modelCapabilities && active.modelCapabilities[model])
                            ? theme.colors.primarySoft
                            : theme.colors.textFaint}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removeModel(model)} hitSlop={6}>
                        <Ionicons name="close" size={14} color={theme.colors.textFaint} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
              <FieldHint style={styles.hint}>点击模型将其设为当前模型；点右侧滑杆图标可为每个模型单独确认能力（思考/识图/视频/语音识别）。</FieldHint>
              <TouchableOpacity
                style={[styles.detectButton, detectingModels && styles.buttonDisabled]}
                onPress={detectModels}
                disabled={detectingModels}
                activeOpacity={0.8}
              >
                <Ionicons name="pulse-outline" size={15} color={theme.colors.primarySoft} />
                <Text style={styles.detectButtonText}>
                  {detectingModels ? '检测中...' : '检测模型'}
                </Text>
              </TouchableOpacity>
              <FieldLabel style={styles.label}>API Key</FieldLabel>
              <SecretTextField
                value={active.apiKey}
                onChangeText={apiKey => updateField({ apiKey })}
                placeholder="sk-..."
                theme={theme}
                styles={styles}
              />
              {active.apiKeyUrl ? (
                <TouchableOpacity
                  style={styles.apiKeyLinkRow}
                  onPress={() => openApiKeyUrl(active.apiKeyUrl)}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                  accessibilityLabel="点击获取密钥"
                >
                  <Text style={styles.apiKeyLink}>点击获取密钥 →</Text>
                </TouchableOpacity>
              ) : null}
              {activeVendor && activeVendor.note ? (
                <Text style={styles.vendorEditorNote}>{activeVendor.note}</Text>
              ) : null}
              <FieldHint style={styles.hint}>
                API Key 与聊天内容会直接发送到你填写的地址，并保存在本机。请确认你信任该服务商。
              </FieldHint>
              <PrimaryButton
                title="保存配置"
                icon="save-outline"
                onPress={save}
                style={styles.actionBtn}
              />
              <DangerButton
                title="删除当前配置"
                icon="trash-outline"
                onPress={deleteConfig}
                disabled={configs.length <= 1}
                style={styles.actionBtn}
              />
            </>
          ) : null}
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="person-circle-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>用户人设</Text>
            </View>
            <TopicButton
              onPress={() => setTopic('user-persona')}
              accessibilityLabel="查看用户人设教学"
            />
          </View>
          <Text style={styles.fieldHint}>
            这里的信息会被注入到提示词中，角色的正则脚本可以通过 {"{{user}}"} 引用你的名字。头像为全部人设共用。
          </Text>
          <FieldLabel style={styles.label}>我的身份</FieldLabel>
          <CollapsibleSelect
            label="当前人设"
            value={activePersonaId}
            valueMeta={userPersona ? userPersona.slice(0, 40) : '未填写描述'}
            options={personas.map(item => ({
              value: item.id,
              label: String(item.userName || '').trim() || '未命名人设',
              meta: String(item.persona || '').trim().slice(0, 40) || '未填写描述',
            }))}
            onSelect={id => selectPersona(id)}
            placeholder="未选择人设"
          />
          <View style={styles.personaActions}>
            <TouchableOpacity style={styles.personaAddChip} onPress={addPersona} activeOpacity={0.8}>
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.personaAddText}>新增人设</Text>
            </TouchableOpacity>
            {personas.length > 1 ? (
              <TouchableOpacity
                style={styles.personaAddChip}
                onPress={() => removePersona(activePersonaId)}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
                <Text style={[styles.personaAddText, { color: theme.colors.danger }]}>删除当前</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.avatarRow}>
            <View style={styles.avatarBox}>
              {userAvatarUri ? (
                <Image source={{ uri: userAvatarUri }} style={styles.avatarImg} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarPlaceholderText}>
                    {userName ? userName.charAt(0) : '我'}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.imageActions}>
              <TouchableOpacity style={styles.smallButton} onPress={pickUserAvatar} activeOpacity={0.8}>
                <Text style={styles.smallButtonText}>{userAvatarUri ? '更换头像' : '选择头像'}</Text>
              </TouchableOpacity>
              {userAvatarUri ? (
                <TouchableOpacity onPress={() => changeUserAvatar('')} hitSlop={8}>
                  <Text style={styles.removeText}>清除</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
          <FieldLabel style={styles.label}>人设名称（当前人设）</FieldLabel>
          <TextField
            value={userName}
            onChangeText={text => {
              setUserName(text);
              setPersonas(list => list.map(item => (
                item.id === activePersonaId ? { ...item, userName: text } : item
              )));
              saveUserProfileDelayed(text, userPersona, userAvatarUri);
            }}
            placeholder="例如：小明"
          />
          <FieldLabel style={styles.label}>人设描述</FieldLabel>
          <TextField
            style={styles.multilineInput}
            value={userPersona}
            onChangeText={text => { setUserPersona(text); saveUserProfileDelayed(userName, text, userAvatarUri); }}
            placeholder="描述你自己的性格、背景、喜好等"
            multiline
            textAlignVertical="top"
          />
          <SecondaryButton
            title="保存用户人设"
            icon="save-outline"
            onPress={saveUserProfileNow}
            style={styles.actionBtn}
          />
          {userProfileSaved ? <Text style={styles.savedHint}>已自动保存</Text> : null}
        </Card>

        <Card>
          <CollapsibleSection
            title="外观"
            icon="color-palette-outline"
            right={<Text style={styles.collapseSummary}>{`${(themes.find(t => t.id === themeId) || {}).label || ''}`}</Text>}
          >
            <View style={styles.appearanceRow}>
              {themes.map(item => {
                const active = item.id === themeId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.themeChip, active && {
                      borderColor: item.colors.primary,
                      backgroundColor: hexToRgba(item.colors.primary, 0.08),
                    }]}
                    onPress={() => setThemeId(item.id)}
                    activeOpacity={0.85}
                    accessibilityLabel={`切换到${item.label}主题`}
                  >
                    <View style={[styles.themeSwatch, { backgroundColor: item.colors.background }]}>
                      <View style={[styles.themeSwatchDot, { backgroundColor: item.colors.primary }]} />
                    </View>
                    <Text style={[styles.themeChipText, active && { color: item.colors.primary, fontWeight: '800' }]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FieldLabel style={styles.label}>字体大小</FieldLabel>
            <View style={styles.fontRow}>
              {fontScales.map(item => {
                const active = item.id === fontScaleId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.fontChip, active && styles.fontChipActive]}
                    onPress={() => setFontScaleId(item.id)}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FieldLabel style={styles.label}>{t('settings.appearance.language')}</FieldLabel>
            <View style={styles.fontRow}>
              {locales.map(item => {
                const active = item.id === localeId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.fontChip, active && styles.fontChipActive]}
                    onPress={() => setLocaleId(item.id)}
                    activeOpacity={0.85}
                    accessibilityLabel={item.english}
                  >
                    {/* 语言名用各自的写法展示：英文界面下「简体中文」仍显示为中文，
                        用户不必先读懂当前界面语言才能找到自己的语言。 */}
                    <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </CollapsibleSection>
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="briefcase-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('settings.workspace.title')}</Text>
            </View>
          </View>
          <FieldLabel style={styles.label}>{t('settings.workspace.mode')}</FieldLabel>
          <View style={styles.fontRow}>
            {WORKSPACE_MODE_OPTIONS.map(option => {
              const active = option.id === workspaceMode;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[styles.fontChip, active && styles.fontChipActive]}
                  onPress={() => updateWorkspaceMode(option.id)}
                  activeOpacity={0.85}
                  accessibilityLabel={t(option.labelKey)}
                >
                  <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                    {t(option.labelKey)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <FieldHint style={styles.hint}>
            {t((WORKSPACE_MODE_OPTIONS.find(option => option.id === workspaceMode) || WORKSPACE_MODE_OPTIONS[0]).hintKey)}
          </FieldHint>

          <FieldLabel style={styles.label}>{t('settings.workspace.folder')}</FieldLabel>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons
                name={workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF ? 'folder-outline' : 'phone-portrait-outline'}
                size={17}
                color={theme.colors.primaryMuted}
              />
              <Text style={styles.linkText} numberOfLines={1}>
                {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF
                  ? (workspaceFolder.name || t('settings.workspace.folder.custom'))
                  : t('settings.workspace.folder.app')}
              </Text>
            </View>
            {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF ? (
              <GhostButton title={t('settings.workspace.folder.reset')} small onPress={resetWorkspaceFolder} />
            ) : null}
          </View>
          <FieldHint style={styles.hint}>
            {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF
              ? t('settings.workspace.folder.hintExternal', { name: workspaceFolder.name || t('settings.workspace.folder.custom') })
              : t('settings.workspace.folder.hintApp')}
          </FieldHint>
          <SecondaryButton
            title={workspaceFolderBusy ? t('settings.workspace.folder.picking') : t('settings.workspace.folder.pick')}
            small
            disabled={workspaceFolderBusy}
            style={{ alignSelf: 'flex-start', marginTop: 8 }}
            onPress={chooseWorkspaceFolder}
          />

          <View style={[styles.capabilityRow, { marginTop: 16 }]}>
            <View style={styles.linkLeft}>
              <Ionicons name="terminal-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.workspace.shell')}</Text>
            </View>
            <Switch
              value={commandExecution}
              disabled={workspaceMode !== 'write' || workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF}
              onValueChange={toggleCommandExecution}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldHint style={styles.hint}>
            {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF
              ? t('settings.workspace.shell.hintExternal')
              : (workspaceMode === 'write'
                ? t('settings.workspace.shell.hint')
                : t('settings.workspace.shell.hintReadonly'))}
          </FieldHint>

          <SecondaryButton
            title={t('settings.workspace.open')}
            small
            style={{ alignSelf: 'flex-start', marginTop: 12 }}
            onPress={() => setWorkspaceOpen(true)}
          />

          <WorkspaceCapabilitiesCard
            settings={{
              mode: workspaceMode,
              location: workspaceFolder,
              allowCommandExecution: commandExecution,
            }}
            shellAvailable={isShellAvailable()}
          />
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="logo-github" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('settings.github.title')}</Text>
            </View>
          </View>
          <FieldHint style={styles.hint}>{t('settings.github.subtitle')}</FieldHint>
          {githubMcp && githubMcp.enabled && githubMcp.connectedAt > 0 ? (
            <>
              <View style={styles.capabilityRow}>
                <View style={styles.linkLeft}>
                  <Ionicons name="checkmark-circle-outline" size={17} color={theme.colors.primary} />
                  <Text style={styles.linkText}>
                    {t('settings.github.connected', {
                      login: githubMcp.accountLogin || t('settings.github.connected.anonymous'),
                      count: githubMcp.toolCatalog.length,
                    })}
                  </Text>
                </View>
              </View>
              <FieldHint style={styles.hint}>{t('settings.github.riskHint')}</FieldHint>
              <View style={styles.formActions}>
                <GhostButton title={t('settings.github.disconnect.action')} small onPress={disconnectGithub} />
              </View>
            </>
          ) : (
            <>
              <FieldLabel style={styles.label}>{t('settings.github.pat.label')}</FieldLabel>
              <SecretTextField
                value={githubPat}
                onChangeText={setGithubPat}
                placeholder={t('settings.github.pat.placeholder')}
                theme={theme}
                styles={styles}
              />
              <FieldHint style={styles.hint}>{t('settings.github.pat.hint')}</FieldHint>
              <View style={styles.formActions}>
                <GhostButton
                  title={githubBusy ? t('settings.github.busy') : t('settings.github.pat.action')}
                  small
                  onPress={connectGithubPat}
                />
                <SecondaryButton
                  title={t('settings.github.web.action')}
                  small
                  onPress={connectGithubWeb}
                />
              </View>
              <FieldHint style={styles.hint}>{t('settings.github.web.hint')}</FieldHint>
              <FieldHint style={styles.hint}>{t('settings.github.riskHint')}</FieldHint>
            </>
          )}
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="image-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>对话配图</Text>
            </View>
            <TopicButton
              onPress={() => setTopic('inline-image')}
              accessibilityLabel="查看对话配图教学"
            />
          </View>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="sparkles-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>自动配图</Text>
            </View>
            <Switch
              value={inlineImage.enabled}
              onValueChange={value => updateInlineImage({ enabled: value })}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldLabel style={styles.label}>生图服务</FieldLabel>
          <CollapsibleSelect
            label="当前服务"
            value={inlineImage.providerId}
            options={IMAGE_PROVIDERS.map(provider => ({
              value: provider.id,
              label: provider.label,
              meta: inlineImageProviders.includes(provider.id)
                ? `已配置 · ${String((imageGenProviders[provider.id] || {}).model || provider.defaultModel || '').split(/[\n,]/)[0] || '默认模型'}`
                : '未配置密钥',
            }))}
            onSelect={id => updateInlineImage({ providerId: id })}
            placeholder="未选择服务"
          />
          {activeImageProvider ? (
            <View style={styles.providerEditor}>
              <Text style={styles.providerEditorTitle}>{activeImageProvider.label} 配置</Text>
              {activeImageProvider.keyHint ? (
                <FieldHint style={styles.hint}>密钥：{activeImageProvider.keyHint}</FieldHint>
              ) : null}
              <FieldLabel style={styles.label}>API 地址</FieldLabel>
              <TextField
                value={String((imageGenProviders[activeImageProvider.id] || {}).baseUrl || '')}
                onChangeText={text => updateImageGenProvider(activeImageProvider.id, { baseUrl: text })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={activeImageProvider.baseUrlPlaceholder || activeImageProvider.baseUrl || 'https://example.com/v1/images/generations'}
              />
              <FieldLabel style={styles.label}>API Key</FieldLabel>
              <SecretTextField
                value={String((imageGenProviders[activeImageProvider.id] || {}).apiKey || '')}
                onChangeText={text => updateImageGenProvider(activeImageProvider.id, { apiKey: text })}
                placeholder="sk-..."
                theme={theme}
                styles={styles}
              />
              {activeImageProvider.apiKeyUrl ? (
                <TouchableOpacity
                  style={styles.apiKeyLinkRow}
                  onPress={() => openApiKeyUrl(activeImageProvider.apiKeyUrl)}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                >
                  <Text style={styles.apiKeyLink}>点击获取密钥 →</Text>
                </TouchableOpacity>
              ) : null}
              <FieldLabel style={styles.label}>模型名（可用逗号或换行分隔多个）</FieldLabel>
              <TextField
                value={String((imageGenProviders[activeImageProvider.id] || {}).model || '')}
                onChangeText={text => updateImageGenProvider(activeImageProvider.id, { model: text })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={activeImageProvider.defaultModel || '模型名'}
              />
              <TouchableOpacity
                style={[styles.detectButton, imageGenTesting === activeImageProvider.id && styles.buttonDisabled]}
                onPress={() => testImageGenProvider(activeImageProvider)}
                disabled={imageGenTesting === activeImageProvider.id}
                activeOpacity={0.8}
              >
                <Ionicons name="pulse-outline" size={15} color={theme.colors.primarySoft} />
                <Text style={styles.detectButtonText}>
                  {imageGenTesting === activeImageProvider.id ? '检测中...' : '检测连通性'}
                </Text>
              </TouchableOpacity>
              {activeImageProvider.networkNote ? (
                <FieldHint style={styles.hint}>{activeImageProvider.networkNote}</FieldHint>
              ) : null}
            </View>
          ) : null}
          <FieldLabel style={styles.label}>配图位置</FieldLabel>
          <CollapsibleSelect
            label="取回复的哪一段"
            value={inlineImage.imagePosition}
            options={INLINE_IMAGE_POSITION_OPTIONS}
            onSelect={value => updateInlineImage({ imagePosition: value })}
            placeholder="结尾"
          />
          <FieldHint style={styles.hint}>
            自动配图会先请模型把该段对话转写成「角色说完这段话后所处的画面」再出图；开头 / 高潮（正中）/ 结尾指从本轮回复里取哪一段。
          </FieldHint>
          <FieldLabel style={styles.label}>风格前缀（可选）</FieldLabel>
          <TextField
            value={inlineImage.stylePrefix}
            onChangeText={text => updateInlineImage({ stylePrefix: text })}
            placeholder="例如：anime style, detailed"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>尺寸（宽*高）</FieldLabel>
          <TextField
            value={inlineImage.size}
            onChangeText={text => updateInlineImage({ size: text })}
            placeholder="832*1216"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>提示词长度上限（字符）</FieldLabel>
          <TextField
            value={String(inlineImage.maxPromptChars)}
            onChangeText={text => updateInlineImage({ maxPromptChars: text.replace(/[^0-9]/g, '') })}
            keyboardType="number-pad"
            placeholder="400"
          />
          <Text style={styles.fieldHint}>密钥仅保存在本机，与「扩展 → 生图」共用同一份配置。</Text>
        </Card>

        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="options-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>全局配置</Text>
          </View>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setPresetEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="list-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>全局预设 / 记忆总结</Text>
            </View>
            <View style={styles.linkRight}>
              <Text style={styles.linkValue}>
                {enabledPresetCount > 0 ? `文本预设 ${enabledPresetCount} 项` : '文本预设未开启'}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
            </View>
          </TouchableOpacity>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="pulse-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>流式输出</Text>
            </View>
            <Switch
              value={chatOptions.streaming}
              onValueChange={value => updateChatOption('streaming', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="resize-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>全宽对话</Text>
            </View>
            <Switch
              value={chatOptions.fullWidth}
              onValueChange={value => {
                // 开启前提醒：全宽气泡下部分角色卡的排版会引发横向滑动/滚动手势异常，
                // 用户确认后才落盘；关闭不需要确认。
                if (!value) {
                  updateChatOption('fullWidth', false);
                  return;
                }
                Alert.alert(
                  '开启全宽对话',
                  '全宽模式下部分角色卡可能出现屏幕滑动问题。',
                  [
                    { text: '取消', style: 'cancel' },
                    { text: '仍然开启', onPress: () => updateChatOption('fullWidth', true) },
                  ]
                );
              }}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="code-slash-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>富 HTML 渲染</Text>
            </View>
            <Switch
              value={chatOptions.richHtml !== false}
              onValueChange={value => updateChatOption('richHtml', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <Text style={styles.fieldHint}>{'开启后，含 <style>/<script> 的助手消息用 WebView 渲染，可还原角色卡的样式与交互；折叠状态栏始终保留 WebView 渲染。'}</Text>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="save-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>保留输入草稿</Text>
            </View>
            <Switch
              value={chatOptions.keepDraft === true}
              onValueChange={value => updateChatOption('keepDraft', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <Text style={styles.fieldHint}>开启后，退出或切换角色时会记住输入框里还没发出去的文字，下次回到这个对话自动填回；关闭则每次进入都清空。</Text>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="time-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>时间感知</Text>
            </View>
            <Switch
              value={chatOptions.timeAware === true}
              onValueChange={value => updateChatOption('timeAware', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <Text style={styles.fieldHint}>开启后，每次对话都会把「当前的日期与时间」告诉角色，让它知道现在是几点、星期几；关闭则角色不感知时间。默认关闭。</Text>
          {locationSettings && locationSettings.enabled === true ? (
            <>
              <View style={styles.capabilityRow}>
                <View style={styles.linkLeft}>
                  <Ionicons name="navigate-outline" size={17} color={theme.colors.primaryMuted} />
                  <Text style={styles.linkText}>{t('settings.location.awareness.title')}</Text>
                </View>
                <Switch
                  value={locationSettings.awareness === true}
                  onValueChange={toggleLocationAwareness}
                  trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                  thumbColor={theme.colors.primaryContrast}
                />
              </View>
              <Text style={styles.fieldHint}>{t('settings.location.awareness.hint')}</Text>
            </>
          ) : null}
          <View style={styles.thinkingDisplayRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="bulb-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>思考内容展示</Text>
            </View>
            <View style={styles.thinkingDisplayChips}>
              {THINKING_DISPLAYS.map(display => {
                const active = thinkingDisplay === display;
                const label = display === 'open' ? '开启' : display === 'fold' ? '折叠' : '关闭';
                return (
                  <TouchableOpacity
                    key={display}
                    style={[styles.formatChip, active && styles.formatChipActive]}
                    onPress={() => updateThinkingDisplay(display)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.formatChipText, active && styles.formatChipTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <View style={styles.thinkingDisplayRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="chatbubbles-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>气泡风格</Text>
            </View>
            <View style={styles.thinkingDisplayChips}>
              {BUBBLE_STYLES.map(style => {
                const active = (chatOptions.bubbleStyle || 'rounded') === style;
                const label = style === 'rounded' ? '圆润' : style === 'card' ? '卡片' : '无底纹';
                return (
                  <TouchableOpacity
                    key={style}
                    style={[styles.formatChip, active && styles.formatChipActive]}
                    onPress={() => updateChatOption('bubbleStyle', style)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.formatChipText, active && styles.formatChipTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <Text style={styles.fieldHint}>{'圆润：大圆角气泡（默认）；卡片：统一中等圆角、无尾角，偏阅读；无底纹：去掉气泡底色与阴影，仅靠左右对齐区分角色。'}</Text>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setPluginEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="extension-puzzle-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>联网搜索</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setTtsEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="volume-high-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>语音播报</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setTranscriptionEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="mic-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>语音转文字</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="planet-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>动态</Text>
            </View>
            <Switch
              value={momentsEnabled}
              onValueChange={toggleMoments}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
        </Card>

        <SamplingCard />

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="git-network-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>向量记忆</Text>
            </View>
            <TopicButton
              onPress={() => setTopic('vector-api')}
              accessibilityLabel="查看向量记忆教学"
            />
          </View>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Text style={styles.linkText}>启用向量检索</Text>
            </View>
            <Switch
              value={vectorPayload.enabled === true}
              onValueChange={toggleVectorEnabled}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldLabel style={styles.label}>向量配置</FieldLabel>
          <CollapsibleSelect
            label="当前配置"
            value={vectorPayload.activeId}
            options={(vectorPayload.configs || []).map(item => ({
              value: item.id,
              label: item.name || '未命名配置',
              meta: `${item.baseUrl || '未填写地址'} · ${item.model || '未填写模型'}`,
            }))}
            onSelect={id => selectVectorConfig(id)}
            placeholder="未选择配置"
          />
          <View style={styles.personaActions}>
            <TouchableOpacity style={styles.personaAddChip} onPress={addVectorConfig} activeOpacity={0.8}>
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.personaAddText}>新增配置</Text>
            </TouchableOpacity>
            {(vectorPayload.configs || []).length > 1 ? (
              <TouchableOpacity style={styles.personaAddChip} onPress={removeVectorConfig} activeOpacity={0.8}>
                <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
                <Text style={[styles.personaAddText, { color: theme.colors.danger }]}>删除当前</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {currentVectorConfig ? (
            <>
              <FieldLabel style={styles.label}>配置名称</FieldLabel>
              <TextField
                value={currentVectorConfig.name}
                onChangeText={text => updateVectorConfig({ name: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="例如：OpenAI Embeddings"
              />
              <FieldLabel style={styles.label}>接口地址</FieldLabel>
              <TextField
                value={currentVectorConfig.baseUrl}
                onChangeText={text => updateVectorConfig({ baseUrl: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="https://api.openai.com/v1"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <FieldLabel style={styles.label}>密钥</FieldLabel>
              <SecretTextField
                value={currentVectorConfig.apiKey}
                onChangeText={text => updateVectorConfig({ apiKey: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="sk-..."
                theme={theme}
                styles={styles}
              />
              <FieldLabel style={styles.label}>模型</FieldLabel>
              <TextField
                value={currentVectorConfig.model}
                onChangeText={text => updateVectorConfig({ model: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="text-embedding-3-small"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <FieldLabel style={styles.label}>召回条数（1 - 20）</FieldLabel>
              <TextField
                value={vectorTopKDraft}
                onChangeText={text => setVectorTopKDraft(text.replace(/[^0-9]/g, ''))}
                onEndEditing={event => {
                  updateVectorConfig({ topK: event.nativeEvent.text });
                  flushVectorMemory().then(() => {
                    const base = vectorRef.current;
                    const active = base && base.configs.find(item => item.id === base.activeId);
                    if (active) setVectorTopKDraft(String(active.topK));
                  });
                }}
                keyboardType="number-pad"
                placeholder="5"
              />
              <FieldLabel style={styles.label}>分片长度（字符，1 - 2000）</FieldLabel>
              <TextField
                value={vectorMaxCharsDraft}
                onChangeText={text => setVectorMaxCharsDraft(text.replace(/[^0-9]/g, ''))}
                onEndEditing={event => {
                  updateVectorConfig({ maxChars: event.nativeEvent.text });
                  flushVectorMemory().then(() => {
                    const base = vectorRef.current;
                    const active = base && base.configs.find(item => item.id === base.activeId);
                    if (active) setVectorMaxCharsDraft(String(active.maxChars));
                  });
                }}
                keyboardType="number-pad"
                placeholder="400"
              />
              <SecondaryButton
                title={vectorTesting ? '测试中...' : '测试连接'}
                icon="pulse-outline"
                onPress={testVector}
                loading={vectorTesting}
                style={styles.actionBtn}
              />
            </>
          ) : null}
          <Text style={styles.fieldHint}>
            未配置或请求失败时自动降级为本地关键词检索；密钥仅保存在本机。
          </Text>
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

        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="information-circle-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>关于</Text>
          </View>
          <View style={styles.linkRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="pricetag-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>当前版本</Text>
            </View>
            <Text style={styles.versionText}>{APP_VERSION || '未知'}</Text>
          </View>
          <TouchableOpacity style={styles.linkRow} onPress={openTutorial} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="book-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>使用教程</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openDisclaimer} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="document-text-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>免责条款</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openGitHub} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="logo-github" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>GitHub 地址</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={checkUpdate} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="refresh-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>检测更新</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setDiagnosticsOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="bug-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>诊断日志</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setBackupOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="archive-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>备份与恢复</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setLocalModelOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="hardware-chip-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>本地模型</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
        </Card>
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
        <View style={[styles.modalBackdrop, styles.capabilityBackdrop]}>
          <View style={[styles.modalSheet, styles.capabilitySheet]}>
            <Text style={styles.modalTitle}>确认模型能力</Text>
            <FieldHint style={styles.hint}>
              {capabilityEditorModel ? `模型：${capabilityEditorModel}。` : ''}
              每个模型单独一套：决定聊天页是否开放「思考」、图片/视频上传与语音识别。
              确认后还需点表单里的「保存配置」才会写入本机。
            </FieldHint>
            <ScrollView style={styles.capabilityScroll} contentContainerStyle={styles.capabilityScrollContent}>
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
            <View style={styles.capabilityRow}>
              <View style={styles.capabilityLabelBlock}>
                <Text style={styles.capabilityLabelStacked}>自定义参数（高级）</Text>
                <Text style={styles.capabilitySubLabel}>
                  默认关闭：思考字段名、上下文窗口与输出长度都按默认值发送
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
                        <Text style={styles.paramLabel}>思考参数</Text>
                        <Text style={styles.collapseValue} numberOfLines={1}>
                          {matchedThinkingPreset ? matchedThinkingPreset.name : '自定义'}
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
                    <Text style={styles.paramLabel}>上下文窗口（tokens）</Text>
                    <TextField
                      value={capabilityDraft.contextWindow}
                      onChangeText={value => setCapabilityDraft(current => ({
                        ...current,
                        contextWindow: String(value || '').replace(/[^0-9]/g, ''),
                      }))}
                      keyboardType="number-pad"
                      placeholder="留空 = 默认 200000"
                    />
                  </View>
                  <View style={[styles.paramField, styles.paramFieldLast]}>
                    <Text style={styles.paramLabel}>输出长度（tokens）</Text>
                    <TextField
                      value={capabilityDraft.maxOutput}
                      onChangeText={value => setCapabilityDraft(current => ({
                        ...current,
                        maxOutput: String(value || '').replace(/[^0-9]/g, ''),
                      }))}
                      keyboardType="number-pad"
                      placeholder="留空 = 默认 32000"
                    />
                  </View>
                  <FieldHint style={styles.paramHint}>
                    上下文窗口用于工作区面板的上下文占用显示与 80% 自动压缩；输出长度是单次回复的最大生成量。留空都按默认值发送。
                  </FieldHint>
                </View>
              </>
            ) : (
              <FieldHint style={styles.hint}>
                已关闭自定义参数：思考字段名与格式、上下文窗口、输出长度都按默认值发送（reasoning_effort + effort、窗口 200000、输出 32000）。
              </FieldHint>
            )}
            </ScrollView>
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
        title="教学"
      />
    </KeyboardAvoidingView>
  );
}
