import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { TextField } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { buildGreetingImport, removeGreetingDraftIndex } from './character/cardGreetings.js';

// 导入角色卡时选择开场白：挑一条、就地修改，或新增。确认后返回
// { firstMes, alternateGreetings }。
export default function GreetingPickerModal({
  visible,
  candidates,
  onCancel,
  onConfirm,
  mode = 'import',
  initialSelectedIndex,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const source = Array.isArray(candidates) ? candidates : [];
  const [drafts, setDrafts] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const initial = (Array.isArray(candidates) ? candidates : [])
      .map(item => String((item && item.text) || ''));
    setDrafts(initial);
    const hasRequestedIndex = Number.isInteger(initialSelectedIndex);
    const requestedIndex = hasRequestedIndex ? initialSelectedIndex : (initial.length > 0 ? 0 : -1);
    setSelectedIndex(requestedIndex >= 0 && requestedIndex < initial.length ? requestedIndex : -1);
    // candidates 在弹窗打开期间引用稳定，只在打开或候选变化时重置
  }, [visible, candidates, initialSelectedIndex]);

  const updateDraft = (index, value) => {
    setDrafts(current => current.map((item, i) => (i === index ? value : item)));
  };

  const addDraft = () => {
    setDrafts(current => {
      const next = [...current, ''];
      setSelectedIndex(next.length - 1);
      return next;
    });
  };

  const removeDraft = index => {
    setDrafts(current => {
      const next = current.filter((_, i) => i !== index);
      setSelectedIndex(prev => removeGreetingDraftIndex(prev, index, next.length));
      return next;
    });
  };

  const confirm = async () => {
    if (saving) return;
    const result = buildGreetingImport(drafts, selectedIndex);
    setSaving(true);
    try {
      await onConfirm(result);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!saving) onCancel(); }}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('greetingPicker.title')}</Text>
            <TouchableOpacity
              onPress={() => { if (!saving) onCancel(); }}
              disabled={saving}
              hitSlop={8}
              accessibilityLabel={t('greetingPicker.closeA11y')}
            >
              <Ionicons name="close" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            {mode === 'select'
              ? t('greetingPicker.hintSelect')
              : source.length > 0
                ? t('greetingPicker.hintMultiple')
                : t('greetingPicker.hintEmpty')}
          </Text>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            <TouchableOpacity
              style={[styles.row, selectedIndex < 0 && styles.rowActive]}
              onPress={() => setSelectedIndex(-1)}
              activeOpacity={0.8}
            >
              <Ionicons
                name={selectedIndex < 0 ? 'radio-button-on' : 'radio-button-off'}
                size={18}
                color={selectedIndex < 0 ? theme.colors.primary : theme.colors.textFaint}
              />
              <Text style={[styles.rowText, styles.rowTextMuted]}>{t('greetingPicker.none')}</Text>
            </TouchableOpacity>

            {drafts.map((text, index) => (
              <View key={`greeting-${index}`} style={styles.rowWrap}>
                <TouchableOpacity
                  style={[styles.row, styles.rowGrow, selectedIndex === index && styles.rowActive]}
                  onPress={() => setSelectedIndex(index)}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={selectedIndex === index ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={selectedIndex === index ? theme.colors.primary : theme.colors.textFaint}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowLabel}>
                      {index === 0 && source[0] && source[0].source === 'first' ? t('greetingPicker.firstLabel') : t('greetingPicker.itemLabel', { n: index + 1 })}
                    </Text>
                    <Text style={styles.rowPreview} numberOfLines={3}>
                      {String(text || '').trim() || t('greetingPicker.emptyItem')}
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.remove}
                  onPress={() => removeDraft(index)}
                  hitSlop={8}
                  accessibilityLabel={t('greetingPicker.removeA11y')}
                >
                  <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity style={styles.addButton} onPress={addDraft} activeOpacity={0.8}>
            <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.addButtonText}>{t('greetingPicker.add')}</Text>
          </TouchableOpacity>

          {selectedIndex >= 0 ? (
            <>
              <Text style={styles.editLabel}>{t('greetingPicker.editLabel')}</Text>
              <TextField
                style={styles.editInput}
                value={drafts[selectedIndex] || ''}
                onChangeText={value => updateDraft(selectedIndex, value)}
                multiline
                placeholder={t('greetingPicker.editPlaceholder')}
              />
            </>
          ) : null}

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.button, styles.ghost, saving && styles.disabled]}
              onPress={() => { if (!saving) onCancel(); }}
              disabled={saving}
              activeOpacity={0.8}
            >
              <Text style={styles.ghostText}>{t('greetingPicker.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primary, saving && styles.disabled]}
              onPress={confirm}
              disabled={saving}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryText}>{saving ? t('greetingPicker.saving') : (mode === 'select' ? t('greetingPicker.useThis') : t('greetingPicker.import'))}</Text>
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
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    padding: 18,
    maxHeight: '86%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '700' },
  hint: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: 12,
  },
  list: { maxHeight: 260 },
  listContent: { paddingBottom: 4 },
  rowWrap: { flexDirection: 'row', alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.md,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  rowGrow: { flex: 1, marginBottom: 6 },
  rowActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surfaceAlt },
  rowBody: { flex: 1, marginLeft: 8 },
  rowLabel: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginBottom: 2 },
  rowText: { color: theme.colors.text, fontSize: fonts.scaled(13) },
  rowTextMuted: { color: theme.colors.textMuted, marginLeft: 8 },
  rowPreview: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17) },
  remove: { paddingLeft: 8, paddingVertical: 10 },
  addButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  addButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), marginLeft: 4, fontWeight: '600' },
  editLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 8, marginBottom: 6 },
  editInput: { minHeight: 96, maxHeight: 160, paddingTop: 10 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  button: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: tokens.radius.md, marginLeft: 10 },
  disabled: { opacity: 0.6 },
  ghost: { backgroundColor: theme.colors.surfaceAlt },
  ghostText: { color: theme.colors.textMuted, fontWeight: '700', fontSize: fonts.scaled(13) },
  primary: { backgroundColor: theme.colors.primary },
  primaryText: { color: theme.colors.primaryContrast, fontWeight: '700', fontSize: fonts.scaled(13) },
});
