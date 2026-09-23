import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldLabel, SecondaryButton, TextField } from './ui';
import { makeCharacterPresetId } from './characterPresets';
import { useTheme } from './theme/ThemeContext';
import {
  createGlobalPresetId,
  getGlobalPresetSettings,
  getGlobalPresets,
  getMemorySummarySettings,
  saveGlobalPresetSettings,
  saveGlobalPresets,
  saveMemorySummarySettings,
} from './storage';

const THRESHOLD_FALLBACK = 40;
const EMPTY_CHARACTER_PRESETS = [];

export default function PresetPanel({
  visible,
  onClose,
  scope = 'global',
  characterPresets = EMPTY_CHARACTER_PRESETS,
  onCharacterPresetsChange,
}) {
  const [presets, setPresets] = useState([]);
  const [enabled, setEnabled] = useState({});
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [threshold, setThreshold] = useState(String(THRESHOLD_FALLBACK));
  const [loaded, setLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState(null);
  const [form, setForm] = useState({ name: '', description: '', prompt: '' });
  const [saving, setSaving] = useState(false);
  const isCharacterScope = scope === 'character';
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    if (isCharacterScope) {
      const list = Array.isArray(characterPresets) ? characterPresets : [];
      setPresets(list);
      setEnabled(list.reduce((result, item) => {
        result[item.id] = item.enabled !== false;
        return result;
      }, {}));
      setMemoryEnabled(false);
      setThreshold(String(THRESHOLD_FALLBACK));
      setLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    Promise.all([
      getGlobalPresets(),
      getGlobalPresetSettings(),
      getMemorySummarySettings(),
    ])
      .then(([list, map, memory]) => {
        if (cancelled) return;
        setPresets(list);
        setEnabled(map);
        setMemoryEnabled(memory.enabled === true);
        setThreshold(String(memory.threshold));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert('预设读取失败', '请重新打开后重试。');
      });
    return () => {
      cancelled = true;
    };
  }, [visible, isCharacterScope, characterPresets]);

  const togglePreset = useCallback(async (id, value) => {
    if (busyRef.current) return;
    if (isCharacterScope) {
      const next = presets.map(item => (item.id === id ? { ...item, enabled: value } : item));
      setPresets(next);
      setEnabled(current => ({ ...current, [id]: value }));
      onCharacterPresetsChange?.(next);
      return;
    }
    busyRef.current = true;
    try {
      const next = await saveGlobalPresetSettings({ ...enabled, [id]: value });
      setEnabled(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    } finally {
      busyRef.current = false;
    }
  }, [enabled, isCharacterScope, onCharacterPresetsChange, presets]);

  const openEditor = preset => {
    if (busyRef.current) return;
    setEditingPreset(preset);
    setForm({
      name: preset?.name || '',
      description: preset?.description || '',
      prompt: preset?.prompt || '',
    });
    setModalOpen(true);
  };

  const saveForm = async () => {
    if (busyRef.current) return;
    const name = form.name.trim();
    const prompt = form.prompt.trim();
    if (!name || !prompt) {
      Alert.alert('信息不全', '名称和提示词不能为空。');
      return;
    }
    busyRef.current = true;
    setSaving(true);
    try {
      if (isCharacterScope) {
        const id = editingPreset?.id || makeCharacterPresetId(presets);
        const item = {
          id,
          name,
          description: form.description.trim(),
          prompt,
          enabled: editingPreset?.enabled !== false,
        };
        const list = editingPreset
          ? presets.map(entry => (entry.id === id ? item : entry))
          : [...presets, item];
        setPresets(list);
        onCharacterPresetsChange?.(list);
        setModalOpen(false);
        return;
      }
      const base = await getGlobalPresets();
      const id = editingPreset?.id || await createGlobalPresetId(base);
      const item = { id, name, description: form.description.trim(), prompt };
      const list = editingPreset
        ? base.map(entry => (entry.id === id ? item : entry))
        : [...base, item];
      const saved = await saveGlobalPresets(list);
      setPresets(saved);
      setModalOpen(false);
    } catch (error) {
      Alert.alert('保存失败', error?.message || '请检查存储空间或权限。');
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const deletePreset = preset => {
    if (busyRef.current) return;
    Alert.alert('删除预设', `确定删除「${preset.name || '未命名'}」吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          if (busyRef.current) return;
          busyRef.current = true;
          setSaving(true);
          try {
            if (isCharacterScope) {
              const list = presets.filter(item => item.id !== preset.id);
              setPresets(list);
              setEnabled(current => {
                const next = { ...current };
                delete next[preset.id];
                return next;
              });
              onCharacterPresetsChange?.(list);
              return;
            }
            const saved = await saveGlobalPresets(
              (await getGlobalPresets()).filter(item => item.id !== preset.id)
            );
            setPresets(saved);
            setEnabled(current => {
              const next = { ...current };
              delete next[preset.id];
              return next;
            });
          } catch (error) {
            Alert.alert('删除失败', error?.message || '请检查存储空间或权限。');
          } finally {
            busyRef.current = false;
            setSaving(false);
          }
        },
      },
    ]);
  };

  const persistMemory = async (enabledValue, thresholdValue) => {
    busyRef.current = true;
    try {
      const saved = await saveMemorySummarySettings({
        enabled: enabledValue,
        threshold: thresholdValue,
      });
      setMemoryEnabled(saved.enabled);
      setThreshold(String(saved.threshold));
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    } finally {
      busyRef.current = false;
    }
  };

  const toggleMemory = value => {
    if (busyRef.current) return;
    persistMemory(value, threshold);
  };

  const normalizeThreshold = () => {
    const parsed = Math.trunc(Number(String(threshold).trim()));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : THRESHOLD_FALLBACK;
  };

  const commitThreshold = () => {
    if (busyRef.current) return;
    const previous = Number(threshold);
    const value = normalizeThreshold();
    if (value !== Math.trunc(Number(String(threshold).trim()))) {
      Alert.alert('阈值无效', `请输入大于 0 的整数，已改为 ${THRESHOLD_FALLBACK}。`);
    }
    setThreshold(String(value));
    if (previous !== value) {
      persistMemory(memoryEnabled, value);
    }
  };

  const confirmThreshold = async () => {
    if (busyRef.current) return;
    const value = normalizeThreshold();
    setThreshold(String(value));
    await persistMemory(memoryEnabled, value);
    Alert.alert('已保存', `触发阈值已设为 ${value} 条消息。`);
  };

  const handleClose = () => {
    if (!isCharacterScope) commitThreshold();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{isCharacterScope ? '角色预设' : '全局预设'}</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.listContent}>
            <Text style={styles.fieldHint}>
              {isCharacterScope
                ? '这些预设只对当前角色生效，开启后会追加到该角色的系统提示词中。点击条目可编辑。'
                : '这些预设无视角色卡，对所有对话生效。开启后会追加到系统提示词中。点击条目可编辑。'}
            </Text>
            {presets.map(preset => (
              <View key={preset.id} style={styles.presetRow}>
                <TouchableOpacity
                  style={styles.presetInfo}
                  activeOpacity={0.7}
                  onPress={() => openEditor(preset)}
                >
                  <Text style={styles.presetName}>{preset.name}</Text>
                  {preset.description ? (
                    <Text style={styles.presetDesc}>{preset.description}</Text>
                  ) : null}
                </TouchableOpacity>
                <Switch
                  value={enabled[preset.id] === true}
                  onValueChange={value => togglePreset(preset.id, value)}
                  trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                  thumbColor={theme.colors.primaryContrast}
                />
                <TouchableOpacity
                  style={styles.presetDelete}
                  hitSlop={8}
                  onPress={() => deletePreset(preset)}
                  disabled={saving}
                  accessibilityLabel="删除预设"
                >
                  <Ionicons name="trash-outline" size={16} color={theme.colors.dangerSoft} />
                </TouchableOpacity>
              </View>
            ))}
            {loaded && presets.length === 0 ? (
              <Text style={styles.fieldHint}>暂无预设，点击下方按钮新增。</Text>
            ) : null}
            <SecondaryButton
              title="新增预设"
              icon="add"
              onPress={() => openEditor(null)}
              disabled={!loaded || saving}
              style={styles.secondaryButton}
            />

            {!isCharacterScope ? (
              <>
                <View style={styles.sectionDivider} />
                <View style={styles.memoryRow}>
                  <View style={styles.memoryText}>
                    <Text style={styles.presetName}>记忆总结</Text>
                    <Text style={styles.presetDesc}>
                      对话过长时总结历史并写入世界书，阈值为当前会话消息条数。
                    </Text>
                  </View>
                  <Switch
                    value={memoryEnabled}
                    onValueChange={toggleMemory}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
                <FieldLabel style={styles.label}>触发阈值（消息条数）</FieldLabel>
                <View style={styles.thresholdRow}>
                  <TextField
                    style={styles.thresholdInput}
                    value={threshold}
                    onChangeText={setThreshold}
                    onEndEditing={commitThreshold}
                    onBlur={commitThreshold}
                    keyboardType="number-pad"
                    placeholder={String(THRESHOLD_FALLBACK)}
                  />
                  <TouchableOpacity
                    style={styles.thresholdConfirm}
                    onPress={confirmThreshold}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="checkmark" size={16} color={theme.colors.primaryContrast} />
                    <Text style={styles.thresholdConfirmText}>确认</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={modalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busyRef.current) setModalOpen(false);
        }}
      >
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.title}>
                {editingPreset ? '编辑预设' : '新增预设'}
              </Text>
              <FieldLabel style={styles.label}>名称</FieldLabel>
              <TextField
                value={form.name}
                editable={!saving}
                onChangeText={text => setForm(current => ({ ...current, name: text }))}
                placeholder="例如：控制篇幅"
              />
              <FieldLabel style={styles.label}>描述（可选）</FieldLabel>
              <TextField
                value={form.description}
                editable={!saving}
                onChangeText={text => setForm(current => ({ ...current, description: text }))}
                placeholder="一句话说明用途"
              />
              <FieldLabel style={styles.label}>提示词</FieldLabel>
              <TextField
                style={styles.promptInput}
                value={form.prompt}
                editable={!saving}
                onChangeText={text => setForm(current => ({ ...current, prompt: text }))}
                placeholder="开启后追加到系统提示词的内容"
                multiline
                textAlignVertical="top"
              />
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                onPress={() => setModalOpen(false)}
                disabled={saving}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.selectButton, saving && styles.buttonDisabled]}
                onPress={saveForm}
                disabled={saving}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>{saving ? '保存中...' : '保存'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800', marginBottom: 6 },
  listContent: { paddingBottom: 12 },
  fieldHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 10 },
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm + 2,
    marginBottom: tokens.spacing.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  presetInfo: { flex: 1, marginRight: 8 },
  presetName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  presetDesc: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17), marginTop: 3 },
  presetDelete: { marginLeft: 6, padding: 4 },
  secondaryButton: {
    marginTop: tokens.spacing.sm,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: theme.colors.divider,
    marginVertical: 16,
  },
  memoryRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  memoryText: { flex: 1, marginRight: 8 },
  label: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginBottom: 6, marginTop: 8 },
  thresholdRow: { flexDirection: 'row', alignItems: 'center' },
  thresholdInput: { flex: 1, minHeight: 40 },
  thresholdConfirm: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    marginLeft: 8,
  },
  thresholdConfirmText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), marginLeft: 4 },
  promptInput: { minHeight: 110, marginBottom: 6 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  selectButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginLeft: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectButtonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.colors.surfaceBorder },
  selectButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
  buttonDisabled: { opacity: 0.45 },
});
