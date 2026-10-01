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
import { getTranscriptionSettings, saveTranscriptionSettings } from './storage.js';
import { TRANSCRIPTION_API_VENDORS } from './apiVendors.js';
import { useTheme } from './theme/ThemeContext.js';

const REUSED_ID = '__reused__';

function makeConfigId() {
  return `stt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function TranscriptionPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
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
        if (!cancelled) Alert.alert('读取失败', '无法读取语音转文字设置。');
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
      Alert.alert('保存失败', '请检查存储空间或权限。');
      return null;
    }
  }, []);

  const selectSource = useCallback(id => {
    persist({ ...settingsRef.current, activeId: id === REUSED_ID ? '' : id });
  }, [persist]);

  const addConfig = useCallback(vendor => {
    const preset = vendor && typeof vendor === 'object' ? vendor : null;
    const next = {
      id: makeConfigId(),
      name: preset ? preset.name : '新配置',
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
  }, [persist]);

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
            <Text style={styles.title}>语音转文字</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <FieldHint style={styles.hint}>
              发送语音时，音频会上传到所选服务商转写成文字。密钥仅保存在本机，不会写入日志或文档。
            </FieldHint>

            <FieldLabel style={styles.label}>转写来源</FieldLabel>

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
                <Text style={styles.optionTitle}>仅复用当前聊天来源</Text>
                <Text style={styles.optionMeta}>用当前 API 配置调用 /v1/audio/transcriptions，无需额外填写</Text>
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
                      <Text style={styles.optionTitle}>{config.name || '未命名配置'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => removeConfig(config.id)}
                      hitSlop={8}
                      accessibilityLabel="删除配置"
                    >
                      <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
                    </TouchableOpacity>
                  </View>
                  <FieldLabel style={styles.label}>名称</FieldLabel>
                  <TextField
                    value={config.name}
                    onChangeText={value => updateConfig(config.id, 'name', value)}
                    placeholder="例如：Whisper 官方"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <FieldLabel style={styles.label}>接口地址</FieldLabel>
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
                    placeholder="在服务商控制台获取"
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
                        accessibilityLabel={`获取${getVendorForConfig(config).name} API Key`}
                      >
                        <Text style={styles.keyLink}>获取密钥</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <FieldLabel style={styles.label}>模型名</FieldLabel>
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

            <FieldLabel style={styles.label}>新增独立转写配置</FieldLabel>
            <FieldHint style={styles.hint}>
              点厂商一键预填端点与模型，再填入该厂商的 API Key 即可。
            </FieldHint>
            <View style={styles.vendorRow}>
              {TRANSCRIPTION_API_VENDORS.map(vendor => (
                <TouchableOpacity
                  key={vendor.id}
                  style={styles.vendorChip}
                  onPress={() => addConfig(vendor)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`新增${vendor.name}转写配置`}
                >
                  <Text style={styles.vendorChipText}>{vendor.name}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[styles.vendorChip, styles.vendorChipCustom]}
                onPress={() => addConfig(null)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="新增自定义转写配置"
              >
                <Text style={styles.vendorChipCustomText}>自定义</Text>
              </TouchableOpacity>
            </View>
            {TRANSCRIPTION_API_VENDORS.map(vendor => (
              <Text key={`${vendor.id}-note`} style={styles.vendorNote}>
                {vendor.name}：{vendor.note}
              </Text>
            ))}

            <TouchableOpacity style={styles.saveButton} onPress={onClose} activeOpacity={0.8}>
              <Text style={styles.saveText}>完成</Text>
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
