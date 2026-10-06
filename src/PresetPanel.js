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

import { FieldLabel, SecondaryButton, TextField } from './ui/index.js';
import { makeCharacterPresetId } from './character/characterPresets.js';
import { useTheme } from './theme/ThemeContext.js';
import {
  createGlobalPresetId,
  getGlobalPresetSettings,
  getGlobalPresets,
  getMemorySummarySettings,
  saveGlobalPresetSettings,
  saveGlobalPresets,
  saveMemorySummarySettings,
} from './storage.js';
import { useTranslation } from './i18n/I18nContext.js';

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
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const busyRef = useRef(false);
  const savedThresholdRef = useRef(THRESHOLD_FALLBACK);
  const thresholdCommitRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      setLoaded(false);
      setModalOpen(false);
      setEditingPreset(null);
      return undefined;
    }
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
      savedThresholdRef.current = THRESHOLD_FALLBACK;
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
         savedThresholdRef.current = Number(memory.threshold) || THRESHOLD_FALLBACK;
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert(t('preset.alert.loadFailed.title'), t('preset.alert.loadFailed.body'));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, isCharacterScope, characterPresets]);

  const togglePreset = useCallback(async (id, value) => {
    if (busyRef.current) {
      Alert.alert(t('preset.alert.busy.title'), t('preset.alert.busy.body'));
      return;
    }
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
      Alert.alert(t('preset.alert.saveFailed.title'), t('preset.alert.saveFailed.body'));
    } finally {
      busyRef.current = false;
    }
  }, [enabled, isCharacterScope, onCharacterPresetsChange, presets, t]);

  const openEditor = preset => {
    if (busyRef.current) {
      Alert.alert(t('preset.alert.busy.title'), t('preset.alert.busy.body'));
      return;
    }
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
      Alert.alert(t('preset.alert.infoIncomplete.title'), t('preset.alert.infoIncomplete.body'));
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
      Alert.alert(t('preset.alert.saveFailed.title'), error?.message || t('preset.alert.saveFailed.body'));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const deletePreset = preset => {
    if (busyRef.current) return;
    Alert.alert(t('preset.alert.delete.title'), t('preset.alert.delete.body', { name: preset.name || t('preset.unnamed') }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
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
            Alert.alert(t('preset.alert.deleteFailed.title'), error?.message || t('preset.alert.saveFailed.body'));
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
      savedThresholdRef.current = Number(saved.threshold) || THRESHOLD_FALLBACK;
      return true;
    } catch (error) {
      Alert.alert(t('preset.alert.saveFailed.title'), t('preset.alert.saveFailed.body'));
      return false;
    } finally {
      busyRef.current = false;
    }
  };

  const toggleMemory = value => {
    if (!loaded) return;
    if (busyRef.current) {
      Alert.alert(t('preset.alert.busy.title'), t('preset.alert.busy.body'));
      return;
    }
    persistMemory(value, threshold);
  };

  const normalizeThreshold = () => {
    const parsed = Math.trunc(Number(String(threshold).trim()));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : THRESHOLD_FALLBACK;
  };

  const commitThreshold = async () => {
    if (thresholdCommitRef.current) return false;
    if (busyRef.current) {
      Alert.alert(t('preset.alert.busy.title'), t('preset.alert.busy.body'));
      return false;
    }
    if (!loaded) return false;
    thresholdCommitRef.current = true;
    const raw = String(threshold).trim();
    const parsed = Math.trunc(Number(raw));
    const value = normalizeThreshold();
    if (value !== parsed) {
      Alert.alert(t('preset.alert.thresholdInvalid.title'), t('preset.alert.thresholdInvalid.body', { fallback: THRESHOLD_FALLBACK }));
    }
    setThreshold(String(value));
    try {
      if (value !== savedThresholdRef.current) {
        return await persistMemory(memoryEnabled, value);
      }
      return true;
    } finally {
      thresholdCommitRef.current = false;
    }
  };

  const confirmThreshold = async () => {
    if (busyRef.current) {
      Alert.alert(t('preset.alert.busy.title'), t('preset.alert.busy.body'));
      return;
    }
    if (!loaded) return;
    const value = normalizeThreshold();
    setThreshold(String(value));
    const saved = await persistMemory(memoryEnabled, value);
    if (saved) Alert.alert(t('preset.alert.thresholdSaved.title'), t('preset.alert.thresholdSaved.body', { value }));
  };

  const handleClose = async () => {
    // 尚未加载完时不要提交：commitThreshold 里 !loaded 返回 false 会被当成保存失败，
    // 导致加载窗口内「关闭」按钮点了没反应。直接关闭即可。
    if (!loaded) {
      onClose();
      return;
    }
    if (!isCharacterScope) {
      const saved = await commitThreshold();
      if (!saved) return;
    }
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
        // Android 用 undefined：app.json 的 softwareKeyboardLayoutMode 已是 resize，
        // 再叠一层 behavior="height" 会在输入法收起时反复重算高度，表现为界面疯狂上下闪动。
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{isCharacterScope ? t('preset.title.character') : t('preset.title.global')}</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8} accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.listContent}>
            <Text style={styles.fieldHint}>
              {isCharacterScope
                ? t('preset.hint.character')
                : t('preset.hint.global')}
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
                   disabled={saving}
                 />

                <TouchableOpacity
                  style={styles.presetDelete}
                  hitSlop={8}
                  onPress={() => deletePreset(preset)}
                  disabled={saving}
                  accessibilityLabel={t('preset.a11y.delete')}
                >
                  <Ionicons name="trash-outline" size={16} color={theme.colors.dangerSoft} />
                </TouchableOpacity>
              </View>
            ))}
            {loaded && presets.length === 0 ? (
              <Text style={styles.fieldHint}>{t('preset.empty')}</Text>
            ) : null}
            <SecondaryButton
              title={t('preset.add')}
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
                    <Text style={styles.presetName}>{t('preset.memory.title')}</Text>
                    <Text style={styles.presetDesc}>
                      {t('preset.memory.desc')}
                    </Text>
                  </View>
                  <Switch
                    value={memoryEnabled}
                     onValueChange={toggleMemory}
                     trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                     thumbColor={theme.colors.primaryContrast}
                     disabled={!loaded || saving}

                  />
                </View>
                <FieldLabel style={styles.label}>{t('preset.memory.thresholdLabel')}</FieldLabel>
                <View style={styles.thresholdRow}>
                  <TextField
                    style={styles.thresholdInput}
                    value={threshold}
                    editable={loaded && !saving}
                    onChangeText={setThreshold}
                    onEndEditing={commitThreshold}
                    keyboardType="number-pad"
                    placeholder={String(THRESHOLD_FALLBACK)}
                  />
                  <TouchableOpacity
                    style={styles.thresholdConfirm}
                    onPress={confirmThreshold}
                    disabled={!loaded || saving}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="checkmark" size={16} color={theme.colors.primaryContrast} />
                    <Text style={styles.thresholdConfirmText}>{t('common.confirm')}</Text>
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
          // Android 用 undefined：app.json 的 softwareKeyboardLayoutMode 已是 resize，
          // 再叠一层 behavior="height" 会在输入法收起时反复重算高度，表现为界面疯狂上下闪动。
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.title}>
                {editingPreset ? t('preset.editor.editTitle') : t('preset.add')}
              </Text>
              <FieldLabel style={styles.label}>{t('preset.editor.nameLabel')}</FieldLabel>
              <TextField
                value={form.name}
                editable={!saving}
                onChangeText={text => setForm(current => ({ ...current, name: text }))}
                placeholder={t('preset.editor.namePlaceholder')}
              />
              <FieldLabel style={styles.label}>{t('preset.editor.descLabel')}</FieldLabel>
              <TextField
                value={form.description}
                editable={!saving}
                onChangeText={text => setForm(current => ({ ...current, description: text }))}
                placeholder={t('preset.editor.descPlaceholder')}
              />
              <FieldLabel style={styles.label}>{t('preset.editor.promptLabel')}</FieldLabel>
              <TextField
                style={styles.promptInput}
                value={form.prompt}
                editable={!saving}
                onChangeText={text => setForm(current => ({ ...current, prompt: text }))}
                placeholder={t('preset.editor.promptPlaceholder')}
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
                <Text style={styles.selectButtonText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.selectButton, saving && styles.buttonDisabled]}
                onPress={saveForm}
                disabled={saving}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>{saving ? t('common.saving') : t('common.save')}</Text>
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
