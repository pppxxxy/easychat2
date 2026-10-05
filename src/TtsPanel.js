import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
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

import { FieldHint, FieldLabel, TextField } from './ui/index.js';
import { getTtsSettings, saveTtsSettings } from './storage.js';
import { TTS_PROVIDERS, getTtsProvider } from './tts/providers.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

export default function TtsPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [settings, setSettings] = useState({ autoBroadcast: false, activeProvider: 'system', providers: {} });
  const [loaded, setLoaded] = useState(false);
  const persistVersionRef = useRef(0);
  const persistQueueRef = useRef(Promise.resolve());
  const settingsRef = useRef(settings);
  const lastSavedSettingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (!visible) {
      setLoaded(false);
      return undefined;
    }
    let cancelled = false;
    getTtsSettings()
      .then(stored => {
         if (cancelled) return;
         // 存量播报源已下线/移除：显式迁移回系统引擎并给出可见提示，
         // 不做静默换源——用户需要知道为什么引擎变了。
         const known = TTS_PROVIDERS.some(item => item.id === stored.activeProvider);
         if (!known) {
           const migrated = { ...stored, activeProvider: 'system' };
           settingsRef.current = migrated;
           lastSavedSettingsRef.current = migrated;
           setSettings(migrated);
           setLoaded(true);
           saveTtsSettings(migrated).catch(() => {});
           Alert.alert(t('tts.alert.engineMigrated.title'), t('tts.alert.engineMigrated.body'));
           return;
         }
         settingsRef.current = stored;
         lastSavedSettingsRef.current = stored;
         setSettings(stored);
         setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert(t('tts.alert.loadFailed.title'), t('tts.alert.loadFailed.body'));
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const persist = useCallback(next => {
    const version = ++persistVersionRef.current;
    const task = persistQueueRef.current.then(async () => {
      if (!loaded) return false;
      const previous = lastSavedSettingsRef.current;
      settingsRef.current = next;
      setSettings(next);
      try {
        await saveTtsSettings(next);
        lastSavedSettingsRef.current = next;
        return true;
      } catch (error) {
        if (version === persistVersionRef.current) {
          settingsRef.current = previous;
          setSettings(previous);
        }
        Alert.alert(t('tts.alert.saveFailed.title'), t('tts.alert.saveFailed.body'));
        return false;
      }
    });
    persistQueueRef.current = task.catch(() => false);
    return task;
  }, [loaded, t]);

  const provider = getTtsProvider(settings.activeProvider);
  const providerConfig = (settings.providers && settings.providers[provider.id]) || {};

  const setField = useCallback((key, value) => {
    persistVersionRef.current += 1;
    const currentSettings = settingsRef.current;
    const current = currentSettings.providers || {};
    const next = {
      ...currentSettings,
      providers: {
        ...current,
        [provider.id]: { ...(current[provider.id] || {}), [key]: value },
      },
    };
    settingsRef.current = next;
    setSettings(next);
  }, [provider.id]);

  const openKeyUrl = useCallback(async () => {
    const url = provider.apiKeyUrl;
    if (!url) return;
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert(t('tts.alert.openLinkFailed.title'), url);
        return;
      }
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert(t('tts.alert.openLinkFailed.title'), url);
    }
  }, [provider.apiKeyUrl, t]);

  const onSave = useCallback(() => {
    const currentSettings = settingsRef.current;
    const currentProviderConfig = currentSettings.providers?.[provider.id] || {};
    persist({
      ...currentSettings,
      providers: {
        ...(currentSettings.providers || {}),
        [provider.id]: { ...currentProviderConfig },
      },
    }).then(saved => {
      if (saved) onClose();
    });
  }, [onClose, persist, provider.id]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        // Android 用 undefined：app.json 的 softwareKeyboardLayoutMode 已是 resize，
        // 再叠一层 behavior="height" 会在键盘收起时反复重算高度，表现为界面疯狂上下闪动。
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('tts.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <FieldHint style={styles.hint}>{t('tts.hint.keyLocal')}</FieldHint>
            <FieldHint style={styles.hint}>{t('tts.hint.sendToProvider')}</FieldHint>
            <View style={styles.switchRow}>
              <View style={styles.switchTextWrap}>
                <Text style={styles.switchTitle}>{t('tts.autoBroadcast.title')}</Text>
                <Text style={styles.switchHint}>{t('tts.autoBroadcast.hint')}</Text>
              </View>
              <Switch
                value={settings.autoBroadcast === true}
                onValueChange={value => persist({ ...settingsRef.current, autoBroadcast: value })}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            <FieldLabel style={styles.label}>{t('tts.providerLabel')}</FieldLabel>
            <View style={styles.providerRow}>
              {TTS_PROVIDERS.map(item => {
                const active = item.id === provider.id;
                const unavailable = item.unsupported === true;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[
                      styles.providerChip,
                      active && styles.providerChipActive,
                      unavailable && styles.providerChipUnsupported,
                    ]}
                     onPress={() => {
                      if (unavailable) {
                        Alert.alert(t('tts.alert.unsupported.title'), t('tts.alert.unsupported.body', { name: item.label, note: item.unsupportedNote || t('tts.alert.unsupported.defaultNote') }));
                        return;
                      }
                      persist({ ...settingsRef.current, activeProvider: item.id });
                    }}
                     activeOpacity={0.85}
                    accessibilityLabel={unavailable ? t('tts.a11y.providerUnsupported', { name: item.label }) : item.label}
                  >
                    <Text
                      style={[
                        styles.providerText,
                        active && styles.providerTextActive,
                        unavailable && styles.providerTextUnsupported,
                      ]}
                    >
                      {unavailable ? t('tts.providerUnsupported', { name: item.label }) : item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
             </View>

            {provider.unsupported ? (
              <FieldHint style={styles.hint}>
                {t('tts.unsupportedHint', { note: provider.unsupportedNote || t('tts.unsupportedHint.defaultNote') })}
              </FieldHint>
            ) : null}

            {loaded ? provider.fields.map(field => (
              <View key={field.key}>
                <FieldLabel style={styles.label}>{field.label}</FieldLabel>
                <TextField
                  value={String(providerConfig[field.key] || '')}
                  onChangeText={value => setField(field.key, value)}
                  placeholder={field.placeholder || ''}
                  secureTextEntry={field.secret === true}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            )) : null}

            {/* 预置音色清单：点选即填入 voice 字段（也可在上方音色输入框手填）。
                留空表示「默认音色」，交给模型自选。 */}
            {loaded && Array.isArray(provider.voices) && provider.voices.length > 0 ? (
              <View>
                <FieldLabel style={styles.label}>{t('tts.voices.label')}</FieldLabel>
                <View style={styles.voiceRow}>
                  <TouchableOpacity
                    style={[styles.voiceChip, !providerConfig.voice && styles.voiceChipActive]}
                    onPress={() => setField('voice', '')}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.voiceText, !providerConfig.voice && styles.voiceTextActive]}>
                      {t('tts.voices.default')}
                    </Text>
                  </TouchableOpacity>
                  {provider.voices.map(voice => {
                    const active = String(providerConfig.voice || '') === voice;
                    return (
                      <TouchableOpacity
                        key={voice}
                        style={[styles.voiceChip, active && styles.voiceChipActive]}
                        onPress={() => setField('voice', voice)}
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.voiceText, active && styles.voiceTextActive]}>
                          {voice}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {provider.apiKeyUrl ? (
              <TouchableOpacity
                style={styles.keyLink}
                onPress={openKeyUrl}
                activeOpacity={0.8}
                accessibilityRole="link"
                accessibilityLabel={t('tts.a11y.getApiKey', { name: provider.label })}
              >
                <Ionicons name="open-outline" size={16} color={theme.colors.primarySoft} />
                <Text style={styles.keyLinkText}>{t('tts.getApiKey')}</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
              </TouchableOpacity>
            ) : null}

            {provider.engine !== 'system' && provider.signer === 'volcano' ? (
              <Text style={styles.fieldHint}>
                {t('tts.volcanoHint')}
              </Text>
            ) : null}

            <TouchableOpacity style={styles.saveButton} onPress={onSave} activeOpacity={0.8}>
              <Text style={styles.saveText}>{t('common.save')}</Text>
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
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  switchTextWrap: { flex: 1, marginRight: 12 },
  switchTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  switchHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 3 },
  label: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 10, marginBottom: 6 },
  providerRow: { flexDirection: 'row', flexWrap: 'wrap' },
  providerChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    marginBottom: 8,
  },
  providerChipActive: { backgroundColor: theme.colors.primaryAlpha(0.25), borderColor: theme.colors.primary },
  providerText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  providerTextActive: { color: theme.colors.primarySoft },
  providerChipUnsupported: {
    opacity: tokens.opacity.disabled,
    borderColor: theme.colors.surfaceBorder,
  },
  providerTextUnsupported: { color: theme.colors.textFaint },
  voiceRow: { flexDirection: 'row', flexWrap: 'wrap' },
  voiceChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    marginBottom: 8,
  },
  voiceChipActive: { backgroundColor: theme.colors.primaryAlpha(0.25), borderColor: theme.colors.primary },
  voiceText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  voiceTextActive: { color: theme.colors.primarySoft },
  fieldHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 10 },
  keyLink: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginTop: 14,
  },
  keyLinkText: { flex: 1, color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 8 },
  saveButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  saveText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
});
