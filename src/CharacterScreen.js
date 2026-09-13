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

import { parseCardFromJson, parseCardFromPng } from './cardParser';
import { useApp } from './context/AppContext';
import { maskSecrets } from './secrets';

const NO_CARD_DATA_MESSAGE =
  '该图片不包含角色卡数据，请上传 RP-Hub 导出的 JSON 文件或含数据的 PNG 图片。';

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

function hasCardContent(card) {
  if (!card) return false;
  if (card.name) return true;
  if (card.systemPrompt) return true;
  if (card.worldInfo?.length) return true;
  if (card.regexScripts?.length) return true;
  const fields = card.fields || {};
  return Boolean(
    fields.description
    || fields.personality
    || fields.scenario
    || fields.firstMes
    || fields.mesExample
    || fields.creatorNotes
    || fields.postHistoryInstructions
  );
}

function buildCharacterPatch(card) {
  const fields = card.fields || {};
  return {
    id: `card-${Date.now().toString(36)}`,
    name: card.name || '导入角色',
    systemPrompt: card.systemPrompt || '',
    description: fields.description || '',
    personality: fields.personality || '',
    scenario: fields.scenario || '',
    firstMes: fields.firstMes || '',
    mesExample: fields.mesExample || '',
    creatorNotes: fields.creatorNotes || '',
    postHistoryInstructions: fields.postHistoryInstructions || '',
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    worldInfo: Array.isArray(card.worldInfo) ? card.worldInfo : [],
    regexScripts: Array.isArray(card.regexScripts) ? card.regexScripts : [],
  };
}

function DataField({ label, value }) {
  if (!value) return null;
  return (
    <View style={styles.dataField}>
      <Text style={styles.dataFieldLabel}>{label}</Text>
      <Text style={styles.dataFieldValue} numberOfLines={6}>{value}</Text>
    </View>
  );
}

function WorldInfoList({ entries }) {
  if (!entries || entries.length === 0) {
    return <Text style={styles.dataEmpty}>未导入世界书条目。</Text>;
  }
  return entries.map(entry => (
    <View key={`world-${entry.id}`} style={styles.dataCard}>
      <Text style={styles.dataTitle}>{entry.comment}</Text>
      <Text style={styles.dataMeta}>
        {entry.constant ? '常驻' : '关键词触发'}
        {' · '}
        {entry.enabled ? '启用' : '停用'}
        {' · '}
        {entry.positionLabel}
        {' · 顺序 '}
        {entry.order}
        {entry.position === 4 ? ` · 深度 ${entry.depth}` : ''}
      </Text>
      {entry.keys.length ? (
        <Text style={styles.dataMeta}>关键词：{entry.keys.join('、')}</Text>
      ) : null}
      {entry.content ? (
        <Text style={styles.dataContent} numberOfLines={4}>{entry.content}</Text>
      ) : null}
    </View>
  ));
}

function RegexScriptList({ scripts }) {
  if (!scripts || scripts.length === 0) {
    return <Text style={styles.dataEmpty}>未导入正则脚本。</Text>;
  }
  return scripts.map(script => (
    <View key={`regex-${script.id}`} style={styles.dataCard}>
      <Text style={styles.dataTitle}>{script.name}</Text>
      <Text style={styles.dataMeta}>
        {script.enabled ? '启用' : '停用'}
        {' · '}
        {script.placementLabel}
        {' · flags '}
        {script.flags}
        {script.markdownOnly ? ' · 仅显示' : ''}
        {script.promptOnly ? ' · 仅提示词' : ''}
      </Text>
      {script.findRegex ? (
        <Text style={styles.dataCode} numberOfLines={2}>{script.findRegex}</Text>
      ) : null}
      {script.replaceString ? (
        <Text style={styles.dataMeta} numberOfLines={2}>替换为：{script.replaceString}</Text>
      ) : null}
    </View>
  ));
}

export default function CharacterScreen() {
  const { character, loaded, updateCharacter } = useApp();
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [personality, setPersonality] = useState('');
  const [scenario, setScenario] = useState('');
  const [firstMes, setFirstMes] = useState('');
  const [importing, setImporting] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (loaded && !seededRef.current) {
      seededRef.current = true;
      setName(character.name || '');
      setSystemPrompt(character.systemPrompt || '');
      setDescription(character.description || '');
      setPersonality(character.personality || '');
      setScenario(character.scenario || '');
      setFirstMes(character.firstMes || '');
    }
  }, [loaded, character]);

  const save = async () => {
    if (!loaded) {
      Alert.alert('角色加载中', '请稍候再保存。');
      return;
    }
    const next = {
      id: character.id || 'default',
      name: name.trim() || 'EasyChat2 助手',
      systemPrompt: systemPrompt.trim() || '你是 EasyChat2 的智能助手，回答简洁清晰。',
      description: description.trim(),
      personality: personality.trim(),
      scenario: scenario.trim(),
      firstMes: firstMes.trim(),
    };
    try {
      await updateCharacter(next);
      setName(next.name);
      setSystemPrompt(next.systemPrompt);
      setDescription(next.description);
      setPersonality(next.personality);
      setScenario(next.scenario);
      setFirstMes(next.firstMes);
      Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  };

  const importCard = async () => {
    if (importing || !loaded) return;
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
      const treatAsPng = isPngBuffer(buffer) || (isPng && !isJson);

      let parsed;
      try {
        parsed = treatAsPng
          ? parseCardFromPng(buffer)
          : parseCardFromJson(buffer.toString('utf8'));
      } catch (error) {
        const detail = maskSecrets(error?.message || String(error));
        console.warn('[角色卡导入] 解析失败：', detail);
        Alert.alert('角色卡解析失败', detail || '请确认文件格式是否正确。');
        return;
      }

      if (treatAsPng && parsed === null) {
        Alert.alert('无法导入', NO_CARD_DATA_MESSAGE);
        return;
      }

      if (!hasCardContent(parsed)) {
        Alert.alert('无法导入', '未从文件中识别到角色内容，请确认卡片结构是否完整。');
        return;
      }

      const next = buildCharacterPatch(parsed);
      try {
        await updateCharacter(next);
        setName(next.name);
        setSystemPrompt(next.systemPrompt);
        setDescription(next.description);
        setPersonality(next.personality);
        setScenario(next.scenario);
        setFirstMes(next.firstMes);
        const summary = [
          `已加载角色：${next.name}`,
          `世界书 ${next.worldInfo.length} 条`,
          `正则 ${next.regexScripts.length} 条`,
        ].join('，');
        Alert.alert('导入成功', summary);
      } catch (error) {
        Alert.alert('导入失败', '请检查存储空间或权限。');
      }
    } finally {
      setImporting(false);
    }
  };

  const card = character || {};
  const hasPanelData = Boolean(
    card.worldInfo?.length
    || card.regexScripts?.length
    || card.mesExample
    || card.creatorNotes
    || card.postHistoryInstructions
    || card.tags?.length
  );

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
          style={[styles.importButton, (importing || !loaded) && styles.buttonDisabled]}
          onPress={importCard}
          disabled={importing || !loaded}
        >
          <Text style={styles.importButtonText}>
            {importing ? '导入中...' : '导入角色卡'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.importHint}>支持 SillyTavern / RP-Hub 的 PNG / JSON 角色卡。</Text>
        <Text style={styles.label}>开场白</Text>
        <TextInput
          style={[styles.input, styles.multilineSmall]}
          value={firstMes}
          onChangeText={setFirstMes}
          placeholder="角色登场时的第一句话"
          placeholderTextColor="#888"
          multiline
          textAlignVertical="top"
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
        <Text style={styles.label}>角色描述</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="角色的背景、外貌与身份设定"
          placeholderTextColor="#888"
          multiline
          textAlignVertical="top"
        />
        <Text style={styles.label}>性格</Text>
        <TextInput
          style={[styles.input, styles.multilineSmall]}
          value={personality}
          onChangeText={setPersonality}
          placeholder="角色的性格特点"
          placeholderTextColor="#888"
          multiline
          textAlignVertical="top"
        />
        <Text style={styles.label}>场景</Text>
        <TextInput
          style={[styles.input, styles.multilineSmall]}
          value={scenario}
          onChangeText={setScenario}
          placeholder="剧情发生的背景与情境"
          placeholderTextColor="#888"
          multiline
          textAlignVertical="top"
        />
        <TouchableOpacity
          style={[styles.button, !loaded && styles.buttonDisabled]}
          onPress={save}
          disabled={!loaded}
        >
          <Text style={styles.buttonText}>保存角色</Text>
        </TouchableOpacity>

        {hasPanelData ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>导入数据</Text>

            {card.mesExample || card.creatorNotes || card.postHistoryInstructions ? (
                <View style={styles.dataSection}>
                  <Text style={styles.sectionTitle}>其他资料</Text>
                  <DataField label="对话示例" value={card.mesExample} />
                  <DataField label="作者注释" value={card.creatorNotes} />
                  <DataField label="历史后指令" value={card.postHistoryInstructions} />
                </View>
              ) : null}

            {card.tags?.length ? (
              <View style={styles.dataSection}>
                <Text style={styles.sectionTitle}>标签</Text>
                <Text style={styles.dataMeta}>{card.tags.join('、')}</Text>
              </View>
            ) : null}

            <View style={styles.dataSection}>
              <Text style={styles.sectionTitle}>
                世界书（{card.worldInfo?.length || 0} 条）
              </Text>
              <WorldInfoList entries={card.worldInfo} />
            </View>

            <View style={styles.dataSection}>
              <Text style={styles.sectionTitle}>
                正则脚本（{card.regexScripts?.length || 0} 条）
              </Text>
              <RegexScriptList scripts={card.regexScripts} />
            </View>
          </View>
        ) : null}

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
  multilineSmall: { minHeight: 80 },
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
  panel: { marginTop: 28, borderTopWidth: 1, borderTopColor: '#2d2d44', paddingTop: 18 },
  panelTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  dataSection: { marginTop: 16 },
  sectionTitle: { color: '#c8c4ff', fontWeight: '800', marginBottom: 8 },
  dataField: { marginBottom: 10 },
  dataFieldLabel: { color: '#888', fontSize: 12, marginBottom: 2 },
  dataFieldValue: { color: '#e6e6ef', fontSize: 14, lineHeight: 20 },
  dataEmpty: { color: '#888', fontSize: 13 },
  dataCard: {
    backgroundColor: '#24243b',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  dataTitle: { color: '#fff', fontWeight: '700', marginBottom: 4 },
  dataMeta: { color: '#aaa', fontSize: 12, lineHeight: 18 },
  dataContent: { color: '#d9d9e6', fontSize: 13, lineHeight: 19, marginTop: 6 },
  dataCode: {
    color: '#ffd479',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
