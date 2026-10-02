import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';

import { exportBackup, importBackup } from './storage.js';
import { validateBackupPayload } from './dataBackup.js';
import { useTheme } from './theme/ThemeContext.js';

const PHASE_LABELS = {
  storage: '读取数据键',
  media: '打包媒体文件',
  packing: '生成备份文件',
  writing: '写入备份文件',
};

function progressText(progress) {
  if (!progress) return '处理中...';
  const label = PHASE_LABELS[progress.phase] || '处理中';
  if (progress.total > 0) return `${label} ${progress.done}/${progress.total}`;
  if (progress.done > 0) return `${label} ${progress.done}`;
  return `${label}...`;
}

export default function BackupPanel({ visible, onClose, onImported }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const exportControllerRef = useRef(null);

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(null);
    const controller = new AbortController();
    exportControllerRef.current = controller;
    try {
      const result = await exportBackup({
        appVersion: '1.0.0',
        signal: controller.signal,
        onProgress: setProgress,
      });
      const summary = `${result.storageCount} 个数据键与 ${result.mediaCount} 个媒体文件（${(result.bytes / 1024 / 1024).toFixed(2)}MB）`;
      // 读不出的键/文件会被跳过：必须明确告知，避免用户拿到“成功”的残缺备份。
      const incompleteNote = result.incomplete
        ? `\n\n注意：有 ${result.unreadableKeys.length} 个数据键、${result.unreadableMedia.length} 个媒体文件读取失败，未包含在备份中。`
        : '';
      if (await Sharing.isAvailableAsync()) {
        if (result.incomplete) {
          Alert.alert('备份不完整', `已生成备份（${summary}），但部分数据读取失败${incompleteNote}\n分享的是这份不完整的备份。`);
        }
        await Sharing.shareAsync(result.uri, { mimeType: 'application/json', dialogTitle: '导出 EasyChat2 备份' });
      } else if (result.incomplete) {
        Alert.alert('备份不完整', `已生成 ${summary}，但部分数据读取失败${incompleteNote}`);
      } else {
        Alert.alert('导出完成', `已生成 ${summary}。`);
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        Alert.alert('已取消导出', '本次备份已中止，未生成备份文件。');
      } else {
        Alert.alert('导出失败', error.message || '请稍后重试。');
      }
    } finally {
      if (exportControllerRef.current === controller) exportControllerRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  const cancelExport = () => {
    exportControllerRef.current?.abort();
  };

  const handleImport = async mode => {
    if (busy) return;
    if (mode === 'replace') {
      const confirmed = await new Promise(resolve => {
        Alert.alert('确认覆盖恢复', '覆盖恢复会替换备份管理范围内的本机数据，密钥仍需重新填写。', [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '继续', style: 'destructive', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.[0]?.uri) return;
      const raw = await FileSystem.readAsStringAsync(picked.assets[0].uri);
      const payload = JSON.parse(raw);
      const validation = validateBackupPayload(payload);
      if (!validation.valid) throw new Error(validation.error);
      const result = await importBackup(payload, mode);
      await onImported?.();
      Alert.alert('恢复完成', `已恢复 ${result.storageCount} 个数据键与 ${result.mediaCount} 个媒体文件。角色、会话和外观设置已刷新，API Key 需要重新填写。`);
    } catch (error) {
      Alert.alert('导入失败', error.message || '备份文件无法恢复，现有数据保持不变。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>备份与恢复</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.hint}>备份包含角色、会话、消息、设置与媒体文件。API Key、密钥和安全存储引用不会导出。</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={handleExport} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="share-outline" size={18} color={theme.colors.primaryContrast} />
              <Text style={styles.primaryText}>{busy ? progressText(progress) : '导出备份'}</Text>
            </TouchableOpacity>
            {busy ? (
              <>
                <Text style={styles.progressHint}>
                  数据较多时导出需要一些时间，请保持 App 在前台。导出期间可随时取消。
                </Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={cancelExport} activeOpacity={0.8}>
                  <Ionicons name="close-circle-outline" size={18} color={theme.colors.primarySoft} />
                  <Text style={styles.secondaryText}>取消导出</Text>
                </TouchableOpacity>
              </>
            ) : null}
            <Text style={styles.sectionTitle}>恢复备份</Text>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => handleImport('merge')} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="git-merge-outline" size={18} color={theme.colors.primarySoft} />
              <Text style={styles.secondaryText}>合并恢复</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>同 id 数据以备份内容为准，其他本机数据保留。</Text>
            <TouchableOpacity style={styles.dangerButton} onPress={() => handleImport('replace')} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="cloud-download-outline" size={18} color={theme.colors.primaryContrast} />
              <Text style={styles.primaryText}>覆盖恢复</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>仅替换备份管理范围内的数据；恢复后 API Key 需要重新填写。</Text>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  sheet: { maxHeight: '82%', backgroundColor: theme.colors.surfaceAlt, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 18 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 12 },
  progressHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginBottom: 8 },
  sectionTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800', marginTop: 18, marginBottom: 8 },
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primary, borderRadius: tokens.radius.md, paddingVertical: 12, marginBottom: 8 },
  primaryText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 6 },
  secondaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryAlpha(0.12), borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.4), borderRadius: tokens.radius.md, paddingVertical: 12, marginBottom: 8 },
  secondaryText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 6 },
  dangerButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.danger, borderRadius: tokens.radius.md, paddingVertical: 12, marginBottom: 8 },
});
