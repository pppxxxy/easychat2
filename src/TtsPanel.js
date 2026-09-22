import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import { FieldHint, FieldLabel, TextField } from './ui';
import { getTtsSettings, saveTtsSettings } from './storage';
import { TTS_PROVIDERS, getTtsProvider } from './tts/providers';
import { useTheme } from './theme/ThemeContext';

export default function TtsPanel({ visible, onClose }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [settings, setSettings] = useState({ enabled: false, activeProvider: 'system', providers: {} });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    getTtsSettings()
      .then(stored => {
        if (cancelled) return;
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

  const persist = useCallback(async next => {
    setSettings(next);
    try {
      await saveTtsSettings(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

  const provider = getTtsProvider(settings.activeProvider);
  const providerConfig = (settings.providers && settings.providers[provider.id]) || {};

  const setField = useCallback((key, value) => {
    const current = settings.providers || {};
    const next = {
      ...settings,
      providers: {
        ...current,
        [provider.id]: { ...(current[provider.id] || {}), [key]: value },
      },
    };
    setSettings(next);
  }, [provider.id, settings]);

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
    persist({
      ...settings,
      providers: {
        ...(settings.providers || {}),
        [provider.id]: { ...providerConfig },
      },
    }).then(() => onClose());
  }, [onClose, persist, provider.id, providerConfig, settings]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
            <FieldLabel style={styles.label}>播报源</FieldLabel>
            <View style={styles.providerRow}>
              {TTS_PROVIDERS.map(item => {
                const active = item.id === provider.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.providerChip, active && styles.providerChipActive]}
                    onPress={() => persist({ ...settings, activeProvider: item.id })}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.providerText, active && styles.providerTextActive]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

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

            {provider.engine !== 'system' && provider.signer ? (
              <Text style={styles.fieldHint}>
                该服务使用{provider.signer === 'iflytek' ? '讯飞' : provider.signer === 'tencent' ? '腾讯云' : '火山引擎'}签名，若签名校验失败可改用服务商提供的预生成令牌。
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

const createStyles = (theme, fonts) => StyleSheet.create({
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
