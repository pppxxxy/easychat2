import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  FIELD_LABELS,
  FORGE_FIELDS,
  MAX_FORGE_TAG_COUNT,
  buildFieldAssistPrompt,
  createForgeDraft,
  parseFieldAssistText,
} from './cardForge/forge';
import { createRegexScript, createWorldEntry } from './cardParser';
import { makeCharacterPresetId } from './characterPresets';
import { AIGC_META_FIELD, AIGC_NOTICE_TEXT, buildAigcMeta, isValidAigcMeta } from './aigc/attribution';
import { isCanceledError } from './api';
import { maskSecrets } from './secrets';
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

// 辅助生成可用的文本字段：AI 改写的基本盘 + 手动保留的系统提示。
const ASSIST_FIELDS = new Set([...FORGE_FIELDS, 'systemPrompt']);

function splitKeywords(text) {
  return String(text || '')
    .split(/[、,，]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function AssistButton({ onPress, label }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity
      style={styles.assistButton}
      onPress={onPress}
      activeOpacity={0.8}
      hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={`辅助生成${label}`}
    >
      <Ionicons name="sparkles-outline" size={12} color={theme.colors.primarySoft} />
      <Text style={styles.assistButtonText}>辅助生成</Text>
    </TouchableOpacity>
  );
}

export default function CardForgeEditor({ visible, draft, onClose, onSave, onAssistPrompt }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [form, setForm] = useState(() => ({ ...createForgeDraft(), ...(draft || {}) }));
  const [tagText, setTagText] = useState('');
  const [assistTarget, setAssistTarget] = useState(null);
  const [assistText, setAssistText] = useState('');
  const [assistBusy, setAssistBusy] = useState(false);
  const wasVisibleRef = useRef(false);
  const assistAbortRef = useRef(null);

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

  // 卸载时中止挂着的辅助生成请求，避免写回已卸载的表单。
  useEffect(() => () => {
    if (assistAbortRef.current) assistAbortRef.current.abort();
  }, []);

  const save = () => {
    const tags = tagText
      .split(/[、,，]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, MAX_FORGE_TAG_COUNT);
    onSave({ ...form, tags });
  };

  // ---- 集合编辑：世界书 / 正则 / 预设 ----
  const patchList = (key, updater) => {
    setForm(current => ({ ...current, [key]: updater(Array.isArray(current[key]) ? current[key] : []) }));
  };

  const updateEntry = (key, index, patch) => {
    patchList(key, list => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeEntry = (key, index) => {
    patchList(key, list => list.filter((_, i) => i !== index));
  };

  const worldInfo = Array.isArray(form.worldInfo) ? form.worldInfo : [];
  const regexScripts = Array.isArray(form.regexScripts) ? form.regexScripts : [];
  const presets = Array.isArray(form.presets) ? form.presets : [];

  const addWorldEntry = () => {
    patchList('worldInfo', list => [...list, createWorldEntry({
      id: `entry-${Date.now().toString(36)}`,
      comment: `世界书条目 ${list.length + 1}`,
    })]);
  };

  const addRegexScript = () => {
    patchList('regexScripts', list => [...list, createRegexScript({
      id: `regex-${Date.now().toString(36)}`,
      name: `正则脚本 ${list.length + 1}`,
    })]);
  };

  const addPreset = () => {
    patchList('presets', list => [...list, {
      id: makeCharacterPresetId(list),
      name: `预设 ${list.length + 1}`,
      prompt: '',
      enabled: true,
    }]);
  };

  // ---- 单字段辅助生成 ----
  const openAssist = key => {
    if (assistBusy) return;
    setAssistTarget({ key, label: FIELD_LABELS[key] || key });
    setAssistText('');
  };

  const closeAssist = () => {
    if (assistAbortRef.current) {
      assistAbortRef.current.abort();
      assistAbortRef.current = null;
    }
    setAssistBusy(false);
    setAssistTarget(null);
    setAssistText('');
  };

  const submitAssist = async () => {
    const target = assistTarget;
    const request = assistText.trim();
    if (!target || !request) {
      Alert.alert('请先描述想修改的地方', '例如：把性格改得更傲娇一些。');
      return;
    }
    if (typeof onAssistPrompt !== 'function') {
      Alert.alert('功能不可用', '当前没有可用的模型配置。');
      return;
    }
    const controller = new AbortController();
    assistAbortRef.current = controller;
    setAssistBusy(true);
    try {
      const prompt = buildFieldAssistPrompt({
        fieldLabel: target.label,
        currentValue: form[target.key],
        request,
      });
      const raw = await onAssistPrompt(prompt, controller.signal);
      const nextValue = parseFieldAssistText(raw);
      if (nextValue === null) {
        Alert.alert('生成失败', 'AI 没有返回有效内容，请重试。');
        return;
      }
      const appliedKey = target.key;
      setForm(current => ({
        ...current,
        [appliedKey]: nextValue,
        // 字段级 AI 改写同样是生成内容：更新标识（source 区分整卡生成与字段辅助）
        [AIGC_META_FIELD]: buildAigcMeta({ source: 'easychat2-field-assist' }),
      }));
      closeAssist();
    } catch (error) {
      if (isCanceledError(error)) return;
      Alert.alert('生成失败', maskSecrets((error && error.message) || '请稍后重试。'));
    } finally {
      if (assistAbortRef.current === controller) {
        assistAbortRef.current = null;
        setAssistBusy(false);
      }
    }
  };

  const assistLabel = assistTarget ? (FIELD_LABELS[assistTarget.key] || assistTarget.label) : '';

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
          <Text style={styles.hint}>直接在这里改也可以，保存后会写回制卡草稿。字段旁的「辅助生成」可以按你的描述让 AI 改写。</Text>
          <Text style={styles.aigcNotice}>{`· ${AIGC_NOTICE_TEXT}：AI 生成/改写的卡片内容会随导出文件携带生成标识。`}</Text>
          {isValidAigcMeta(form[AIGC_META_FIELD]) ? (
            <Text style={styles.aigcBadge}>{`本卡由 AI 生成 · 内容编号 ${form[AIGC_META_FIELD].contentCode || ''}`}</Text>
          ) : null}
          {FORGE_FIELDS.map(key => (
            <FieldGroup
              key={key}
              label={FIELD_LABELS[key] || key}
              action={ASSIST_FIELDS.has(key) ? <AssistButton label={FIELD_LABELS[key] || key} onPress={() => openAssist(key)} /> : null}
            >
              <TextField
                value={String(form[key] || '')}
                onChangeText={value => setForm(current => ({ ...current, [key]: value }))}
                placeholder={PLACEHOLDERS[key] || ''}
                multiline={MULTILINE_FIELDS.has(key)}
              />
            </FieldGroup>
          ))}
          <FieldGroup
            label="系统提示"
            hint="原样保留，AI 不会改写它；需要时可以在这里手动调整"
            action={<AssistButton label="系统提示" onPress={() => openAssist('systemPrompt')} />}
          >
            <TextField
              value={String(form.systemPrompt || '')}
              onChangeText={value => setForm(current => ({ ...current, systemPrompt: value }))}
              placeholder="例如：始终保持这个角色的说话方式，不要替用户行动"
              multiline
            />
          </FieldGroup>
          <FieldGroup label="标签" hint={`用顿号或逗号分隔，最多 ${MAX_FORGE_TAG_COUNT} 个`}>
            <TextField value={tagText} onChangeText={setTagText} placeholder="例如：治愈、日常" />
          </FieldGroup>

          <FieldGroup label="世界书条目" hint="命中关键词后注入提示词">
            {worldInfo.length === 0 ? (
              <Text style={styles.emptyText}>还没有世界书条目。</Text>
            ) : worldInfo.map((entry, index) => (
              <View key={entry.id || `world-${index}`} style={styles.entryCard}>
                <View style={styles.entryHeader}>
                  <Text style={styles.entryTitle} numberOfLines={1}>
                    {entry.comment || `条目 ${index + 1}`}
                  </Text>
                  <TouchableOpacity onPress={() => removeEntry('worldInfo', index)} hitSlop={8} accessibilityLabel="删除世界书条目">
                    <Text style={styles.removeText}>删除</Text>
                  </TouchableOpacity>
                </View>
                <TextField
                  style={styles.entryInput}
                  value={String(entry.comment || '')}
                  onChangeText={comment => updateEntry('worldInfo', index, { comment })}
                  placeholder="条目名称"
                />
                <TextField
                  style={styles.entryInput}
                  value={(Array.isArray(entry.keys) ? entry.keys : []).join(', ')}
                  onChangeText={text => updateEntry('worldInfo', index, { keys: splitKeywords(text) })}
                  placeholder="触发关键词（逗号分隔）"
                />
                <TextField
                  style={styles.entryContent}
                  value={String(entry.content || '')}
                  onChangeText={content => updateEntry('worldInfo', index, { content })}
                  placeholder="命中后注入的内容"
                  multiline
                />
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>常驻（无需关键词）</Text>
                  <Switch
                    value={entry.constant === true}
                    onValueChange={constant => updateEntry('worldInfo', index, { constant })}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>启用</Text>
                  <Switch
                    value={entry.enabled !== false}
                    onValueChange={enabled => updateEntry('worldInfo', index, { enabled })}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
              </View>
            ))}
            <SecondaryButton title="添加世界书条目" onPress={addWorldEntry} small />
          </FieldGroup>

          <FieldGroup label="正则脚本" hint="对展示文本或发送提示词做替换">
            {regexScripts.length === 0 ? (
              <Text style={styles.emptyText}>还没有正则脚本。</Text>
            ) : regexScripts.map((script, index) => (
              <View key={script.id || `regex-${index}`} style={styles.entryCard}>
                <View style={styles.entryHeader}>
                  <Text style={styles.entryTitle} numberOfLines={1}>
                    {script.name || `脚本 ${index + 1}`}
                  </Text>
                  <TouchableOpacity onPress={() => removeEntry('regexScripts', index)} hitSlop={8} accessibilityLabel="删除正则脚本">
                    <Text style={styles.removeText}>删除</Text>
                  </TouchableOpacity>
                </View>
                <TextField
                  style={styles.entryInput}
                  value={String(script.name || '')}
                  onChangeText={name => updateEntry('regexScripts', index, { name })}
                  placeholder="脚本名称"
                />
                <TextField
                  style={styles.entryInput}
                  value={String(script.findRegex || '')}
                  onChangeText={findRegex => updateEntry('regexScripts', index, { findRegex })}
                  placeholder="查找内容（或 /正则/ 标记）"
                />
                <TextField
                  style={styles.entryInput}
                  value={String(script.replaceString || '')}
                  onChangeText={replaceString => updateEntry('regexScripts', index, { replaceString })}
                  placeholder="替换为"
                />
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>仅替换展示</Text>
                  <Switch
                    value={script.markdownOnly === true}
                    onValueChange={markdownOnly => updateEntry('regexScripts', index, { markdownOnly })}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>仅用于发送提示词</Text>
                  <Switch
                    value={script.promptOnly === true}
                    onValueChange={promptOnly => updateEntry('regexScripts', index, { promptOnly })}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>启用</Text>
                  <Switch
                    value={script.enabled !== false}
                    onValueChange={enabled => updateEntry('regexScripts', index, { enabled })}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
              </View>
            ))}
            <SecondaryButton title="添加正则脚本" onPress={addRegexScript} small />
          </FieldGroup>

          <FieldGroup label="角色预设" hint="随提示词注入的文本预设">
            {presets.length === 0 ? (
              <Text style={styles.emptyText}>还没有预设。</Text>
            ) : presets.map((preset, index) => (
              <View key={preset.id || `preset-${index}`} style={styles.entryCard}>
                <View style={styles.entryHeader}>
                  <Text style={styles.entryTitle} numberOfLines={1}>
                    {preset.name || `预设 ${index + 1}`}
                  </Text>
                  <TouchableOpacity onPress={() => removeEntry('presets', index)} hitSlop={8} accessibilityLabel="删除预设">
                    <Text style={styles.removeText}>删除</Text>
                  </TouchableOpacity>
                </View>
                <TextField
                  style={styles.entryInput}
                  value={String(preset.name || '')}
                  onChangeText={name => updateEntry('presets', index, { name })}
                  placeholder="预设名称"
                />
                <TextField
                  style={styles.entryContent}
                  value={String(preset.prompt || '')}
                  onChangeText={prompt => updateEntry('presets', index, { prompt })}
                  placeholder="预设内容（注入提示词）"
                  multiline
                />
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>启用</Text>
                  <Switch
                    value={preset.enabled !== false}
                    onValueChange={enabled => updateEntry('presets', index, { enabled })}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
              </View>
            ))}
            <SecondaryButton title="添加预设" onPress={addPreset} small />
          </FieldGroup>

          <Text style={styles.preserved}>
            {`备用开场白 ${Array.isArray(form.alternateGreetings) ? form.alternateGreetings.length : 0} 条随草稿原样保留`}
          </Text>
        </ScrollView>
        <View style={styles.footer}>
          <SecondaryButton title="取消" onPress={onClose} style={styles.footerButton} />
          <PrimaryButton title="保存" onPress={save} style={styles.footerButton} />
        </View>
      </View>

      <Modal
        visible={!!assistTarget}
        transparent
        animationType="fade"
        onRequestClose={closeAssist}
      >
        <View style={styles.assistOverlay}>
          <View style={styles.assistCard}>
            <Text style={styles.assistTitle}>{`辅助生成「${assistLabel}」`}</Text>
            {assistTarget ? (
              <Text style={styles.assistCurrent} numberOfLines={3}>
                {`当前内容：${String(form[assistTarget.key] || '').trim() || '（空）'}`}
              </Text>
            ) : null}
            <TextField
              style={styles.assistInput}
              value={assistText}
              onChangeText={setAssistText}
              placeholder="描述想修改的地方，例如：把性格改得更傲娇一些"
              multiline
              autoFocus
            />
            {assistBusy ? (
              <View style={styles.assistBusyRow}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.assistBusyText}>AI 正在改写…</Text>
              </View>
            ) : null}
            <View style={styles.assistActions}>
              <SecondaryButton title="取消" onPress={closeAssist} style={styles.footerButton} />
              <PrimaryButton title="生成" onPress={submitAssist} disabled={assistBusy} style={styles.footerButton} />
            </View>
          </View>
        </View>
      </Modal>
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
  aigcNotice: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.xs,
  },
  aigcBadge: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginBottom: tokens.spacing.md,
  },
  assistButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: tokens.spacing.xs + 2,
    backgroundColor: theme.colors.surface,
  },
  assistButtonText: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginLeft: 3,
  },
  emptyText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginBottom: tokens.spacing.sm,
  },
  entryCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.md,
    marginBottom: tokens.spacing.md,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  entryTitle: {
    flex: 1,
    marginRight: tokens.spacing.sm,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
  },
  removeText: {
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
  },
  entryInput: {
    marginBottom: tokens.spacing.sm,
  },
  entryContent: {
    marginBottom: tokens.spacing.sm,
    minHeight: tokens.metrics.fieldHeight * 2,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  switchLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
  },
  assistOverlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  assistCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.lg,
  },
  assistTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '800',
    marginBottom: tokens.spacing.sm,
  },
  assistCurrent: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(17),
    marginBottom: tokens.spacing.sm,
  },
  assistInput: {
    minHeight: tokens.metrics.fieldHeight * 2,
    marginBottom: tokens.spacing.md,
  },
  assistBusyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: tokens.spacing.sm,
  },
  assistBusyText: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginLeft: tokens.spacing.sm,
  },
  assistActions: {
    flexDirection: 'row',
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
