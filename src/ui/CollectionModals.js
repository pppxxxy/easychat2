// 集合弹窗（通用）：命名（新建/重命名）与「加入/移出」选择器。
// 服务于音乐歌单、书架分组等同构场景——文案与条目渲染全部由调用方传入，
// 组件本身不持有业务词条（i18n 由各领域自己接）。

import React, { useMemo } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';

// 新建 / 重命名：一个输入框 + 取消/确定。
export function CollectionNameModal({
  visible,
  title,
  placeholder,
  draft = '',
  onChangeDraft,
  onClose,
  onConfirm,
  saving = false,
  maxLength = 40,
  cancelLabel,
  confirmLabel,
  savingLabel,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={onChangeDraft}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.textFaint}
            autoFocus
            maxLength={maxLength}
            editable={!saving}
            returnKeyType="done"
            onSubmitEditing={onConfirm}
          />
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionButton, styles.actionGhost]}
              onPress={onClose}
              disabled={saving}
              activeOpacity={0.8}
            >
              <Text style={styles.actionGhostText}>{cancelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, styles.actionPrimary, saving && styles.actionDisabled]}
              onPress={onConfirm}
              disabled={saving}
              activeOpacity={0.8}
            >
              <Text style={styles.actionPrimaryText}>
                {saving ? savingLabel : confirmLabel}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// 加入 / 移出：列出全部集合，勾选态表示条目已在其中；点按即时切换。
export function CollectionPickerModal({
  visible,
  title,
  subtitle = '',
  hint,
  emptyHint,
  doneLabel,
  items = [],
  itemKey = item => String(item && item.id || ''),
  itemLabel = item => String(item && item.name || ''),
  itemMeta,
  isIncluded,
  onToggle,
  onClose,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, styles.sheetWide]}>
          <Text style={styles.sheetTitle}>{title}</Text>
          {subtitle ? (
            <Text style={styles.sheetMeta} numberOfLines={1}>{subtitle}</Text>
          ) : null}
          {items.length === 0 ? (
            <Text style={styles.emptyHint}>{emptyHint}</Text>
          ) : (
            <>
              <Text style={styles.pickerHint}>{hint}</Text>
              <ScrollView style={styles.pickerList}>
                {items.map(item => {
                  const included = isIncluded ? isIncluded(item) === true : false;
                  return (
                    <TouchableOpacity
                      key={itemKey(item)}
                      style={styles.pickerRow}
                      onPress={() => onToggle(item, !included)}
                      activeOpacity={0.85}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: included }}
                    >
                      <View style={styles.pickerInfo}>
                        <Text style={styles.pickerName} numberOfLines={1}>{itemLabel(item)}</Text>
                        {itemMeta ? (
                          <Text style={styles.pickerMeta} numberOfLines={1}>{itemMeta(item)}</Text>
                        ) : null}
                      </View>
                      <Ionicons
                        name={included ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={included ? theme.colors.primary : theme.colors.textFaint}
                      />
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          )}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionButton, styles.actionPrimary]}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Text style={styles.actionPrimaryText}>{doneLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    padding: tokens.spacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    borderRadius: tokens.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.lg,
  },
  sheetWide: { maxHeight: '80%' },
  sheetTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(16),
    fontWeight: '800',
    marginBottom: tokens.spacing.sm,
  },
  sheetMeta: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    marginBottom: tokens.spacing.sm,
  },
  input: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm + 2,
    marginTop: tokens.spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: tokens.spacing.lg,
  },
  actionButton: {
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm + 2,
    borderRadius: tokens.radius.md,
    marginLeft: tokens.spacing.sm,
  },
  actionGhost: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actionGhostText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), fontWeight: '700' },
  actionPrimary: { backgroundColor: theme.colors.primary },
  actionPrimaryText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '800' },
  actionDisabled: { opacity: tokens.opacity.disabled },
  emptyHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(13),
    paddingVertical: tokens.spacing.sm,
  },
  pickerHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginBottom: tokens.spacing.xs,
  },
  pickerList: { marginTop: tokens.spacing.xs },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: tokens.spacing.sm + 2,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  pickerInfo: { flex: 1, marginRight: tokens.spacing.sm },
  pickerName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '600' },
  pickerMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
});
