// 「自定义配色」编辑器：让用户逐个槽位改各界面/各组件的颜色，并保存成自己的主题。
//
// 为什么是「预置色板 + 十六进制输入」而不是色轮：仓库没有（也不想引入）原生取色器
// 依赖，纯 JS 的 HSV 色轮需要 PanResponder 手搓且在小屏上精度差。预置色板点两下就
// 能靠近已有风格，需要精确值时再填十六进制——两条路都不依赖新依赖。
//
// 只改基础槽位，派生 token（primaryAlpha / dangerSurface / accentText / successSurface…）
// 由 getTheme 从这些槽位算出，所以这里不需要（也不能）让用户分别调，否则会出现
// 「改了 primary 但用户气泡引用色没跟着变」这类互相打架的状态。

import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldLabel, FieldHint, TextField, GhostButton, SecondaryButton, PrimaryButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  CUSTOM_COLOR_FIELD_KEYS,
  CUSTOM_COLOR_GROUPS,
  CUSTOM_COLOR_PRESETS,
  isValidHexColor,
  resolveCustomColors,
} from '../theme/themes.js';

export default function CustomThemeModal({ visible, onClose, colors, onSave }) {
  const { t } = useTranslation();
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [draft, setDraft] = useState(() => resolveCustomColors(colors));
  const [hexText, setHexText] = useState({});
  const [editingField, setEditingField] = useState('');

  // 每次打开都从已保存值重开一份草稿：取消后再次进入不应残留上次未保存的改动。
  useEffect(() => {
    if (!visible) return;
    setDraft(resolveCustomColors(colors));
    setHexText({});
    setEditingField('');
  }, [visible, colors]);

  const setField = (field, value) => {
    setDraft(current => ({ ...current, [field]: value }));
    setHexText(current => ({ ...current, [field]: value }));
  };

  // 输入框允许「打字中间态」：只有合法十六进制才写进草稿，非法值只更新文本，
  // 这样用户能一路删到 # 再重打，而不是每敲一个字符就被格式化打断。
  const onHexChange = (field, text) => {
    setHexText(current => ({ ...current, [field]: text }));
    const trimmed = String(text || '').trim();
    if (isValidHexColor(trimmed)) {
      setDraft(current => ({ ...current, [field]: trimmed }));
    }
  };

  const onHexBlur = field => {
    setHexText(current => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const resetToBase = () => {
    setDraft(resolveCustomColors({}));
    setHexText({});
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('theme.custom.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <FieldHint style={styles.hint}>{t('theme.custom.hint')}</FieldHint>

            {/* 实时预览：直接用草稿色，改一下立刻能看到整体观感，不必先保存再退出去看 */}
            <View style={[styles.preview, { backgroundColor: draft.background }]}>
              <View style={[styles.previewCard, { backgroundColor: draft.surface, borderColor: draft.surfaceBorder }]}>
                <Text style={[styles.previewTitle, { color: draft.text }]}>
                  {t('theme.custom.preview.title')}
                </Text>
                <View style={[styles.previewBubble, { backgroundColor: draft.bubbleAssistant }]}>
                  <Text style={[styles.previewBubbleText, { color: draft.bubbleAssistantText }]}>
                    {t('theme.custom.preview.assistant')}
                  </Text>
                </View>
                <View style={[styles.previewBubble, styles.previewBubbleUser, { backgroundColor: draft.primary }]}>
                  <Text style={[styles.previewBubbleText, { color: draft.primaryContrast }]}>
                    {t('theme.custom.preview.user')}
                  </Text>
                </View>
                <View style={styles.previewFooter}>
                  <View style={[styles.previewButton, { backgroundColor: draft.primary }]}>
                    <Text style={[styles.previewButtonText, { color: draft.primaryContrast }]}>
                      {t('theme.custom.preview.button')}
                    </Text>
                  </View>
                  <View style={[styles.previewDot, { backgroundColor: draft.success }]} />
                  <View style={[styles.previewDot, { backgroundColor: draft.danger }]} />
                </View>
                <View style={styles.previewMetaRow}>
                  <Text style={[styles.previewMeta, { color: draft.textMuted }]}>
                    {t('theme.custom.preview.muted')}
                  </Text>
                  <Text style={[styles.previewMeta, { color: draft.textFaint }]}>
                    {t('theme.custom.preview.faint')}
                  </Text>
                </View>
              </View>
            </View>

            {CUSTOM_COLOR_GROUPS.map(group => (
              <View key={group.id} style={styles.group}>
                <FieldLabel style={styles.groupLabel}>{t(group.labelKey)}</FieldLabel>
                {group.fields.map(field => {
                  const open = editingField === field;
                  const value = draft[field] || '';
                  return (
                    <View key={field}>
                      <TouchableOpacity
                        style={[styles.row, open && styles.rowOpen]}
                        onPress={() => setEditingField(open ? '' : field)}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={t('theme.custom.a11y.field', {
                          name: t(CUSTOM_COLOR_FIELD_KEYS[field]),
                          value,
                        })}
                      >
                        <View style={[styles.swatch, { backgroundColor: value, borderColor: theme.colors.surfaceBorder }]} />
                        <Text style={styles.rowLabel} numberOfLines={1}>
                          {t(CUSTOM_COLOR_FIELD_KEYS[field])}
                        </Text>
                        <Text style={styles.rowValue}>{value}</Text>
                        <Ionicons
                          name={open ? 'chevron-up' : 'chevron-down'}
                          size={16}
                          color={theme.colors.textFaint}
                        />
                      </TouchableOpacity>

                      {open ? (
                        <View style={styles.palette}>
                          <View style={styles.presetGrid}>
                            {CUSTOM_COLOR_PRESETS.map(preset => {
                              const selected = String(value).toLowerCase() === preset.toLowerCase();
                              return (
                                <TouchableOpacity
                                  key={preset}
                                  style={[styles.preset, { backgroundColor: preset }, selected && styles.presetActive]}
                                  onPress={() => setField(field, preset)}
                                  accessibilityRole="button"
                                  accessibilityLabel={preset}
                                >
                                  {selected ? (
                                    <Ionicons name="checkmark" size={14} color={theme.colors.primaryContrast} />
                                  ) : null}
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                          <TextField
                            value={hexText[field] === undefined ? value : hexText[field]}
                            onChangeText={text => onHexChange(field, text)}
                            onBlur={() => onHexBlur(field)}
                            placeholder="#ffffff"
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={styles.hexInput}
                          />
                          {isValidHexColor(hexText[field]) || hexText[field] === undefined ? null : (
                            <FieldHint style={styles.invalid}>{t('theme.custom.invalidHex')}</FieldHint>
                          )}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ))}
          </ScrollView>

          <View style={styles.footer}>
            <GhostButton
              title={t('theme.custom.reset')}
              onPress={resetToBase}
              small
              style={styles.footerReset}
            />
            <View style={styles.footerActions}>
              <SecondaryButton title={t('common.cancel')} onPress={onClose} small style={styles.footerButton} />
              <PrimaryButton
                title={t('theme.custom.save')}
                onPress={() => onSave(draft)}
                small
                style={styles.footerButton}
              />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 18,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 12 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 12 },

  preview: { borderRadius: 14, padding: 12, marginBottom: 16 },
  previewCard: { borderRadius: 12, borderWidth: 1, padding: 12 },
  previewTitle: { fontSize: fonts.scaled(14), fontWeight: '800', marginBottom: 8 },
  previewBubble: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 6,
    alignSelf: 'flex-start',
    maxWidth: '90%',
  },
  previewBubbleUser: { alignSelf: 'flex-end' },
  previewBubbleText: { fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17) },
  previewFooter: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  previewButton: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  previewButtonText: { fontSize: fonts.scaled(12), fontWeight: '700' },
  previewDot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  previewMetaRow: { flexDirection: 'row', marginTop: 8 },
  previewMeta: { fontSize: fonts.scaled(11), marginRight: 10 },

  group: { marginBottom: 6 },
  groupLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '700', marginTop: 12, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 6,
  },
  rowOpen: { borderColor: theme.colors.primary },
  swatch: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, marginRight: 10 },
  rowLabel: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13) },
  rowValue: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginRight: 8, fontVariant: ['tabular-nums'] },

  palette: { marginBottom: 10 },
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  preset: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetActive: { borderWidth: 2, borderColor: theme.colors.primary },
  hexInput: { minHeight: 40 },
  invalid: { color: theme.colors.danger, fontSize: fonts.scaled(12), marginTop: 4 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  footerReset: { flexShrink: 0 },
  footerActions: { flexDirection: 'row', alignItems: 'center' },
  footerButton: { marginLeft: 8 },
});
