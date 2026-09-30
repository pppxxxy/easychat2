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

export default function TtsPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
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
           Alert.alert('播报引擎已更新', '原先选择的播报引擎已下线或不可用，已切换为系统引擎，请在下方重新选择。');
           return;
         }
         settingsRef.current = stored;
         lastSavedSettingsRef.current = stored;
         setSettings(stored);
         setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert('读取失败', '无法读取语音播报设置。');
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
        Alert.alert('保存失败', '请检查存储空间或权限。');
        return false;
      }
    });
    persistQueueRef.current = task.catch(() => false);
    return task;
  }, [loaded]);

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
        Alert.alert('无法打开链接', url);
        return;
      }
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert('无法打开链接', url);
    }
  }, [provider.apiKeyUrl]);

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
            <Text style={styles.title}>语音播报</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <FieldHint style={styles.hint}>密钥仅保存在本机，不会写入日志或文档。</FieldHint>
            <View style={styles.switchRow}>
              <View style={styles.switchTextWrap}>
                <Text style={styles.switchTitle}>自动播报</Text>
                <Text style={styles.switchHint}>开启后，角色回复完成会自动朗读；手动点消息下方「播报」不受此开关影响。</Text>
              </View>
              <Switch
                value={settings.autoBroadcast === true}
                onValueChange={value => persist({ ...settingsRef.current, autoBroadcast: value })}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            <FieldLabel style={styles.label}>播报源</FieldLabel>
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
                        Alert.alert('暂不支持', `${item.label}：${item.unsupportedNote || '当前引擎暂不支持该服务'}。`);
                        return;
                      }
                      persist({ ...settingsRef.current, activeProvider: item.id });
                    }}
                     activeOpacity={0.85}
                    accessibilityLabel={unavailable ? `${item.label}，暂不支持` : item.label}
                  >
                    <Text
                      style={[
                        styles.providerText,
                        active && styles.providerTextActive,
                        unavailable && styles.providerTextUnsupported,
                      ]}
                    >
                      {unavailable ? `${item.label}·暂不支持` : item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
             </View>

            {provider.unsupported ? (
              <FieldHint style={styles.hint}>
                {`当前引擎暂不支持：${provider.unsupportedNote || '该服务暂不可用'}。播报会失败，请选择其他引擎。`}
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
                <FieldLabel style={styles.label}>{'预置音色（可选）'}</FieldLabel>
                <View style={styles.voiceRow}>
                  <TouchableOpacity
                    style={[styles.voiceChip, !providerConfig.voice && styles.voiceChipActive]}
                    onPress={() => setField('voice', '')}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.voiceText, !providerConfig.voice && styles.voiceTextActive]}>
                      默认
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
                accessibilityLabel={`获取 ${provider.label} 的 API Key`}
              >
                <Ionicons name="open-outline" size={16} color={theme.colors.primarySoft} />
                <Text style={styles.keyLinkText}>获取 API Key / 密钥</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
              </TouchableOpacity>
            ) : null}

            {provider.engine !== 'system' && provider.signer === 'volcano' ? (
              <Text style={styles.fieldHint}>
                火山引擎使用 Bearer; 签名头，请在语音控制台获取 Access Token 与 AppID。
              </Text>
            ) : null}

            <TouchableOpacity style={styles.saveButton} onPress={onSave} activeOpacity={0.8}>
              <Text style={styles.saveText}>保存</Text>
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
