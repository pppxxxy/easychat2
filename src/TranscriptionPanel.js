// 语音转文字（STT）配置面板。
//
// 默认「仅复用当前聊天来源」：用户不额外配置也能用语音，转写复用当前聊天 API 的
// baseUrl/apiKey 调 /audio/transcriptions（需求 3.1、4.5）。
// 若当前来源不支持转写，用户可在此新增/编辑独立转写配置并选用（需求 4.2、4.3）。
// 密钥走保险箱存储，仅存本机（需求 4.4）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, TextField } from './ui/index.js';
import { getTranscriptionSettings, saveTranscriptionSettings } from './storage/settings.js';
import { TRANSCRIPTION_API_VENDORS } from './network/apiVendors.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

const REUSED_ID = '__reused__';

function makeConfigId() {
  return `stt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function TranscriptionPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [settings, setSettings] = useState({ activeId: '', configs: [] });
  const [loaded, setLoaded] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (!visible) {
      setLoaded(false);
      return undefined;
    }
    let cancelled = false;
    getTranscriptionSettings()
      .then(stored => {
        if (cancelled) return;
        settingsRef.current = stored;
        setSettings(stored);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert(t('transcription.alert.loadFailed.title'), t('transcription.alert.loadFailed.body'));
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const persist = useCallback(async next => {
    const previous = settingsRef.current;
    settingsRef.current = next;
    setSettings(next);
    try {
      const saved = await saveTranscriptionSettings(next);
      settingsRef.current = saved;
      setSettings(saved);
      return saved;
    } catch (error) {
      settingsRef.current = previous;
      setSettings(previous);
      Alert.alert(t('transcription.alert.saveFailed.title'), t('transcription.alert.saveFailed.body'));
      return null;
    }
  }, [t]);

  const selectSource = useCallback(id => {
    persist({ ...settingsRef.current, activeId: id === REUSED_ID ? '' : id });
  }, [persist]);

  const addConfig = useCallback(vendor => {
    const preset = vendor && typeof vendor === 'object' ? vendor : null;
    const next = {
      id: makeConfigId(),
      name: preset ? preset.name : t('transcription.config.newName'),
      baseUrl: preset ? preset.baseUrl : '',
      apiKey: '',
      model: preset ? preset.model : '',
      vendorId: preset ? preset.id : '',
    };
    persist({
      ...settingsRef.current,
      activeId: next.id,
      configs: [...settingsRef.current.configs, next],
    });
  }, [persist, t]);

  const updateConfig = useCallback((id, key, value) => {
    const current = settingsRef.current;
    persist({
      ...current,
      configs: current.configs.map(item => (
        item.id === id ? { ...item, [key]: value } : item
      )),
    });
  }, [persist]);

  const removeConfig = useCallback(id => {
    const current = settingsRef.current;
    persist({
      ...current,
      activeId: current.activeId === id ? '' : current.activeId,
      configs: current.configs.filter(item => item.id !== id),
    });
  }, [persist]);

  const activeConfig = settings.configs.find(item => item.id === settings.activeId) || null;

  const getVendorForConfig = config => {
    if (!config) return null;
    return TRANSCRIPTION_API_VENDORS.find(vendor => (
      vendor.id === config.vendorId || vendor.baseUrl === config.baseUrl
    )) || null;
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('transcription.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('transcription.closeA11y')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <FieldHint style={styles.hint}>
              {t('transcription.intro')}
            </FieldHint>

            <FieldLabel style={styles.label}>{t('transcription.sourceLabel')}</FieldLabel>

            <TouchableOpacity
              style={[styles.optionRow, !activeConfig && styles.optionRowActive]}
              onPress={() => selectSource(REUSED_ID)}
              activeOpacity={0.85}
            >
              <Ionicons
                name={!activeConfig ? 'radio-button-on' : 'radio-button-off'}
                size={18}
                color={!activeConfig ? theme.colors.primary : theme.colors.textFaint}
              />
              <View style={styles.optionBody}>
                <Text style={styles.optionTitle}>{t('transcription.reuse.title')}</Text>
                <Text style={styles.optionMeta}>{t('transcription.reuse.meta')}</Text>
              </View>
            </TouchableOpacity>

            {loaded ? settings.configs.map(config => {
              const active = config.id === settings.activeId;
              return (
                <View key={config.id} style={styles.configBlock}>
                  <View style={styles.optionRow}>
                    <TouchableOpacity
                      style={styles.optionPick}
                      onPress={() => selectSource(config.id)}
                      activeOpacity={0.85}
                    >
                      <Ionicons
                        name={active ? 'radio-button-on' : 'radio-button-off'}
                        size={18}
                        color={active ? theme.colors.primary : theme.colors.textFaint}
                      />
                      <Text style={styles.optionTitle}>{config.name || t('transcription.config.unnamed')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => removeConfig(config.id)}
                      hitSlop={8}
                      accessibilityLabel={t('transcription.config.deleteA11y')}
                    >
                      <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
                    </TouchableOpacity>
                  </View>
                  <FieldLabel style={styles.label}>{t('transcription.field.name')}</FieldLabel>
                  <TextField
                    value={config.name}
                    onChangeText={value => updateConfig(config.id, 'name', value)}
                    placeholder={t('transcription.field.namePlaceholder')}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <FieldLabel style={styles.label}>{t('transcription.field.baseUrl')}</FieldLabel>
                  <TextField
                    value={config.baseUrl}
                    onChangeText={value => updateConfig(config.id, 'baseUrl', value)}
                    placeholder="https://api.openai.com/v1/audio/transcriptions"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <FieldLabel style={styles.label}>API Key</FieldLabel>
                  <TextField
                    value={config.apiKey}
                    onChangeText={value => updateConfig(config.id, 'apiKey', value)}
                    placeholder={t('transcription.field.apiKeyPlaceholder')}
                   secureTextEntry
                   autoCapitalize="none"
                   autoCorrect={false}
                  />
                  {getVendorForConfig(config)?.apiKeyUrl ? (
                    <View style={styles.keyLinkRow}>
                      <TouchableOpacity
                        onPress={() => Linking.openURL(getVendorForConfig(config).apiKeyUrl)}
                        activeOpacity={0.75}
                        accessibilityRole="link"
                        accessibilityLabel={t('transcription.getKey.a11y', { vendor: getVendorForConfig(config).name })}
                      >
                        <Text style={styles.keyLink}>{t('transcription.getKey')}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <FieldLabel style={styles.label}>{t('transcription.field.model')}</FieldLabel>
                  <TextField
                    value={config.model}
                    onChangeText={value => updateConfig(config.id, 'model', value)}
                    placeholder="whisper-1"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              );
            }) : null}

            <FieldLabel style={styles.label}>{t('transcription.addLabel')}</FieldLabel>
            <FieldHint style={styles.hint}>
              {t('transcription.addHint')}
            </FieldHint>
            <View style={styles.vendorRow}>
              {TRANSCRIPTION_API_VENDORS.map(vendor => (
                <TouchableOpacity
                  key={vendor.id}
                  style={styles.vendorChip}
                  onPress={() => addConfig(vendor)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t('transcription.addVendor.a11y', { vendor: vendor.name })}
                >
                  <Text style={styles.vendorChipText}>{vendor.name}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[styles.vendorChip, styles.vendorChipCustom]}
                onPress={() => addConfig(null)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={t('transcription.addCustom.a11y')}
              >
                <Text style={styles.vendorChipCustomText}>{t('transcription.custom')}</Text>
              </TouchableOpacity>
            </View>
            {TRANSCRIPTION_API_VENDORS.map(vendor => (
              <Text key={`${vendor.id}-note`} style={styles.vendorNote}>
                {vendor.name}：{vendor.note}
              </Text>
            ))}

            <TouchableOpacity style={styles.saveButton} onPress={onClose} activeOpacity={0.8}>
              <Text style={styles.saveText}>{t('transcription.done')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    maxHeight: '88%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 16 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 10 },
  label: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 10, marginBottom: 6 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: 8,
  },
  optionRowActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.12) },
  optionPick: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  optionBody: { flex: 1, marginLeft: 8 },
  optionTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 8 },
  optionMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 3 },
  configBlock: {
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    padding: 10,
    marginBottom: 8,
    backgroundColor: theme.colors.surface,
  },
  addButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  keyLinkRow: { alignItems: 'flex-end', marginTop: 4 },
  keyLink: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), textDecorationLine: 'underline' },
  addButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), marginLeft: 4, fontWeight: '600' },
  vendorRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2, marginBottom: 6 },
  vendorChip: {
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
    backgroundColor: theme.colors.primaryAlpha(0.12),
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
    marginBottom: 8,
  },
  vendorChipCustom: {
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  vendorChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700' },
  vendorChipCustomText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '600' },
  vendorNote: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 2,
  },
  saveButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  saveText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
});
