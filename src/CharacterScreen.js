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
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Buffer } from 'buffer';
import { CharacterCard } from 'parsecard';

import { useApp } from './context/AppContext';

function getPickedAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

function assetLooksLike(asset, ext, mimes) {
  const mime = String(asset?.mimeType || '').toLowerCase();
  const name = String(asset?.name || asset?.uri || '').toLowerCase();
  return mimes.includes(mime) || name.endsWith(ext);
}

function isPngBuffer(buffer) {
  return (
    buffer
    && buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  );
}

function extractCardFields(card) {
  const data = card?.data && typeof card.data === 'object' ? card.data : {};
  const name = String(card?.name || data.name || '').trim();
  const description = String(
    card?.description || data.description || ''
  ).trim();
  return { name, description };
}

function parseJsonCard(text) {
  const raw = JSON.parse(text);
  const card = CharacterCard.fromJSON(raw);
  const fromClass = extractCardFields(card);
  if (fromClass.name) return fromClass;
  return extractCardFields(raw);
}

function parsePngCard(buffer) {
  const card = CharacterCard.fromPNG(Uint8Array.from(buffer));
  return extractCardFields(card);
}

export default function CharacterScreen() {
  const { character, loaded, updateCharacter } = useApp();
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [importing, setImporting] = useState(false);
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
    try {
      await updateCharacter(next);
      setName(next.name);
      setSystemPrompt(next.systemPrompt);
      Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');
    } catch (error) {
      return;
    }
  };

  const importCard = async () => {
    if (importing) return;
    setImporting(true);

    try {
      let result;
      try {
        result = await DocumentPicker.getDocumentAsync({
          type: ['image/png', 'application/json'],
          copyToCacheDirectory: true,
          multiple: false,
        });
      } catch (error) {
        Alert.alert('文件读取错误，请重试');
        return;
      }

      const asset = getPickedAsset(result);
      if (!asset?.uri) return;

      let buffer;
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        buffer = Buffer.from(base64, 'base64');
      } catch (error) {
        Alert.alert('文件读取错误，请重试');
        return;
      }

      const isPng = assetLooksLike(asset, '.png', ['image/png', 'image/x-png']);
      const isJson = assetLooksLike(asset, '.json', ['application/json', 'text/json']);

      let parsed;
      try {
        if (isPngBuffer(buffer) || (isPng && !isJson)) {
          parsed = parsePngCard(buffer);
        } else {
          parsed = parseJsonCard(buffer.toString('utf8'));
        }
      } catch (error) {
        Alert.alert('角色卡解析失败，请确认文件格式是否正确');
        return;
      }

      if (!parsed?.name) {
        Alert.alert('角色卡解析失败，请确认文件格式是否正确');
        return;
      }

      const next = {
        name: parsed.name,
        systemPrompt: parsed.description || character.systemPrompt || '',
      };

      try {
        await updateCharacter(next);
        setName(next.name);
        setSystemPrompt(next.systemPrompt);
        Alert.alert('导入成功', `已加载角色：${next.name}`);
      } catch (error) {
        return;
      }
    } finally {
      setImporting(false);
    }
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
        <TouchableOpacity
          style={[styles.importButton, importing && styles.buttonDisabled]}
          onPress={importCard}
          disabled={importing}
        >
          <Text style={styles.importButtonText}>
            {importing ? '导入中...' : '导入角色卡'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.importHint}>支持 SillyTavern PNG / JSON 角色卡。</Text>
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
  buttonText: { color: '#fff', fontWeight: '800' },
  importButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#6c63ff',
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    alignItems: 'center',
  },
  importButtonText: { color: '#c8c4ff', fontWeight: '800' },
  importHint: { color: '#888', fontSize: 12, marginTop: 8 },
  buttonDisabled: { opacity: 0.45 },
});
