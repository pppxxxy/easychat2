import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';

import { getApiConfig, saveApiConfig } from './storage';

export default function SettingsScreen() {
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    getApiConfig()
      .then(config => {
        setBaseUrl(config.baseUrl || 'https://api.deepseek.com');
        setModel(config.model || 'deepseek-chat');
        setApiKey(config.apiKey || '');
      })
      .catch(() => {
        Alert.alert('读取配置失败', '已使用默认配置，请重新填写后保存。');
      });
  }, []);

  const save = async () => {
    const trimmedBaseUrl = baseUrl.trim();
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
    try {
      await saveApiConfig({
        baseUrl: trimmedBaseUrl,
        model: model.trim(),
        apiKey: apiKey.trim()
      });
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
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>设置</Text>
        <Text style={styles.label}>API 地址</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://api.deepseek.com"
          placeholderTextColor="#888"
        />
        <Text style={styles.hint}>可填根地址，或带 /v1、/v1/chat/completions 的完整地址。</Text>
        <Text style={styles.label}>模型</Text>
        <TextInput
          style={styles.input}
          value={model}
          onChangeText={setModel}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="deepseek-chat"
          placeholderTextColor="#888"
        />
        <Text style={styles.label}>API Key</Text>
        <TextInput
          style={styles.input}
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="sk-..."
          placeholderTextColor="#888"
        />
        <TouchableOpacity style={styles.button} onPress={save}>
          <Text style={styles.buttonText}>保存配置</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#1a1a2e' },
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 20 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 18 },
  label: { color: '#fff', marginTop: 14, marginBottom: 6, fontWeight: '700' },
  hint: { color: '#888', fontSize: 12, marginTop: 6, lineHeight: 18 },
  input: { backgroundColor: '#2d2d44', color: '#fff', padding: 12, borderRadius: 8 },
  button: { backgroundColor: '#6c63ff', padding: 14, borderRadius: 8, marginTop: 24, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '800' }
});
