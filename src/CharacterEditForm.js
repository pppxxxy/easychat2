import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import Ionicons from '@expo/vector-icons/Ionicons';

import { buildSystemPrompt } from './cardParser';
import { useApp } from './context/AppContext';
import { FieldHint, FieldLabel, TextField } from './ui';
import { useTheme } from './theme/ThemeContext';

function getPickedAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

function emptyDraft(character) {
  return {
    name: String(character?.name || ''),
    systemPrompt: String(character?.systemPrompt || ''),
    description: String(character?.description || ''),
    personality: String(character?.personality || ''),
    scenario: String(character?.scenario || ''),
    firstMes: String(character?.firstMes || ''),
    alternateGreetings: Array.isArray(character?.alternateGreetings)
      ? character.alternateGreetings.map(String)
      : [],
    mesExample: String(character?.mesExample || ''),
    nudgeText: String(character?.nudgeText || ''),
    tags: Array.isArray(character?.tags) ? character.tags.map(String) : [],
    avatarUri: String(character?.avatarUri || ''),
    bgUri: String(character?.bgUri || ''),
  };
}

export default function CharacterEditForm({ visible, character, onClose, onSaved }) {
  const { updateCharacter } = useApp();
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [draft, setDraft] = useState(() => emptyDraft(character));
  const [tagDraft, setTagDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const sessionRef = useRef(0);
  const characterId = character?.id || '';

  useEffect(() => {
    if (!visible) return;
    sessionRef.current += 1;
    setDraft(emptyDraft(character));
    setTagDraft('');
  }, [visible, characterId]);

  const patch = useMemo(() => (key, value) => {
    setDraft(current => ({ ...current, [key]: value }));
  }, []);

  const pickImage = async key => {
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
      const dest = `${dir}${characterId || 'chat'}-${key}-${Date.now()}${ext}`;
      await FileSystem.copyAsync({ from: asset.uri, to: dest });
      patch(key, dest);
    } catch (error) {
      Alert.alert('图片读取失败', '请重试。');
    }
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    if ((draft.tags || []).includes(tag)) {
      setTagDraft('');
      return;
    }
    patch('tags', [...draft.tags, tag]);
    setTagDraft('');
  };

  const removeTag = tag => {
    patch('tags', draft.tags.filter(item => item !== tag));
  };

  const addGreeting = () => {
    patch('alternateGreetings', [...draft.alternateGreetings, '']);
  };

  const updateGreeting = (index, value) => {
    patch(
      'alternateGreetings',
      draft.alternateGreetings.map((item, i) => (i === index ? value : item))
    );
  };

  const removeGreeting = index => {
    patch('alternateGreetings', draft.alternateGreetings.filter((_, i) => i !== index));
  };

  const save = async () => {
    if (saving) return;
    const session = sessionRef.current;
    const trimmedPrompt = draft.systemPrompt.trim();
    const next = {
      id: characterId || 'default',
      name: draft.name.trim() || 'EasyChat2 助手',
      systemPrompt: trimmedPrompt || '你是 EasyChat2 的智能助手，回答简洁清晰。',
      systemPromptComposed: buildSystemPrompt({
        description: draft.description.trim(),
        personality: draft.personality.trim(),
        scenario: draft.scenario.trim(),
        systemPrompt: trimmedPrompt,
        postHistoryInstructions: character?.postHistoryInstructions,
      }),
      description: draft.description.trim(),
      personality: draft.personality.trim(),
      scenario: draft.scenario.trim(),
      firstMes: draft.firstMes.trim(),
      alternateGreetings: draft.alternateGreetings
        .map(item => String(item || '').trim())
        .filter(Boolean),
      mesExample: draft.mesExample.trim(),
      nudgeText: draft.nudgeText.trim(),
      tags: draft.tags,
      avatarUri: draft.avatarUri || '',
      bgUri: draft.bgUri || '',
    };
    setSaving(true);
    try {
      await updateCharacter(next);
      if (sessionRef.current === session) {
        if (typeof onSaved === 'function') onSaved(next);
      }
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限，已填内容不会丢失。');
    } finally {
      if (sessionRef.current === session) setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>编辑角色</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <FieldLabel style={styles.label}>角色名</FieldLabel>
            <TextField
              value={draft.name}
              onChangeText={text => patch('name', text)}
              placeholder="例如：严谨的代码助手"
            />

            <FieldLabel style={styles.label}>角色头像</FieldLabel>
            <View style={styles.imageRow}>
              <View style={styles.avatarBox}>
                {draft.avatarUri ? (
                  <Image source={{ uri: draft.avatarUri }} style={styles.avatarImage} />
                ) : (
                  <View style={styles.avatarPlaceholder}>
                    <Text style={styles.avatarPlaceholderText}>
                      {(draft.name || '?').charAt(0)}
                    </Text>
                  </View>
                )}
              </View>
              <View style={styles.imageActions}>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => pickImage('avatarUri')}
                  activeOpacity={0.8}
                >
                  <Text style={styles.smallButtonText}>{draft.avatarUri ? '更换' : '选择头像'}</Text>
                </TouchableOpacity>
                {draft.avatarUri ? (
                  <TouchableOpacity onPress={() => patch('avatarUri', '')} hitSlop={8}>
                    <Text style={styles.removeText}>清除</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            <FieldLabel style={styles.label}>背景图</FieldLabel>
            <View style={styles.imageRow}>
              {draft.bgUri ? (
                <Image source={{ uri: draft.bgUri }} style={styles.bgPreview} />
              ) : null}
              <View style={styles.imageActions}>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => pickImage('bgUri')}
                  activeOpacity={0.8}
                >
                  <Text style={styles.smallButtonText}>{draft.bgUri ? '更换' : '选择背景'}</Text>
                </TouchableOpacity>
                {draft.bgUri ? (
                  <TouchableOpacity onPress={() => patch('bgUri', '')} hitSlop={8}>
                    <Text style={styles.removeText}>清除</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            <FieldLabel style={styles.label}>人设 / 系统提示词</FieldLabel>
            <TextField
              style={styles.multiline}
              value={draft.systemPrompt}
              onChangeText={text => patch('systemPrompt', text)}
              placeholder="描述角色的语气、知识和回答方式"
              multiline
              textAlignVertical="top"
            />
            <FieldLabel style={styles.label}>角色描述</FieldLabel>
            <TextField
              style={styles.multiline}
              value={draft.description}
              onChangeText={text => patch('description', text)}
              placeholder="角色的背景、外貌与身份设定"
              multiline
              textAlignVertical="top"
            />
            <FieldLabel style={styles.label}>性格</FieldLabel>
            <TextField
              style={styles.multilineSmall}
              value={draft.personality}
              onChangeText={text => patch('personality', text)}
              placeholder="角色的性格特点"
              multiline
              textAlignVertical="top"
            />
            <FieldLabel style={styles.label}>场景</FieldLabel>
            <TextField
              style={styles.multilineSmall}
              value={draft.scenario}
              onChangeText={text => patch('scenario', text)}
              placeholder="剧情发生的背景与情境"
              multiline
              textAlignVertical="top"
            />
            <FieldLabel style={styles.label}>开场白</FieldLabel>
            <TextField
              style={styles.multilineSmall}
              value={draft.firstMes}
              onChangeText={text => patch('firstMes', text)}
              placeholder="角色登场时的第一句话"
              multiline
              textAlignVertical="top"
            />

            <FieldLabel style={styles.label}>备用开场白</FieldLabel>
            {draft.alternateGreetings.map((item, index) => (
              <View key={`greeting-${index}`} style={styles.greetingRow}>
                <TextField
                  style={[styles.multilineSmall, styles.greetingInput]}
                  value={item}
                  onChangeText={value => updateGreeting(index, value)}
                  placeholder={`备用开场白 ${index + 1}`}
                  multiline
                  textAlignVertical="top"
                />
                <TouchableOpacity
                  style={styles.greetingRemove}
                  onPress={() => removeGreeting(index)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="删除备用开场白"
                >
                  <Ionicons name="close" size={16} color={theme.colors.dangerSoft} />
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.secondaryButton} onPress={addGreeting} activeOpacity={0.8}>
              <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.secondaryButtonText}>添加备用开场白</Text>
            </TouchableOpacity>

            <FieldLabel style={styles.label}>对话示例</FieldLabel>
            <TextField
              style={styles.multiline}
              value={draft.mesExample}
              onChangeText={text => patch('mesExample', text)}
              placeholder="<START>\n{{user}}: 你好\n{{char}}: 你好呀"
              multiline
              textAlignVertical="top"
            />
            <FieldHint style={styles.hint}>对话示例会作为示范注入系统提示词，可用 {`{{user}}`} 与 {`{{char}}`} 占位。</FieldHint>

            <FieldLabel style={styles.label}>拍一拍文案</FieldLabel>
            <TextField
              value={draft.nudgeText}
              onChangeText={text => patch('nudgeText', text)}
              placeholder="{user} 戳了戳 {char}"
            />
            <FieldHint style={styles.hint}>双击角色头像时显示，可用 {`{{user}}`} 与 {`{{char}}`} 占位；留空使用默认文案。</FieldHint>

            <FieldLabel style={styles.label}>标签</FieldLabel>
            <View style={styles.tagRow}>
              {draft.tags.map(tag => (
                <TouchableOpacity
                  key={tag}
                  style={styles.tagChip}
                  onPress={() => removeTag(tag)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.tagChipText}>{tag}</Text>
                  <Ionicons name="close" size={12} color={theme.colors.primarySoft} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.tagInputRow}>
              <TextField
                style={styles.tagInput}
                value={tagDraft}
                onChangeText={setTagDraft}
                onSubmitEditing={addTag}
                placeholder="输入标签后回车添加"
                returnKeyType="done"
              />
              <TouchableOpacity style={styles.tagAdd} onPress={addTag} activeOpacity={0.8}>
                <Ionicons name="add" size={18} color={theme.colors.primaryContrast} />
              </TouchableOpacity>
            </View>
            <FieldHint style={styles.hint}>世界书与正则脚本请在「角色」页编辑。</FieldHint>
          </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.footerGhost}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Text style={styles.footerGhostText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.footerPrimary, saving && styles.footerDisabled]}
              onPress={save}
              disabled={saving}
              activeOpacity={0.85}
            >
              <Ionicons name="save-outline" size={16} color={theme.colors.text} />
              <Text style={styles.footerPrimaryText}>{saving ? '保存中...' : '保存'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: theme.colors.overlay,
  },
  sheet: {
    maxHeight: '92%',
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  headerTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '600' },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 },
  label: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    marginTop: 14,
    marginBottom: 6,
  },
  multiline: { minHeight: 90, paddingTop: 10 },
  multilineSmall: { minHeight: 64, paddingTop: 10 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 6, lineHeight: fonts.scaled(17) },
  imageRow: { flexDirection: 'row', alignItems: 'center' },
  avatarBox: {
    width: 64,
    height: 64,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(22) },
  bgPreview: {
    width: 96,
    height: 64,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  imageActions: { marginLeft: 12 },
  smallButton: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  smallButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  removeText: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(13), marginTop: 8 },
  greetingRow: { flexDirection: 'row', alignItems: 'flex-start' },
  greetingInput: { flex: 1 },
  greetingRemove: { paddingLeft: 10, paddingTop: 12 },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  secondaryButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), marginLeft: 6 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap' },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  tagChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginRight: 4 },
  tagInputRow: { flexDirection: 'row', alignItems: 'center' },
  tagInput: { flex: 1, minHeight: 40 },
  tagAdd: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 24 : 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  footerGhost: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 10,
  },
  footerGhostText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  footerPrimary: {
    flex: 1.4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
  },
  footerPrimaryText: { color: theme.colors.text, fontSize: fonts.scaled(14), marginLeft: 6 },
  footerDisabled: { opacity: 0.6 },
});
