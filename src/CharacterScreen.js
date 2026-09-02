import React, { useEffect, useRef, useState } from 'react';
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

import { useApp } from './context/AppContext';

export default function CharacterScreen() {
  const { character, loaded, updateCharacter } = useApp();
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const seededRef = useRef(false);

  useEffect(() => {
    if (loaded && !seededRef.current) {
      seededRef.current = true;
      setName(character.name || '');
      setSystemPrompt(character.systemPrompt || '');
    }
  }, [loaded, character]);

  const save = async () => {
    const next = {
      name: name.trim() || 'EasyChat2 助手',
      systemPrompt: systemPrompt.trim() || '你是 EasyChat2 的智能助手，回答简洁清晰。'
    };
    await updateCharacter(next);
    setName(next.name);
    setSystemPrompt(next.systemPrompt);
    Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>角色</Text>
        <Text style={styles.hint}>聊天时会把这里的设定作为系统提示词发送给模型。</Text>
        <Text style={styles.label}>角色名</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="例如：严谨的代码助手"
          placeholderTextColor="#888"
        />
        <Text style={styles.label}>人设 / 系统提示词</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={systemPrompt}
          onChangeText={setSystemPrompt}
          placeholder="描述角色的语气、知识和回答方式"
          placeholderTextColor="#888"
          multiline
          textAlignVertical="top"
        />
        <TouchableOpacity style={styles.button} onPress={save}>
          <Text style={styles.buttonText}>保存角色</Text>
        </TouchableOpacity>
        <View style={{ height: 24 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#1a1a2e' },
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 20 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 8 },
  hint: { color: '#aaa', fontSize: 14, lineHeight: 20, marginBottom: 12 },
  label: { color: '#fff', marginTop: 14, marginBottom: 6, fontWeight: '700' },
  input: { backgroundColor: '#2d2d44', color: '#fff', padding: 12, borderRadius: 8 },
  multiline: { minHeight: 160 },
  button: { backgroundColor: '#6c63ff', padding: 14, borderRadius: 8, marginTop: 24, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '800' }
});
