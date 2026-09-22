import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FIELD_LABELS, FORGE_FIELDS, createForgeDraft } from './cardForge/forge';
import { FieldGroup, PrimaryButton, SecondaryButton, TextField } from './ui';
import { useTheme } from './theme/ThemeContext';

const MULTILINE_FIELDS = new Set([
  'description',
  'personality',
  'scenario',
  'firstMes',
  'mesExample',
  'creatorNotes',
  'postHistoryInstructions',
]);

const PLACEHOLDERS = {
  name: '例如：晚星',
  description: '外貌、身份、背景…',
  personality: '性格与说话方式…',
  scenario: '故事背景与你们的关系…',
  firstMes: '角色主动说的第一句话…',
  mesExample: '{{user}}：在吗\n晚星：在的',
  creatorNotes: '给用户的使用建议…',
  postHistoryInstructions: '给模型的持续要求…',
};

export default function CardForgeEditor({ visible, draft, onClose, onSave }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [form, setForm] = useState(() => ({ ...createForgeDraft(), ...(draft || {}) }));
  const [tagText, setTagText] = useState('');
  const wasVisibleRef = useRef(false);

  // 只在"打开的那一刻"用最新草稿填充：弹窗开着时草稿若被 AI 回复更新，
  // 不能把用户正在输入的内容冲掉。
  useEffect(() => {
    const justOpened = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!justOpened) return;
    const next = { ...createForgeDraft(), ...(draft || {}) };
    setForm(next);
    setTagText(Array.isArray(next.tags) ? next.tags.join('、') : '');
  }, [draft, visible]);

  const save = () => {
    const tags = tagText
      .split(/[、,，\s]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 10);
    onSave({ ...form, tags });
  };

  // 这些字段不参与 AI 改写，只随草稿原样保留；有内容时提示一下，避免用户以为丢了
  const greetings = Array.isArray(draft && draft.alternateGreetings) ? draft.alternateGreetings.length : 0;
  const worldCount = Array.isArray(draft && draft.worldInfo) ? draft.worldInfo.length : 0;
  const regexCount = Array.isArray(draft && draft.regexScripts) ? draft.regexScripts.length : 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>当前角色卡</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>直接在这里改也可以，保存后会写回制卡草稿。</Text>
          {FORGE_FIELDS.map(key => (
            <FieldGroup key={key} label={FIELD_LABELS[key] || key}>
              <TextField
                value={String(form[key] || '')}
                onChangeText={value => setForm(current => ({ ...current, [key]: value }))}
                placeholder={PLACEHOLDERS[key] || ''}
                multiline={MULTILINE_FIELDS.has(key)}
              />
            </FieldGroup>
          ))}
          <FieldGroup label="系统提示" hint="原样保留，AI 不会改写它；需要时可以在这里手动调整">
            <TextField
              value={String(form.systemPrompt || '')}
              onChangeText={value => setForm(current => ({ ...current, systemPrompt: value }))}
              placeholder="例如：始终保持这个角色的说话方式，不要替用户行动"
              multiline
            />
          </FieldGroup>
          <FieldGroup label="标签" hint="用顿号或逗号分隔，最多 10 个">
            <TextField value={tagText} onChangeText={setTagText} placeholder="例如：治愈、日常" />
          </FieldGroup>
          {greetings + worldCount + regexCount > 0 ? (
            <Text style={styles.preserved}>
              {`已保留：备用开场白 ${greetings} 条 · 世界书 ${worldCount} 条 · 正则 ${regexCount} 条`}
            </Text>
          ) : null}
        </ScrollView>
        <View style={styles.footer}>
          <SecondaryButton title="取消" onPress={onClose} style={styles.footerButton} />
          <PrimaryButton title="保存" onPress={save} style={styles.footerButton} />
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 24 },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.md,
  },
  preserved: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.md,
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl,
    paddingTop: tokens.spacing.sm,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  footerButton: { flex: 1, marginHorizontal: 4 },
});
