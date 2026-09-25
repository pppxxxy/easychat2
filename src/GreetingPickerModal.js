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

import { TextField } from './ui';
import { useTheme } from './theme/ThemeContext';
import { buildGreetingImport } from './cardGreetings';

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
      setSelectedIndex(prev => {
        if (prev === index) return next.length > 0 ? 0 : -1;
        if (prev > index) return prev - 1;
        return prev;
      });
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
            <Text style={styles.title}>选择开场白</Text>
            <TouchableOpacity
              onPress={() => { if (!saving) onCancel(); }}
              disabled={saving}
              hitSlop={8}
              accessibilityLabel="关闭"
            >
              <Ionicons name="close" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            {mode === 'select'
              ? '选择后，之后新建的对话会默认使用这条开场白。也可以修改或新增。'
              : source.length > 0
                ? '这张卡包含多条开场白，选一条作为开场白；也可以修改或新增。未选中的会保留为备用开场白。'
                : '这张卡没有开场白，可以新增一条，或直接跳过。'}
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
              <Text style={[styles.rowText, styles.rowTextMuted]}>不使用开场白（由我先说）</Text>
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
                      {index === 0 && source[0] && source[0].source === 'first' ? '开场白' : `开场白 ${index + 1}`}
                    </Text>
                    <Text style={styles.rowPreview} numberOfLines={3}>
                      {String(text || '').trim() || '（空白，请在下方填写）'}
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.remove}
                  onPress={() => removeDraft(index)}
                  hitSlop={8}
                  accessibilityLabel="删除这条开场白"
                >
                  <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity style={styles.addButton} onPress={addDraft} activeOpacity={0.8}>
            <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.addButtonText}>新增一条</Text>
          </TouchableOpacity>

          {selectedIndex >= 0 ? (
            <>
              <Text style={styles.editLabel}>编辑选中的开场白</Text>
              <TextField
                style={styles.editInput}
                value={drafts[selectedIndex] || ''}
                onChangeText={value => updateDraft(selectedIndex, value)}
                multiline
                placeholder="填写开场白内容"
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
              <Text style={styles.ghostText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primary, saving && styles.disabled]}
              onPress={confirm}
              disabled={saving}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryText}>{saving ? '保存中...' : (mode === 'select' ? '使用此开场白' : '导入')}</Text>
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
