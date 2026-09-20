import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import Ionicons from '@expo/vector-icons/Ionicons';

import { normalizeChatUrl } from './api';
import { useTheme } from './theme/ThemeContext';
import DisclaimerModal from './disclaimer';
import PluginPanel from './PluginPanel';
import PresetPanel from './PresetPanel';
import TtsPanel from './TtsPanel';
import {
  createApiConfig,
  getApiConfigs,
  getChatOptions,
  getGlobalPresetSettings,
  getGlobalPresets,
  getImageGenSettings,
  getInlineImageSettings,
  getMomentsSettings,
  saveMomentsSettings,
  getThinkingSettings,
  getSamplingSettings,
  getVectorMemoryConfig,
  getUserProfile,
  getPersonas,
  getActivePersonaId,
  createPersona,
  updatePersona,
  deletePersona,
  setActivePersonaId,
  saveApiConfigs,
  saveChatOptions,
  saveInlineImageSettings,
  saveSamplingSettings,
  saveThinkingSettings,
  saveUserProfile,
  saveVectorMemoryConfig,
  SAMPLING_FIELDS,
  THINKING_DISPLAYS,
} from './storage';
import { IMAGE_PROVIDERS } from './imageGen/providers';
import { API_PROTOCOL_PRESETS, CHAT_API_VENDORS, getChatApiVendor } from './apiVendors';
import { testVectorConnection } from './vectorMemory';
import {
  Card,
  DangerButton,
  FieldHint,
  FieldLabel,
  PrimaryButton,
  SecondaryButton,
  TextField,
  TopicButton,
} from './ui';
import ChapterModal from './ChapterModal';
import TutorialModal from './TutorialModal';

function getPickedAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

export default function SettingsScreen() {
  const [configs, setConfigs] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [userName, setUserName] = useState('');
  const [userPersona, setUserPersona] = useState('');
  const [nudgeDefault, setNudgeDefault] = useState('');
  const [userAvatarUri, setUserAvatarUri] = useState('');
  const [userProfileLoaded, setUserProfileLoaded] = useState(false);
  const [personas, setPersonas] = useState([]);
  const [activePersonaId, setActivePersonaIdState] = useState('');
  const [vectorMemory, setVectorMemory] = useState({
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'text-embedding-3-small',
    topK: 5,
    maxChars: 400,
    batchSize: 16,
  });
  const vectorMemoryRef = useRef(null);
  const [vectorTesting, setVectorTesting] = useState(false);
  const [vectorTopKDraft, setVectorTopKDraft] = useState('5');
  const [vectorMaxCharsDraft, setVectorMaxCharsDraft] = useState('400');
  const [detectingModels, setDetectingModels] = useState(false);
  const [modelList, setModelList] = useState([]);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState('');
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilityDraft, setCapabilityDraft] = useState({
    supportsThinking: false,
    supportsVision: false,
    thinkingField: 'reasoning_effort',
    thinkingFormat: 'effort',
  });
  const [userProfileSaved, setUserProfileSaved] = useState(false);
  const [presetEntryOpen, setPresetEntryOpen] = useState(false);
  const [pluginEntryOpen, setPluginEntryOpen] = useState(false);
  const [ttsEntryOpen, setTtsEntryOpen] = useState(false);
  const [momentsEnabled, setMomentsEnabled] = useState(false);
  const [topic, setTopic] = useState(null);
  const [enabledPresetCount, setEnabledPresetCount] = useState(0);
  const [chatOptions, setChatOptions] = useState({ streaming: true, fullWidth: false });
  const chatOptionsRef = useRef({ streaming: true, fullWidth: false });
  const [sampling, setSampling] = useState({
    maxTokens: { enabled: false, value: 8024 },
    temperature: { enabled: false, value: 1 },
    topP: { enabled: false, value: 1 },
    topK: { enabled: false, value: 0 },
  });
  const samplingRef = useRef({
    maxTokens: { enabled: false, value: 8024 },
    temperature: { enabled: false, value: 1 },
    topP: { enabled: false, value: 1 },
    topK: { enabled: false, value: 0 },
  });
  const [thinkingDisplay, setThinkingDisplay] = useState('fold');
  const [inlineImage, setInlineImage] = useState({
    enabled: false,
    providerId: '',
    stylePrefix: '',
    size: '832*1216',
    maxPromptChars: 400,
  });
  const [inlineImageProviders, setInlineImageProviders] = useState([]);
  const inlineImageRef = useRef({
    enabled: false,
    providerId: '',
    stylePrefix: '',
    size: '832*1216',
    maxPromptChars: 400,
  });
  const profileTimerRef = useRef(null);
  const profileHintTimerRef = useRef(null);
  const profileSavingRef = useRef(null);
  const profileMountedRef = useRef(true);
  const profileStateRef = useRef(null);
  profileStateRef.current = { userName, persona: userPersona, avatarUri: userAvatarUri, nudgeText: nudgeDefault };

  useEffect(() => {
    profileMountedRef.current = true;
    return () => {
      profileMountedRef.current = false;
      clearTimeout(profileTimerRef.current);
      clearTimeout(profileHintTimerRef.current);
    };
  }, []);
  const apiStateRef = useRef({ configs: [], activeId: '', loaded: false });
  const apiBusyRef = useRef(false);
  const apiMountedRef = useRef(true);
  const modelRequestRef = useRef(null);
  const modelSourceRef = useRef(null);
  const [apiSaving, setApiSaving] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const { theme, fonts, tokens, themes, themeId, setThemeId, fontScales, fontScaleId, setFontScaleId } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

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
    getSamplingSettings()
      .then(settings => {
        samplingRef.current = settings;
        setSampling(settings);
      })
      .catch(() => {});
    getVectorMemoryConfig()
      .then(config => {
        vectorMemoryRef.current = config;
        setVectorMemory(config);
        setVectorTopKDraft(String(config.topK));
        setVectorMaxCharsDraft(String(config.maxChars));
      })
      .catch(() => {});
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

  const persistSampling = useCallback(async next => {
    samplingRef.current = next;
    setSampling(next);
    try {
      const saved = await saveSamplingSettings(next);
      samplingRef.current = saved;
      setSampling(saved);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

  const toggleSamplingField = useCallback(name => {
    const current = samplingRef.current;
    const field = current[name] || {};
    persistSampling({
      ...current,
      [name]: { ...field, enabled: field.enabled !== true },
    });
  }, [persistSampling]);

  const commitSamplingValue = useCallback((name, rawText) => {
    const rule = SAMPLING_FIELDS[name];
    if (!rule) return;
    const current = samplingRef.current;
    const field = current[name] || {};
    const trimmed = String(rawText == null ? '' : rawText).trim();
    let value;
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      value = rule.default;
    } else {
      value = Number(trimmed);
      if (rule.integer) value = Math.round(value);
      if (value < rule.min || value > rule.max) {
        const clamped = Math.min(rule.max, Math.max(rule.min, value));
        Alert.alert('数值超出范围', `已调整为 ${clamped}。`);
        value = clamped;
      }
    }
    persistSampling({
      ...current,
      [name]: { enabled: field.enabled === true, value },
    });
  }, [persistSampling]);

  const updateVectorMemory = useCallback(async patch => {
    const base = vectorMemoryRef.current || vectorMemory;
    const next = { ...base, ...patch };
    vectorMemoryRef.current = next;
    setVectorMemory(next);
    try {
      const saved = await saveVectorMemoryConfig(next);
      vectorMemoryRef.current = saved;
      setVectorMemory(saved);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, [vectorMemory]);

  const testVector = useCallback(async () => {
    if (vectorTesting) return;
    setVectorTesting(true);
    try {
      const dims = await testVectorConnection(vectorMemoryRef.current || vectorMemory);
      Alert.alert('连接成功', `向量维度：${dims}`);
    } catch (error) {
      Alert.alert('连接失败', error?.message || '请检查地址、密钥与模型。');
    } finally {
      setVectorTesting(false);
    }
  }, [vectorMemory, vectorTesting]);

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

  useEffect(() => {
    apiMountedRef.current = true;
    getApiConfigs()
      .then(({ configs: list, activeId: id }) => {
        if (!apiMountedRef.current) return;
        apiStateRef.current = { configs: list, activeId: id, loaded: true };
        setConfigs(list);
        setActiveId(id);
        setLoaded(true);
      })
      .catch(() => {
        if (apiMountedRef.current) Alert.alert('读取配置失败', '请重新打开应用后重试。');
      });
    getPersonas()
      .then(list => {
        setPersonas(list);
        return getActivePersonaId(list);
      })
      .then(id => setActivePersonaIdState(id))
      .catch(() => {});
    getUserProfile()
      .then(profile => {
        setUserName(profile.userName);
        setUserPersona(profile.persona);
        setUserAvatarUri(profile.avatarUri || '');
        setNudgeDefault(profile.nudgeText || '');
      })
      .catch(() => {})
      .finally(() => setUserProfileLoaded(true));
    return () => {
      apiMountedRef.current = false;
      const request = modelRequestRef.current;
      modelRequestRef.current = null;
      modelSourceRef.current = null;
      request?.cancel?.();
    };
  }, []);

  const saveUserProfileDelayed = useMemo(() => {
    return (name, persona, avatar) => {
      profileStateRef.current = {
        userName: name,
        persona,
        avatarUri: avatar ?? profileStateRef.current.avatarUri,
        nudgeText: profileStateRef.current.nudgeText,
      };
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      profileTimerRef.current = setTimeout(async () => {
        profileTimerRef.current = null;
        const saving = (async () => {
          try {
            await saveUserProfile(profileStateRef.current);
          } catch (error) {}
        })();
        profileSavingRef.current = saving;
        await saving;
        if (profileSavingRef.current === saving) profileSavingRef.current = null;
        if (!profileMountedRef.current) return;
        setUserProfileSaved(true);
        clearTimeout(profileHintTimerRef.current);
        profileHintTimerRef.current = setTimeout(() => setUserProfileSaved(false), 2000);
      }, 600);
    };
  }, []);

  const changeUserAvatar = avatarUri => {
    if (!userProfileLoaded || !profileMountedRef.current) return;
    setUserAvatarUri(avatarUri);
    const profile = profileStateRef.current;
    saveUserProfileDelayed(profile.userName, profile.persona, avatarUri);
  };

  const refreshPersonas = useCallback(async () => {
    try {
      const list = await getPersonas();
      const id = await getActivePersonaId(list);
      setPersonas(list);
      setActivePersonaIdState(id);
      const active = list.find(item => item.id === id);
      setUserName(active ? active.userName : '');
      setUserPersona(active ? active.persona : '');
    } catch (error) {}
  }, []);

  const selectPersona = async id => {
    if (id === activePersonaId) return;
    if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
    try {
      const resolved = await setActivePersonaId(id);
      setActivePersonaIdState(resolved);
      await refreshPersonas();
    } catch (error) {
      Alert.alert('切换失败', '请重试。');
    }
  };

  const addPersona = async () => {
    if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
    try {
      await createPersona({ userName: '', persona: '' });
      await refreshPersonas();
    } catch (error) {
      Alert.alert('新增失败', '请重试。');
    }
  };

  const removePersona = id => {
    if (personas.length <= 1) {
      Alert.alert('无法删除', '至少保留一个人设。');
      return;
    }
    Alert.alert('删除人设', '确定删除这个人设吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
          try {
            await deletePersona(id);
            await refreshPersonas();
          } catch (error) {
            Alert.alert('删除失败', '至少保留一个人设。');
          }
        },
      },
    ]);
  };

  const pickUserAvatar = async () => {
    if (!userProfileLoaded) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = getPickedAsset(result);
      if (!asset?.uri) return;
      const dir = `${FileSystem.documentDirectory}avatars/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const ext = asset.uri.endsWith('.png') ? '.png' : '.jpg';
      const dest = `${dir}user-avatar${ext}`;
      await FileSystem.copyAsync({ from: asset.uri, to: dest });
      changeUserAvatar(dest);
    } catch (error) {
      Alert.alert('图片读取失败', '请重试。');
    }
  };

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

  const selectConfig = id => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    if (id === current.activeId || !current.configs.some(item => item.id === id)) return;
    return changeConfig(current.configs, id);
  };

  const addConfig = () => {
    if (!canChangeApi()) return;
    setVendorPickerOpen(true);
  };

  const applyVendorPreset = preset => {
    if (!canChangeApi() || !preset) return;
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

  const performSave = async caps => {
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
              name: item.name.trim() || '未命名配置',
              baseUrl: item.baseUrl.trim(),
              apiKey: item.apiKey.trim(),
              models: trimmedModels,
              activeModel,
              supportsThinking: caps.supportsThinking === true,
              supportsVision: caps.supportsVision === true,
              thinking: {
                field: String(caps.thinkingField || '').trim() || 'reasoning_effort',
                format: ['effort', 'boolean', 'object'].includes(caps.thinkingFormat)
                  ? caps.thinkingFormat
                  : 'effort',
              },
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
    const trimmedBaseUrl = selected.baseUrl.trim();
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
    setCapabilityDraft({
      supportsThinking: selected.supportsThinking === true,
      supportsVision: selected.supportsVision === true,
      thinkingField: (selected.thinking && selected.thinking.field) || 'reasoning_effort',
      thinkingFormat: (selected.thinking && selected.thinking.format) || 'effort',
    });
    setCapabilityOpen(true);
  };

  const confirmCapability = async () => {
    setCapabilityOpen(false);
    await performSave(capabilityDraft);
  };

  const detectModels = async () => {
    if (!canChangeApi() || modelRequestRef.current) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected?.apiKey.trim() || !selected?.baseUrl.trim()) {
      Alert.alert('请先填写 API 地址和 Key');
      return;
    }
    invalidateModels();
    const request = { cancel: null };
    modelRequestRef.current = request;
    const isCurrent = () => apiMountedRef.current && modelRequestRef.current === request;
    setDetectingModels(true);
    const base = normalizeChatUrl(selected.baseUrl).replace(/\/chat\/completions$/i, '');
    const fallback = /\/v1$/i.test(base) ? base.replace(/\/v1$/i, '') : `${base}/v1`;
    const urls = [`${base}/models`, `${fallback}/models`];
    let result = [];
    for (const url of urls) {
      if (!isCurrent()) return;
      if (result.length) break;
      try {
        const text = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          let settled = false;
          const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            request.cancel = null;
            fn(value);
          };
          request.cancel = () => {
            finish(reject, new Error('检测已取消'));
            xhr.abort();
          };
          xhr.open('GET', url);
          const detectAuthHeader = String(selected.authHeader || 'Authorization');
          const detectAuthScheme = selected.authScheme === undefined ? 'Bearer ' : String(selected.authScheme);
          xhr.setRequestHeader(detectAuthHeader, `${detectAuthScheme}${selected.apiKey.trim()}`);
          xhr.timeout = 15000;
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) finish(resolve, xhr.responseText);
            else finish(reject, new Error('请求失败'));
          };
          xhr.onerror = () => finish(reject, new Error('网络错误'));
          xhr.ontimeout = () => finish(reject, new Error('超时'));
          xhr.onabort = () => finish(reject, new Error('检测已取消'));
          xhr.send();
        });
        if (!isCurrent()) return;
        const data = JSON.parse(text);
        if (Array.isArray(data?.data)) {
          result = [...new Set(data.data.map(item => String(item?.id || '')).filter(Boolean))];
        }
      } catch (error) {}
    }
    if (!isCurrent()) return;
    modelRequestRef.current = null;
    setDetectingModels(false);
    if (result.length) {
      modelSourceRef.current = selected;
      setModelList(result);
      setModelModalVisible(true);
    } else {
      Alert.alert('未检测到模型', '无法获取模型列表，请检查 API 地址和 Key。');
    }
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
      return;
    }
    updateField({ models: [...models, model], activeModel: model });
    setModelDraft('');
  };

  const selectActiveModel = model => {
    if (!canChangeApi()) return;
    updateField({ activeModel: model });
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

  const saveUserProfileNow = async () => {
    if (!userProfileLoaded) return;
    clearTimeout(profileTimerRef.current);
    profileTimerRef.current = null;
    if (profileSavingRef.current) {
      profileSavingRef.current.then(() => saveUserProfileNow());
      return;
    }
    try {
      await saveUserProfile(profileStateRef.current);
      Alert.alert('已保存', '用户人设已保存到本机。');
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
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
          {configs.map(item => {
            const selected = item.id === activeId;
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.configRow, selected && styles.configRowActive]}
                onPress={() => selectConfig(item.id)}
                disabled={!loaded || apiSaving}
                activeOpacity={0.8}
              >
                <View style={styles.configInfo}>
                  <Text
                    style={[styles.configName, selected && styles.configNameActive]}
                    numberOfLines={1}
                  >
                    {item.name || '未命名配置'}
                  </Text>
                  <Text style={styles.configMeta} numberOfLines={1}>
                    {item.baseUrl || '未填写地址'} · {item.activeModel || '未填写模型'}
                  </Text>
                </View>
                {selected ? (
                  <View style={styles.currentBadge}>
                    <Ionicons name="checkmark" size={11} color={theme.colors.primarySoft} />
                    <Text style={styles.currentBadgeText}>当前</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}

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
                      <TouchableOpacity onPress={() => removeModel(model)} hitSlop={6}>
                        <Ionicons name="close" size={14} color={theme.colors.textFaint} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
              <FieldHint style={styles.hint}>点击模型将其设为当前模型，请求将使用当前模型。</FieldHint>
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
              <TextField
                value={active.apiKey}
                onChangeText={apiKey => updateField({ apiKey })}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="sk-..."
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
            这里的信息会被注入到提示词中，角色的正则脚本可以通过 {"{{user}}"} 引用你的名字。头像与拍一拍文案为全部人设共用。
          </Text>
          <FieldLabel style={styles.label}>我的身份</FieldLabel>
          <View style={styles.personaList}>
            {personas.map(item => {
              const active = item.id === activePersonaId;
              const label = String(item.userName || '').trim() || '未命名人设';
              return (
                <View key={item.id} style={[styles.personaChip, active && styles.personaChipActive]}>
                  <TouchableOpacity
                    style={styles.personaChipMain}
                    onPress={() => selectPersona(item.id)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.personaChipText, active && styles.personaChipTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                  {personas.length > 1 ? (
                    <TouchableOpacity
                      style={styles.personaChipRemove}
                      onPress={() => removePersona(item.id)}
                      hitSlop={6}
                    >
                      <Ionicons name="close" size={14} color={theme.colors.textFaint} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}
            <TouchableOpacity style={styles.personaAddChip} onPress={addPersona} activeOpacity={0.8}>
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.personaAddText}>新增</Text>
            </TouchableOpacity>
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
          <FieldLabel style={styles.label}>默认拍一拍文案</FieldLabel>
          <TextField
            value={nudgeDefault}
            onChangeText={text => {
              setNudgeDefault(text);
              if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
              profileTimerRef.current = setTimeout(() => {
                profileTimerRef.current = null;
                saveUserProfile({ ...profileStateRef.current, nudgeText: text }).catch(() => {});
              }, 600);
            }}
            placeholder="{user} 戳了戳 {char}"
          />
          <FieldHint style={styles.hint}>角色未单独设置拍一拍文案时使用；支持 {`{{user}}`} 与 {`{{char}}`} 占位。</FieldHint>
          <SecondaryButton
            title="保存用户人设"
            icon="save-outline"
            onPress={saveUserProfileNow}
            style={styles.actionBtn}
          />
          {userProfileSaved ? <Text style={styles.savedHint}>已自动保存</Text> : null}
        </Card>

        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="color-palette-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>外观</Text>
          </View>
          <View style={styles.appearanceRow}>
            {themes.map(item => {
              const active = item.id === themeId;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.themeChip, active && { borderColor: item.colors.primary }]}
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
          <View style={styles.fontRow}>
            {IMAGE_PROVIDERS.map(provider => {
              const active = inlineImage.providerId === provider.id;
              const configured = inlineImageProviders.includes(provider.id);
              return (
                <TouchableOpacity
                  key={provider.id}
                  style={[styles.fontChip, active && styles.fontChipActive]}
                  onPress={() => updateInlineImage({ providerId: provider.id })}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                    {configured ? provider.label : `${provider.label}（未配置）`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
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
          <Text style={styles.fieldHint}>生图密钥请在「扩展 → 生图」中配置。</Text>
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
              <Text style={styles.linkText}>全局预设</Text>
            </View>
            <View style={styles.linkRight}>
              <Text style={styles.linkValue}>
                {enabledPresetCount > 0 ? `已开启 ${enabledPresetCount} 项` : '未开启'}
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
              onValueChange={value => updateChatOption('fullWidth', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
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

        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="analytics-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>生成参数</Text>
          </View>
          {[
            { name: 'maxTokens', label: '最大回复令牌', keyboard: 'number-pad', hint: '1 - 128000' },
            { name: 'temperature', label: '温度', keyboard: 'decimal-pad', hint: '0 - 2' },
            { name: 'topP', label: 'top-p', keyboard: 'decimal-pad', hint: '0 - 1' },
            { name: 'topK', label: 'top-k', keyboard: 'number-pad', hint: '0 - 50' },
          ].map(item => {
            const field = sampling[item.name] || {};
            return (
              <View key={item.name} style={styles.capabilityRow}>
                <View style={styles.linkLeft}>
                  <Text style={styles.linkText}>{item.label}</Text>
                </View>
                <View style={styles.samplingRight}>
                  <TextField
                    style={styles.samplingInput}
                    value={String(field.value == null ? '' : field.value)}
                    onChangeText={text => {
                      const current = samplingRef.current;
                      const next = {
                        ...current,
                        [item.name]: { ...(current[item.name] || {}), value: text },
                      };
                      samplingRef.current = next;
                      setSampling(next);
                    }}
                    onEndEditing={event => commitSamplingValue(item.name, event.nativeEvent.text)}
                    keyboardType={item.keyboard}
                    placeholder={item.hint}
                  />
                  <Switch
                    value={field.enabled === true}
                    onValueChange={() => toggleSamplingField(item.name)}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
              </View>
            );
          })}
          <Text style={styles.fieldHint}>开启的项才会随请求发送，未开启时使用服务端默认。</Text>
        </Card>

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
              value={vectorMemory.enabled === true}
              onValueChange={value => updateVectorMemory({ enabled: value })}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldLabel style={styles.label}>接口地址</FieldLabel>
          <TextField
            value={vectorMemory.baseUrl}
            onChangeText={text => updateVectorMemory({ baseUrl: text })}
            placeholder="https://api.openai.com/v1"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>密钥</FieldLabel>
          <TextField
            value={vectorMemory.apiKey}
            onChangeText={text => updateVectorMemory({ apiKey: text })}
            placeholder="sk-..."
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <FieldLabel style={styles.label}>模型</FieldLabel>
          <TextField
            value={vectorMemory.model}
            onChangeText={text => updateVectorMemory({ model: text })}
            placeholder="text-embedding-3-small"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>召回条数（1 - 20）</FieldLabel>
          <TextField
            value={vectorTopKDraft}
            onChangeText={text => setVectorTopKDraft(text.replace(/[^0-9]/g, ''))}
            onEndEditing={event => updateVectorMemory({ topK: event.nativeEvent.text }).then(() => {
              const saved = vectorMemoryRef.current;
              if (saved) setVectorTopKDraft(String(saved.topK));
            })}
            keyboardType="number-pad"
            placeholder="5"
          />
          <FieldLabel style={styles.label}>分片长度（字符，1 - 2000）</FieldLabel>
          <TextField
            value={vectorMaxCharsDraft}
            onChangeText={text => setVectorMaxCharsDraft(text.replace(/[^0-9]/g, ''))}
            onEndEditing={event => updateVectorMemory({ maxChars: event.nativeEvent.text }).then(() => {
              const saved = vectorMemoryRef.current;
              if (saved) setVectorMaxCharsDraft(String(saved.maxChars));
            })}
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
          <Text style={styles.fieldHint}>
            未配置或请求失败时自动降级为本地关键词检索；密钥仅保存在本机。
          </Text>
        </Card>

        <TtsPanel
          visible={ttsEntryOpen}
          onClose={() => setTtsEntryOpen(false)}
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
        </Card>
      </ScrollView>

      <Modal
        visible={vendorPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setVendorPickerOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setVendorPickerOpen(false)}
        >
          <View style={styles.modalSheet}>
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
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={modelModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModelModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setModelModalVisible(false)}
        >
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>可用模型</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
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
          </View>
        </TouchableOpacity>
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
            <FieldHint style={styles.hint}>用于决定聊天页是否开放「思考」与图片上传。</FieldHint>
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

      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title="教学"
      />
    </KeyboardAvoidingView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 18 },
  scrollContent: { paddingBottom: 80 },

  pageHeader: { marginTop: 4, marginBottom: 14 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(24), fontWeight: '800', marginBottom: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 6, lineHeight: fonts.scaled(18) },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800', marginLeft: 8 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  topicButtonSpaced: { marginRight: 8 },
  appearanceRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  themeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'transparent',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  themeSwatch: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  themeSwatchDot: { width: 8, height: 8, borderRadius: 4 },
  themeChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '600' },
  fontRow: { flexDirection: 'row', flexWrap: 'wrap' },
  fontChip: {
    backgroundColor: theme.colors.surface,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
    marginBottom: 8,
  },
  fontChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  fontChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  fontChipTextActive: { color: theme.colors.primaryContrast, fontWeight: '700' },

  pillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${theme.colors.primary}1f`,
    borderWidth: 1,
    borderColor: `${theme.colors.primaryMuted}73`,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 15,
  },
  pillButtonText: { color: theme.colors.primarySoft, fontWeight: '700', fontSize: fonts.scaled(13), marginLeft: 4 },

  configRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  configRowActive: { borderColor: theme.colors.primary, backgroundColor: `${theme.colors.primary}29` },
  configInfo: { flex: 1, marginRight: 8 },
  configName: { color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  configNameActive: { color: theme.colors.text, fontWeight: '700' },
  configMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 2 },
  currentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${theme.colors.primary}40`,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  currentBadgeText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(11), fontWeight: '700', marginLeft: 3 },

  label: { color: theme.colors.text, marginTop: 14, marginBottom: 6, fontWeight: '700', fontSize: fonts.scaled(13) },
  multilineInput: { minHeight: 100, paddingTop: 12 },
  modelRow: { flexDirection: 'row', alignItems: 'center' },
  modelInput: { flex: 1, minHeight: 40, marginRight: 8 },

  actionBtn: {
    marginTop: tokens.spacing.md,
  },
  buttonDisabled: { opacity: 0.45 },

  detectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${theme.colors.primary}1f`,
    borderWidth: 1,
    borderColor: `${theme.colors.primaryMuted}73`,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  detectButtonText: { color: theme.colors.primarySoft, fontWeight: '700', fontSize: fonts.scaled(13), marginLeft: 6 },

  deleteButton: {
    flexDirection: 'row',
    backgroundColor: `${theme.colors.danger}1f`,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    paddingVertical: 13,
    borderRadius: 12,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonText: { color: theme.colors.dangerSoft, fontWeight: '800', marginLeft: 8 },

  fieldHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 4 },
  secondaryButton: {
    flexDirection: 'row',
    backgroundColor: `${theme.colors.primary}1f`,
    borderWidth: 1,
    borderColor: `${theme.colors.primaryMuted}73`,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: theme.colors.primarySoft, fontWeight: '800', marginLeft: 6 },
  savedHint: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), marginTop: 8 },

  selectButton: {
    flexDirection: 'row',
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectButtonGhost: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  selectButtonText: { color: theme.colors.primaryContrast, fontWeight: '700' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18 },
  capabilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  personaList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: 6,
  },
  personaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 16,
    marginRight: 8,
    marginBottom: 8,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
  },
  personaChipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  personaChipMain: { paddingRight: 4 },
  personaChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  personaChipTextActive: { color: theme.colors.primaryContrast },
  personaChipRemove: { paddingHorizontal: 2, paddingVertical: 2 },
  personaAddChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderStyle: 'dashed',
    borderRadius: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  personaAddText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), marginLeft: 4 },
  samplingRight: { flexDirection: 'row', alignItems: 'center' },
  samplingInput: {
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    fontSize: fonts.scaled(14),
    minWidth: 84,
    marginRight: 10,
    textAlign: 'right',
  },
  thinkingDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  thinkingDisplayChips: { flexDirection: 'row', alignItems: 'center' },
  capabilityLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), flex: 1, marginRight: 12 },
  modelChips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
    maxWidth: '100%',
  },
  modelChipActive: {
    backgroundColor: `${theme.colors.primary}40`,
    borderColor: theme.colors.primary,
  },
  modelChipMain: { maxWidth: 180, marginRight: 6 },
  modelChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  modelChipTextActive: { color: theme.colors.text, fontWeight: '700' },
  thinkingFormatRow: { flexDirection: 'row', marginTop: 8, marginBottom: 4 },
  formatChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
  },
  formatChipActive: { backgroundColor: `${theme.colors.primary}40`, borderColor: theme.colors.primary },
  formatChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  formatChipTextActive: { color: theme.colors.primarySoft },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  linkLeft: { flexDirection: 'row', alignItems: 'center' },
  linkText: { color: theme.colors.textMuted, fontSize: fonts.scaled(15), marginLeft: 10 },
  linkRight: { flexDirection: 'row', alignItems: 'center' },
  linkValue: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginRight: 6 },

  avatarRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  avatarBox: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
    marginRight: 12,
    borderWidth: 2,
    borderColor: `${theme.colors.primaryMuted}73`,
  },
  avatarImg: { width: 56, height: 56, borderRadius: 28 },
  avatarPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: `${theme.colors.primary}24`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(20), fontWeight: '800' },
  imageActions: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  smallButton: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: `${theme.colors.primaryMuted}73`,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginRight: 12,
  },
  smallButtonText: { color: theme.colors.primarySoft, fontWeight: '700', fontSize: fonts.scaled(13) },
  removeText: { color: theme.colors.dangerSoft, fontWeight: '700' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    padding: tokens.metrics.cardPadding,
    maxHeight: '70%',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    ...tokens.elevation(2, theme),
  },
  modalTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800', marginBottom: 12 },
  modalList: { maxHeight: 360 },
  modalRow: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.sm + 2,
    paddingHorizontal: tokens.spacing.md,
    marginBottom: tokens.spacing.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  modalRowText: { color: theme.colors.textMuted },
  apiKeyLinkRow: { alignItems: 'flex-end', marginTop: 6 },
  apiKeyLink: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700' },
  vendorEditorNote: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginTop: 6,
  },
  vendorList: { maxHeight: 420 },
  vendorSectionLabel: {
    color: theme.colors.primaryMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '800',
    marginTop: 10,
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  vendorRow: {
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  vendorRowDisabled: { opacity: 0.5 },
  vendorRowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  vendorName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', flex: 1, marginRight: 8 },
  vendorNameDisabled: { color: theme.colors.textMuted },
  vendorCategory: { color: theme.colors.primarySoft, fontSize: fonts.scaled(11), fontWeight: '700' },
  vendorBaseUrl: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginBottom: 3 },
  vendorNote: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18) },
});
