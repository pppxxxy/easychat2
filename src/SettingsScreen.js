import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { getApiConfig, saveApiConfig } from './storage';

export default function SettingsScreen() {
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    getApiConfig().then(config => {
      setBaseUrl(config.baseUrl || 'https://api.deepseek.com');
      setModel(config.model || 'deepseek-chat');
      setApiKey(config.apiKey || '');
    });
  }, []);

  const save = async () => {
    await saveApiConfig({ baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() });
    Alert.alert('已保存', 'API 配置已保存到本机。');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>设置</Text>
      <Text style={styles.label}>API 地址</Text>
      <TextInput style={styles.input} value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" placeholderTextColor="#888" />
      <Text style={styles.label}>模型</Text>
      <TextInput style={styles.input} value={model} onChangeText={setModel} autoCapitalize="none" placeholderTextColor="#888" />
      <Text style={styles.label}>API Key</Text>
      <TextInput style={styles.input} value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" placeholder="sk-..." placeholderTextColor="#888" />
      <TouchableOpacity style={styles.button} onPress={save}>
        <Text style={styles.buttonText}>保存配置</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 20 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 18 },
  label: { color: '#fff', marginTop: 14, marginBottom: 6, fontWeight: '700' },
  input: { backgroundColor: '#2d2d44', color: '#fff', padding: 12, borderRadius: 8 },
  button: { backgroundColor: '#6c63ff', padding: 14, borderRadius: 8, marginTop: 24, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '800' }
});
