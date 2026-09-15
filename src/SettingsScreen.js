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
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

import { createApiConfig, getApiConfigs, getUserProfile, saveApiConfigs, saveUserProfile } from './storage';

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
  const profileTimerRef = useRef(null);

  useEffect(() => {
    getApiConfigs()
      .then(({ configs: list, activeId: id }) => {
        setConfigs(list);
        setActiveId(id);
      })
      .catch(() => {
        Alert.alert('读取配置失败', '已使用默认配置，请重新填写后保存。');
      })
      .finally(() => setLoaded(true));
    getUserProfile()
      .then(profile => {
        setUserName(profile.userName);
        setUserPersona(profile.persona);
        setUserAvatarUri(profile.avatarUri || '');
      })
      .catch(() => {})
      .finally(() => setUserProfileLoaded(true));
  }, []);

  const saveUserProfileDelayed = useMemo(() => {
    return (name, persona, avatar) => {
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      profileTimerRef.current = setTimeout(async () => {
        try {
          await saveUserProfile({ userName: name, persona, avatarUri: avatar ?? userAvatarUri });
          setUserProfileSaved(true);
          setTimeout(() => setUserProfileSaved(false), 2000);
        } catch (error) {}
      }, 600);
    };
  }, []);

  const pickUserAvatar = async () => {
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
      setUserAvatarUri(dest);
    } catch (error) {
      Alert.alert('图片读取失败', '请重试。');
    }
  };

  const active = useMemo(
    () => configs.find(item => item.id === activeId) || configs[0] || null,
    [configs, activeId]
  );

  const persist = async (list, id) => {
    const saved = await saveApiConfigs(list, id);
    setConfigs(saved.configs);
    setActiveId(saved.activeId);
    return saved;
  };

  const updateField = patch => {
    if (!active) return;
    setConfigs(list =>
      list.map(item => (item.id === active.id ? { ...item, ...patch } : item))
    );
  };

  const selectConfig = id => {
    if (id === activeId) return;
    setActiveId(id);
    persist(configs, id).catch(() => {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    });
  };

  const addConfig = () => {
    const created = createApiConfig({ name: `配置 ${configs.length + 1}` });
    const next = [...configs, created];
    setConfigs(next);
    setActiveId(created.id);
    persist(next, created.id).catch(() => {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    });
  };

  const deleteConfig = () => {
    if (!active || configs.length <= 1) {
      Alert.alert('无法删除', '至少保留一套 API 配置。');
      return;
    }
    Alert.alert('删除配置', `确定删除“${active.name}”吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const next = configs.filter(item => item.id !== active.id);
          const nextActive = activeId === active.id ? next[0].id : activeId;
          setConfigs(next);
          setActiveId(nextActive);
          persist(next, nextActive).catch(() => {
            Alert.alert('保存失败', '请检查存储空间或权限。');
          });
        },
      },
    ]);
  };

  const save = async () => {
    if (!loaded || !active) return;
    const trimmedBaseUrl = active.baseUrl.trim();
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
      if (!confirmed) return;
    }
    const trimmed = configs.map(item =>
      item.id === active.id
        ? {
            ...item,
            name: item.name.trim() || '未命名配置',
            baseUrl: trimmedBaseUrl,
            model: item.model.trim(),
            apiKey: item.apiKey.trim(),
          }
        : item
    );
    try {
      await persist(trimmed, active.id);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
      return;
    }
    Alert.alert('已保存', 'API 配置已保存到本机。');
  };

  const detectModels = async () => {
    if (!active || !active.apiKey || !active.baseUrl) {
      Alert.alert('请先填写 API 地址和 Key');
      return;
    }
    setDetectingModels(true);
    setModelList([]);
    const base = active.baseUrl.replace(/\/+$/, '').replace(/\/v1\/chat\/completions$/, '').replace(/\/chat\/completions$/, '');
    const urls = [`${base}/v1/models`, `${base}/models`];
    let result = [];
    for (const url of urls) {
      if (result.length) break;
      try {
        const text = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url);
          xhr.setRequestHeader('Authorization', `Bearer ${active.apiKey}`);
          xhr.timeout = 15000;
          xhr.onload = () => resolve(xhr.responseText);
          xhr.onerror = () => reject(new Error('网络错误'));
          xhr.ontimeout = () => reject(new Error('超时'));
          xhr.send();
        });
        const data = JSON.parse(text);
        if (Array.isArray(data?.data)) {
          result = data.data.map(item => String(item.id || '')).filter(Boolean);
        }
      } catch (error) {}
    }
    setDetectingModels(false);
    if (result.length) {
      setModelList(result);
      setModelModalVisible(true);
    } else {
      Alert.alert('未检测到模型', '无法获取模型列表，请检查 API 地址和 Key。');
    }
  };

  const applyModel = model => {
    updateField({ model });
    setModelModalVisible(false);
  };

  const saveUserProfileNow = async () => {
    try {
      await saveUserProfile({ userName, persona: userPersona, avatarUri: userAvatarUri });
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
    Alert.alert(
      '免责条款',
      'EasyChat2 是一个开源 AI 聊天工具，仅供学习交流使用。\n\n'
        + '用户自行配置 API 端点与密钥，所有聊天内容直发到用户指定的服务地址。\n\n'
        + '开发者不对用户使用本应用产生的任何后果负责，包括但不限于：\n'
        + '- 第三方服务中断或数据泄露\n'
        + '- 因配置错误导致的安全问题\n'
        + '- 生成的任何内容的准确性、合法性\n\n'
        + '使用即代表同意以上条款。'
    );
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
        <Text style={styles.title}>设置</Text>

        <View style={styles.libraryHeader}>
          <Text style={styles.libraryTitle}>API 配置</Text>
          <TouchableOpacity style={styles.newButton} onPress={addConfig} activeOpacity={0.8}>
            <Text style={styles.newButtonText}>新建</Text>
          </TouchableOpacity>
        </View>
        {configs.map(item => {
          const selected = item.id === activeId;
          return (
            <TouchableOpacity
              key={item.id}
              style={[styles.configRow, selected && styles.configRowActive]}
              onPress={() => selectConfig(item.id)}
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
              {selected ? <Text style={styles.configBadge}>当前</Text> : null}
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
                style={styles.detectButton}
                onPress={detectModels}
                disabled={detectingModels}
                activeOpacity={0.8}
              >
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
            <TouchableOpacity style={styles.button} onPress={save}>
              <Text style={styles.buttonText}>保存配置</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.deleteButton, configs.length <= 1 && styles.buttonDisabled]}
              onPress={deleteConfig}
              disabled={configs.length <= 1}
              activeOpacity={0.8}
            >
              <Text style={styles.deleteButtonText}>删除当前配置</Text>
            </TouchableOpacity>
          </>
        ) : null}

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>用户人设</Text>
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
            <TouchableOpacity style={styles.imageButton} onPress={pickUserAvatar} activeOpacity={0.8}>
              <Text style={styles.imageButtonText}>{userAvatarUri ? '更换头像' : '选择头像'}</Text>
            </TouchableOpacity>
            {userAvatarUri ? (
              <TouchableOpacity onPress={() => setUserAvatarUri('')} hitSlop={8}>
                <Text style={styles.removeText}>清除</Text>
              </TouchableOpacity>
            ) : null}
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
            <Text style={styles.secondaryButtonText}>保存用户人设</Text>
          </TouchableOpacity>
          {userProfileSaved ? <Text style={styles.savedHint}>已自动保存</Text> : null}
        </View>

        <View style={styles.linksSection}>
          <TouchableOpacity style={styles.linkRow} onPress={openTutorial} activeOpacity={0.7}>
            <Text style={styles.linkText}>使用教程</Text>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openDisclaimer} activeOpacity={0.7}>
            <Text style={styles.linkText}>免责条款</Text>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openGitHub} activeOpacity={0.7}>
            <Text style={styles.linkText}>GitHub 地址</Text>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={checkUpdate} activeOpacity={0.7}>
            <Text style={styles.linkText}>检测更新</Text>
            <Text style={styles.linkArrow}>›</Text>
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
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 20 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 18 },
  libraryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  libraryTitle: { color: '#fff', fontWeight: '800' },
  newButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  newButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13 },
  configRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2d2d44',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  configRowActive: { borderWidth: 1, borderColor: '#6c63ff' },
  configInfo: { flex: 1, marginRight: 8 },
  configName: { color: '#d9d9e6' },
  configNameActive: { color: '#fff', fontWeight: '700' },
  configMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  configBadge: { color: '#c8c4ff', fontSize: 12, fontWeight: '700' },
  label: { color: '#fff', marginTop: 14, marginBottom: 6, fontWeight: '700' },
  hint: { color: '#888', fontSize: 12, marginTop: 6, lineHeight: 18 },
  input: { backgroundColor: '#2d2d44', color: '#fff', padding: 12, borderRadius: 8 },
  button: { backgroundColor: '#6c63ff', padding: 14, borderRadius: 8, marginTop: 24, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '800' },
  deleteButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#7a2e2e',
    padding: 14,
    borderRadius: 8,
    marginTop: 12,
    alignItems: 'center',
  },
  deleteButtonText: { color: '#ff9b9b', fontWeight: '800' },
  buttonDisabled: { opacity: 0.45 },
  modelRow: { flexDirection: 'row', alignItems: 'center' },
  modelInput: { flex: 1, marginRight: 8 },
  detectButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  detectButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13 },
  panel: { marginTop: 28, borderTopWidth: 1, borderTopColor: '#2d2d44', paddingTop: 18 },
  panelTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  fieldHint: { color: '#888', fontSize: 12, lineHeight: 18, marginBottom: 4 },
  multilineInput: { minHeight: 100 },
  secondaryButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#6c63ff',
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#c8c4ff', fontWeight: '800' },
  savedHint: { color: '#6c63ff', fontSize: 12, marginTop: 4 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: '#24243b',
    borderRadius: 12,
    padding: 16,
    maxHeight: '70%',
  },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 12 },
  modalList: { maxHeight: 360 },
  modalRow: {
    backgroundColor: '#2d2d44',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  modalRowText: { color: '#d9d9e6' },
  scrollContent: { paddingBottom: 80 },
  linksSection: { marginTop: 28, borderTopWidth: 1, borderTopColor: '#2d2d44', paddingTop: 4 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44',
  },
  linkText: { color: '#d9d9e6', fontSize: 15 },
  linkArrow: { color: '#888', fontSize: 20 },
  avatarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  avatarBox: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: '#2d2d44',
    overflow: 'hidden',
    marginRight: 12,
  },
  avatarImg: { width: 52, height: 52 },
  avatarPlaceholder: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: { color: '#aaa', fontSize: 18, fontWeight: '800' },
  imageButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginRight: 10,
  },
  imageButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13 },
  removeText: { color: '#ff9b9b', fontWeight: '700' },
});
