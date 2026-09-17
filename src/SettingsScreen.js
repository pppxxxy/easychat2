import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import Ionicons from '@expo/vector-icons/Ionicons';

import { normalizeChatUrl } from './api';
import { DISCLAIMER_TEXT } from './disclaimer';
import {
  createApiConfig,
  createGlobalPresetId,
  getApiConfigs,
  getGlobalPresetSettings,
  getGlobalPresets,
  getUserProfile,
  saveApiConfigs,
  saveGlobalPresetSettings,
  saveGlobalPresets,
  saveUserProfile,
} from './storage';

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
  const [userAvatarUri, setUserAvatarUri] = useState('');
  const [userProfileLoaded, setUserProfileLoaded] = useState(false);
  const [detectingModels, setDetectingModels] = useState(false);
  const [modelList, setModelList] = useState([]);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [userProfileSaved, setUserProfileSaved] = useState(false);
  const [presetEnabled, setPresetEnabled] = useState({});
  const [presets, setPresets] = useState([]);
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState(null);
  const [presetForm, setPresetForm] = useState({ name: '', description: '', prompt: '' });
  const profileTimerRef = useRef(null);
  const profileHintTimerRef = useRef(null);
  const profileSavingRef = useRef(null);
  const profileMountedRef = useRef(true);
  const profileStateRef = useRef(null);
  profileStateRef.current = { userName, persona: userPersona, avatarUri: userAvatarUri };

  useEffect(() => {
    profileMountedRef.current = true;
    return () => {
      profileMountedRef.current = false;
      clearTimeout(profileTimerRef.current);
      clearTimeout(profileHintTimerRef.current);
    };
  }, []);
  const presetBusyRef = useRef(false);
  const apiStateRef = useRef({ configs: [], activeId: '', loaded: false });
  const apiBusyRef = useRef(false);
  const apiMountedRef = useRef(true);
  const modelRequestRef = useRef(null);
  const modelSourceRef = useRef(null);
  const [apiSaving, setApiSaving] = useState(false);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetSaving, setPresetSaving] = useState(false);

  useEffect(() => {
    Promise.all([getGlobalPresets(), getGlobalPresetSettings()])
      .then(([list, enabled]) => {
        setPresets(list);
        setPresetEnabled(enabled);
        setPresetsLoaded(true);
      })
      .catch(() => Alert.alert('预设读取失败', '请重新打开应用后重试。'));
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
    getUserProfile()
      .then(profile => {
        setUserName(profile.userName);
        setUserPersona(profile.persona);
        setUserAvatarUri(profile.avatarUri || '');
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

  const togglePreset = async (id, value) => {
    if (!presetsLoaded || presetBusyRef.current) return;
    presetBusyRef.current = true;
    setPresetSaving(true);
    try {
      const next = await saveGlobalPresetSettings({ ...presetEnabled, [id]: value });
      setPresetEnabled(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    } finally {
      presetBusyRef.current = false;
      setPresetSaving(false);
    }
  };

  const openPresetEditor = preset => {
    if (!presetsLoaded || presetBusyRef.current) return;
    setEditingPreset(preset);
    setPresetForm({
      name: preset?.name || '',
      description: preset?.description || '',
      prompt: preset?.prompt || '',
    });
    setPresetModalOpen(true);
  };

  const savePresetForm = async () => {
    if (presetBusyRef.current) return;
    const name = presetForm.name.trim();
    const prompt = presetForm.prompt.trim();
    if (!name || !prompt) {
      Alert.alert('信息不全', '名称和提示词不能为空。');
      return;
    }
    presetBusyRef.current = true;
    setPresetSaving(true);
    try {
      const basePresets = await getGlobalPresets();
      const id = editingPreset?.id || await createGlobalPresetId(basePresets);
      const item = { id, name, description: presetForm.description.trim(), prompt };
      const list = editingPreset
        ? basePresets.map(item0 => (item0.id === item.id ? item : item0))
        : [...basePresets, item];
      const saved = await saveGlobalPresets(list);
      setPresets(saved);
      setEditingPreset(editingPreset ? saved.find(entry => entry.id === id) || null : null);
      setPresetModalOpen(false);
    } catch (error) {
      Alert.alert('保存失败', error?.message || '请检查存储空间或权限。');
    } finally {
      presetBusyRef.current = false;
      setPresetSaving(false);
    }
  };

  const deletePreset = preset => {
    if (!presetsLoaded || presetBusyRef.current) return;
    Alert.alert('删除预设', `确定删除「${preset.name || '未命名'}」吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          if (presetBusyRef.current) return;
          presetBusyRef.current = true;
          setPresetSaving(true);
          try {
            const saved = await saveGlobalPresets(
              (await getGlobalPresets()).filter(item => item.id !== preset.id)
            );
            setPresets(saved);
            setPresetEnabled(current => {
              const next = { ...current };
              delete next[preset.id];
              return next;
            });
          } catch (error) {
            Alert.alert('删除失败', error?.message || '请检查存储空间或权限。');
          } finally {
            presetBusyRef.current = false;
            setPresetSaving(false);
          }
        },
      },
    ]);
  };

  const saveUserProfileDelayed = useMemo(() => {
    return (name, persona, avatar) => {
      profileStateRef.current = { userName: name, persona, avatarUri: avatar ?? profileStateRef.current.avatarUri };
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
    const list = apiStateRef.current.configs;
    const created = createApiConfig({ name: `配置 ${list.length + 1}` });
    return changeConfig([...list, created], created.id);
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

  const save = async () => {
    if (!canChangeApi()) return;
    const current = apiStateRef.current;
    const selected = current.configs.find(item => item.id === current.activeId);
    if (!selected) return;
    apiBusyRef.current = true;
    setApiSaving(true);
    try {
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
      const trimmed = current.configs.map(item =>
        item.id === selected.id
          ? {
              ...item,
              name: item.name.trim() || '未命名配置',
              baseUrl: trimmedBaseUrl,
              model: item.model.trim(),
              apiKey: item.apiKey.trim(),
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
          xhr.setRequestHeader('Authorization', `Bearer ${selected.apiKey.trim()}`);
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
    updateField({ model });
    setModelModalVisible(false);
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
    Linking.openURL('https://github.com/pppxxxy/easychat2/wiki').catch(() =>
      Alert.alert('无法打开', '请手动访问 GitHub 仓库查看使用说明。')
    );
  };

  const openDisclaimer = () => {
    Alert.alert('免责条款', DISCLAIMER_TEXT);
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
          <Text style={styles.hint}>配置 API、用户人设与全局对话预设。</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="key-outline" size={16} color="#8b85ff" />
              <Text style={styles.cardTitle}>API 配置</Text>
            </View>
            <TouchableOpacity
              style={[styles.pillButton, (!loaded || apiSaving) && styles.buttonDisabled]}
              onPress={addConfig}
              disabled={!loaded || apiSaving}
              activeOpacity={0.8}
            >
              <Ionicons name="add" size={15} color="#c8c4ff" />
              <Text style={styles.pillButtonText}>新建</Text>
            </TouchableOpacity>
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
                    {item.baseUrl || '未填写地址'} · {item.model || '未填写模型'}
                  </Text>
                </View>
                {selected ? (
                  <View style={styles.currentBadge}>
                    <Ionicons name="checkmark" size={11} color="#c8c4ff" />
                    <Text style={styles.currentBadgeText}>当前</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}

          {active ? (
            <>
              <Text style={styles.label}>配置名称</Text>
              <TextInput
                style={styles.input}
                value={active.name}
                onChangeText={name => updateField({ name })}
                placeholder="例如：DeepSeek 主力"
                placeholderTextColor="#888"
              />
              <Text style={styles.label}>API 地址</Text>
              <TextInput
                style={styles.input}
                value={active.baseUrl}
                onChangeText={baseUrl => updateField({ baseUrl })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://api.deepseek.com"
                placeholderTextColor="#888"
              />
              <Text style={styles.hint}>可填根地址，或带 /v1、/v1/chat/completions 的完整地址。</Text>
              <Text style={styles.label}>模型</Text>
              <View style={styles.modelRow}>
                <TextInput
                  style={[styles.input, styles.modelInput]}
                  value={active.model}
                  onChangeText={model => updateField({ model })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="deepseek-chat"
                  placeholderTextColor="#888"
                />
                <TouchableOpacity
                  style={[styles.detectButton, detectingModels && styles.buttonDisabled]}
                  onPress={detectModels}
                  disabled={detectingModels}
                  activeOpacity={0.8}
                >
                  <Ionicons name="pulse-outline" size={15} color="#c8c4ff" />
                  <Text style={styles.detectButtonText}>
                    {detectingModels ? '检测中...' : '检测模型'}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.label}>API Key</Text>
              <TextInput
                style={styles.input}
                value={active.apiKey}
                onChangeText={apiKey => updateField({ apiKey })}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="sk-..."
                placeholderTextColor="#888"
              />
              <Text style={styles.hint}>
                API Key 与聊天内容会直接发送到你填写的地址，并保存在本机。请确认你信任该服务商。
              </Text>
              <TouchableOpacity style={styles.button} onPress={save} activeOpacity={0.85}>
                <Ionicons name="save-outline" size={17} color="#fff" />
                <Text style={styles.buttonText}>保存配置</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.deleteButton, configs.length <= 1 && styles.buttonDisabled]}
                onPress={deleteConfig}
                disabled={configs.length <= 1}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={16} color="#ff9b9b" />
                <Text style={styles.deleteButtonText}>删除当前配置</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="person-circle-outline" size={16} color="#8b85ff" />
            <Text style={styles.cardTitle}>用户人设</Text>
          </View>
          <Text style={styles.fieldHint}>
            这里的信息会被注入到提示词中，角色的正则脚本可以通过 {"{{user}}"} 引用你的名字。
          </Text>
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
          <Text style={styles.label}>你的名字</Text>
          <TextInput
            style={styles.input}
            value={userName}
            onChangeText={text => { setUserName(text); saveUserProfileDelayed(text, userPersona, userAvatarUri); }}
            placeholder="例如：小明"
            placeholderTextColor="#888"
          />
          <Text style={styles.label}>人设描述</Text>
          <TextInput
            style={[styles.input, styles.multilineInput]}
            value={userPersona}
            onChangeText={text => { setUserPersona(text); saveUserProfileDelayed(userName, text, userAvatarUri); }}
            placeholder="描述你自己的性格、背景、喜好等"
            placeholderTextColor="#888"
            multiline
            textAlignVertical="top"
          />
          <TouchableOpacity style={styles.secondaryButton} onPress={saveUserProfileNow} activeOpacity={0.8}>
            <Ionicons name="save-outline" size={16} color="#c8c4ff" />
            <Text style={styles.secondaryButtonText}>保存用户人设</Text>
          </TouchableOpacity>
          {userProfileSaved ? <Text style={styles.savedHint}>已自动保存</Text> : null}
        </View>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="options-outline" size={16} color="#8b85ff" />
            <Text style={styles.cardTitle}>对话预设</Text>
          </View>
          <Text style={styles.fieldHint}>
            这些预设无视角色卡，对所有对话生效。开启后会追加到系统提示词中。点击条目可编辑。
          </Text>
          {presets.map(preset => (
            <View key={preset.id} style={styles.presetRow}>
              <TouchableOpacity
                style={styles.presetInfo}
                activeOpacity={0.7}
                onPress={() => openPresetEditor(preset)}
              >
                <Text style={styles.presetName}>{preset.name}</Text>
                {preset.description ? (
                  <Text style={styles.presetDesc}>{preset.description}</Text>
                ) : null}
              </TouchableOpacity>
              <Switch
                value={presetEnabled[preset.id] === true}
                onValueChange={value => togglePreset(preset.id, value)}
                trackColor={{ false: '#2d2d44', true: '#6c63ff' }}
                thumbColor="#ffffff"
              />
              <TouchableOpacity
                style={styles.presetDelete}
                hitSlop={8}
                onPress={() => deletePreset(preset)}
                disabled={presetSaving}
                accessibilityLabel="删除预设"
              >
                <Ionicons name="trash-outline" size={16} color="#ff9b9b" />
              </TouchableOpacity>
            </View>
          ))}
          {presetsLoaded && presets.length === 0 ? (
            <Text style={styles.fieldHint}>暂无预设，点击下方按钮新增。</Text>
          ) : null}
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => openPresetEditor(null)}
            disabled={!presetsLoaded || presetSaving}
            activeOpacity={0.8}
          >
            <Ionicons name="add" size={16} color="#c8c4ff" />
            <Text style={styles.secondaryButtonText}>新增预设</Text>
          </TouchableOpacity>
        </View>

        <Modal
          visible={presetModalOpen}
          transparent
          animationType="fade"
          onRequestClose={() => { if (!presetBusyRef.current) setPresetModalOpen(false); }}
        >
          <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={styles.modalSheet}>
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={styles.modalTitle}>{editingPreset ? '编辑预设' : '新增预设'}</Text>
                <Text style={styles.label}>名称</Text>
                <TextInput
                  style={styles.input}
                  value={presetForm.name}
                  editable={!presetSaving}
                  onChangeText={text => setPresetForm(current => ({ ...current, name: text }))}
                  placeholder="例如：控制篇幅"
                  placeholderTextColor="#888"
                />
                <Text style={styles.label}>描述（可选）</Text>
                <TextInput
                  style={styles.input}
                  value={presetForm.description}
                  editable={!presetSaving}
                  onChangeText={text => setPresetForm(current => ({ ...current, description: text }))}
                  placeholder="一句话说明用途"
                  placeholderTextColor="#888"
                />
                <Text style={styles.label}>提示词</Text>
                <TextInput
                  style={[styles.input, styles.presetPromptInput]}
                  value={presetForm.prompt}
                  editable={!presetSaving}
                  onChangeText={text => setPresetForm(current => ({ ...current, prompt: text }))}
                  placeholder="开启后追加到系统提示词的内容"
                  placeholderTextColor="#888"
                  multiline
                  textAlignVertical="top"
                />
              </ScrollView>
              <View style={styles.presetModalActions}>
                <TouchableOpacity
                  style={[styles.selectButton, styles.selectButtonGhost]}
                  onPress={() => setPresetModalOpen(false)}
                  disabled={presetSaving}
                  activeOpacity={0.8}
                >
                  <Text style={styles.selectButtonText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.selectButton, presetSaving && styles.buttonDisabled]}
                  onPress={savePresetForm}
                  disabled={presetSaving}
                  activeOpacity={0.8}
                >
                  <Text style={styles.selectButtonText}>{presetSaving ? '保存中…' : '保存'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="information-circle-outline" size={16} color="#8b85ff" />
            <Text style={styles.cardTitle}>关于</Text>
          </View>
          <TouchableOpacity style={styles.linkRow} onPress={openTutorial} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="book-outline" size={17} color="#8b85ff" />
              <Text style={styles.linkText}>使用教程</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#6c63ff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openDisclaimer} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="document-text-outline" size={17} color="#8b85ff" />
              <Text style={styles.linkText}>免责条款</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#6c63ff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openGitHub} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="logo-github" size={17} color="#8b85ff" />
              <Text style={styles.linkText}>GitHub 地址</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#6c63ff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={checkUpdate} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="refresh-outline" size={17} color="#8b85ff" />
              <Text style={styles.linkText}>检测更新</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#6c63ff" />
          </TouchableOpacity>
        </View>
      </ScrollView>

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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#1a1a2e' },
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 18 },
  scrollContent: { paddingBottom: 80 },

  pageHeader: { marginTop: 4, marginBottom: 6 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 6 },
  hint: { color: '#9a9ab5', fontSize: 12, marginTop: 6, lineHeight: 18 },

  card: {
    backgroundColor: '#232338',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2d2d44',
    padding: 14,
    marginTop: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: '#fff', fontSize: 15, fontWeight: '800', marginLeft: 8 },

  pillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(108,99,255,0.12)',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 15,
  },
  pillButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13, marginLeft: 4 },

  configRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2d2d44',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  configRowActive: { borderColor: '#6c63ff', backgroundColor: 'rgba(108,99,255,0.16)' },
  configInfo: { flex: 1, marginRight: 8 },
  configName: { color: '#d9d9e6', fontSize: 14 },
  configNameActive: { color: '#fff', fontWeight: '700' },
  configMeta: { color: '#7d7d99', fontSize: 12, marginTop: 2 },
  currentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(108,99,255,0.25)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  currentBadgeText: { color: '#c8c4ff', fontSize: 11, fontWeight: '700', marginLeft: 3 },

  label: { color: '#e6e6f2', marginTop: 14, marginBottom: 6, fontWeight: '700', fontSize: 13 },
  input: {
    backgroundColor: '#2d2d44',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a58',
    fontSize: 14,
  },
  multilineInput: { minHeight: 100, paddingTop: 12 },
  modelRow: { flexDirection: 'row', alignItems: 'center' },
  modelInput: { flex: 1, marginRight: 8 },

  button: {
    flexDirection: 'row',
    backgroundColor: '#6c63ff',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '800', marginLeft: 8, fontSize: 15 },
  buttonDisabled: { opacity: 0.45 },

  detectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(108,99,255,0.12)',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  detectButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13, marginLeft: 6 },

  deleteButton: {
    flexDirection: 'row',
    backgroundColor: 'rgba(176,70,63,0.12)',
    borderWidth: 1,
    borderColor: '#7a2e2e',
    paddingVertical: 13,
    borderRadius: 12,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonText: { color: '#ff9b9b', fontWeight: '800', marginLeft: 8 },

  fieldHint: { color: '#7d7d99', fontSize: 12, lineHeight: 18, marginBottom: 4 },
  secondaryButton: {
    flexDirection: 'row',
    backgroundColor: 'rgba(108,99,255,0.12)',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: '#c8c4ff', fontWeight: '800', marginLeft: 6 },
  savedHint: { color: '#8b85ff', fontSize: 12, marginTop: 8 },

  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44',
  },
  presetInfo: { flex: 1, marginRight: 12 },
  presetName: { color: '#fff', fontWeight: '700', fontSize: 14 },
  presetDesc: { color: '#7d7d99', fontSize: 12, marginTop: 2, lineHeight: 17 },
  presetDelete: { marginLeft: 10, paddingVertical: 6 },
  presetModalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  presetPromptInput: { minHeight: 120, maxHeight: 240 },
  selectButton: {
    flexDirection: 'row',
    backgroundColor: '#6c63ff',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectButtonGhost: { backgroundColor: '#2d2d44' },
  selectButtonText: { color: '#fff', fontWeight: '700' },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44',
  },
  linkLeft: { flexDirection: 'row', alignItems: 'center' },
  linkText: { color: '#d9d9e6', fontSize: 15, marginLeft: 10 },

  avatarRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  avatarBox: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#2d2d44',
    overflow: 'hidden',
    marginRight: 12,
    borderWidth: 1,
    borderColor: '#3a3a58',
  },
  avatarImg: { width: 60, height: 60 },
  avatarPlaceholder: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: { color: '#9a9ab5', fontSize: 20, fontWeight: '800' },
  imageActions: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  smallButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginRight: 12,
  },
  smallButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13 },
  removeText: { color: '#ff9b9b', fontWeight: '700' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: '#232338',
    borderRadius: 16,
    padding: 16,
    maxHeight: '70%',
    borderWidth: 1,
    borderColor: '#2d2d44',
  },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 12 },
  modalList: { maxHeight: 360 },
  modalRow: {
    backgroundColor: '#2d2d44',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#3a3a58',
  },
  modalRowText: { color: '#d9d9e6' },
});
