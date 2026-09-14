import React, { useEffect, useMemo, useState } from 'react';
import {
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

import { createApiConfig, getApiConfigs, saveApiConfigs } from './storage';

export default function SettingsScreen() {
  const [configs, setConfigs] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [loaded, setLoaded] = useState(false);

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
  }, []);

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

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
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
            <TextInput
              style={styles.input}
              value={active.model}
              onChangeText={model => updateField({ model })}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="deepseek-chat"
              placeholderTextColor="#888"
            />
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
      </ScrollView>
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
});
