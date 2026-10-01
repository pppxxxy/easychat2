import React, { useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getLocalModelSettings, saveLocalModelSettings } from './storage.js';
import { deleteLocalModelFile, downloadLocalModel, getLocalModelFileInfo } from './localModel/modelManager.js';
import { isLocalModelModuleAvailable } from './localModel/adapter.js';
import { LOCAL_MODEL_DOWNLOAD_SOURCES } from './localModel/modelState.js';
import { useTheme } from './theme/ThemeContext.js';

export default function LocalModelPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [settings, setSettings] = useState(null);
  const [modelId, setModelId] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelUrl, setModelUrl] = useState('');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    getLocalModelSettings().then(value => {
      if (cancelled) return;
      setSettings(value);
      setModelId(value.modelId);
      setModelName(value.modelName);
      setModelUrl(value.modelUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible]);

  const handleDownload = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(0);
    try {
      const value = await downloadLocalModel({ modelId, modelName, modelUrl, onProgress: setProgress });
      const saved = await saveLocalModelSettings(value);
      setSettings(saved);
      Alert.alert('模型下载完成', '模型文件已保存，可以打开本地模型模式。');
    } catch (error) {
      Alert.alert('模型下载失败', error.message || '请检查地址与网络。');
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (!settings) return;
    const info = await getLocalModelFileInfo(settings).catch(() => ({ exists: false }));
    if (!info.exists) {
      Alert.alert('模型未就绪', '请先下载模型文件。');
      return;
    }
    const next = await saveLocalModelSettings({ ...settings, enabled: !settings.enabled });
    setSettings(next);
  };

  const handleDelete = async () => {
    if (!settings) return;
    await deleteLocalModelFile(settings);
    const next = await saveLocalModelSettings({ enabled: false });
    setSettings(next);
    setModelId('');
    setModelName('');
    setModelUrl('');
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>本地模型</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.hint}>本地模型需要包含 llama.rn 的原生构建。未完成原生构建或模型未就绪时，聊天继续使用在线 API。</Text>
            <Text style={styles.status}>{isLocalModelModuleAvailable() ? '当前构建已包含本地模型模块' : '当前构建未包含本地模型模块'}</Text>
            <Text style={styles.label}>模型 ID</Text>
            <TextInput style={styles.input} value={modelId} onChangeText={setModelId} placeholder="例如 qwen2.5-1.5b" placeholderTextColor={theme.colors.textFaint} />
            <Text style={styles.label}>模型名称</Text>
            <TextInput style={styles.input} value={modelName} onChangeText={setModelName} placeholder="展示名称" placeholderTextColor={theme.colors.textFaint} />
            <Text style={styles.label}>下载源</Text>
            <View style={styles.sourceRow}>
              {LOCAL_MODEL_DOWNLOAD_SOURCES.map(source => (
                <TouchableOpacity
                  key={source.id}
                  style={[styles.sourceChip, modelUrl.startsWith(source.baseUrl) && styles.sourceChipActive]}
                  onPress={() => setModelUrl(current => {
                    const repoPath = String(current || '').replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
                    return repoPath ? `${source.baseUrl}/${repoPath}` : `${source.baseUrl}/`;
                  })}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`使用 ${source.name} 下载源`}
                >
                  <Text style={[styles.sourceChipText, modelUrl.startsWith(source.baseUrl) && styles.sourceChipTextActive]}>
                    {source.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {LOCAL_MODEL_DOWNLOAD_SOURCES.map(source => (
              <Text key={`${source.id}-note`} style={styles.sourceNote}>{source.name}：{source.note}</Text>
            ))}
            <Text style={styles.label}>GGUF 下载地址</Text>
            <TextInput style={styles.input} value={modelUrl} onChangeText={setModelUrl} placeholder="https://huggingface.co/<repo>/resolve/main/model.gguf" placeholderTextColor={theme.colors.textFaint} autoCapitalize="none" />
            {busy ? <Text style={styles.progress}>下载进度：{Math.round(progress * 100)}%</Text> : null}
            <TouchableOpacity style={styles.primary} onPress={handleDownload} disabled={busy} activeOpacity={0.8}>
              <Text style={styles.primaryText}>{busy ? '下载中...' : '下载 / 更新模型'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondary} onPress={toggleEnabled} disabled={!settings} activeOpacity={0.8}>
              <Text style={styles.secondaryText}>{settings?.enabled ? '关闭本地模型，使用在线 API' : '启用本地模型'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.delete} onPress={handleDelete} disabled={!settings?.modelPath || busy} activeOpacity={0.8}>
              <Text style={styles.deleteText}>删除本地模型文件</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  sheet: { maxHeight: '90%', backgroundColor: theme.colors.surfaceAlt, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 18 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 10 },
  status: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginBottom: 10 },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  sourceChip: {
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
    backgroundColor: theme.colors.primaryAlpha(0.12),
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
    marginBottom: 8,
  },
  sourceChipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.22) },
  sourceChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700' },
  sourceChipTextActive: { color: theme.colors.primary },
  sourceNote: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 2 },
  label: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 10, marginBottom: 5 },
  input: { minHeight: 42, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, backgroundColor: theme.colors.surface, color: theme.colors.text, paddingHorizontal: 12, paddingVertical: 9 },
  progress: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 10 },
  primary: { backgroundColor: theme.colors.primary, borderRadius: tokens.radius.md, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  primaryText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
  secondary: { backgroundColor: theme.colors.primaryAlpha(0.12), borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.4), borderRadius: tokens.radius.md, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  secondaryText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700' },
  delete: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  deleteText: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(13), fontWeight: '700' },
});
