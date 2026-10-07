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
import { validateBackupPayload } from './storage/dataBackup.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

const PHASE_LABEL_KEYS = {
  storage: 'backup.phase.storage',
  media: 'backup.phase.media',
  packing: 'backup.phase.packing',
  writing: 'backup.phase.writing',
};

// 失败/抢救键名在弹窗里的呈现：去掉 @easychat2_ 前缀降低视觉噪音，
// ≤3 个全列，>3 个列前 3 + 「等 N 个」（任务书 P0-1）。键名本身是存储键，
// 不是用户文案，故不经过 t()。
function formatKeyNames(keys, t) {
  const names = (Array.isArray(keys) ? keys : []).map(key => String(key).replace(/^@easychat2_/, ''));
  if (names.length === 0) return '';
  if (names.length <= 3) return names.join('、');
  return t('backup.keysTruncated', { names: names.slice(0, 3).join('、'), count: names.length });
}

function progressText(progress, t) {
  if (!progress) return t('backup.progress.busy');
  const label = t(PHASE_LABEL_KEYS[progress.phase] || 'backup.phase.busy');
  // 写盘阶段的 done/total 是字节数，按 MB 展示更可读。
  if (progress.phase === 'writing') {
    const mb = value => (Number(value || 0) / 1024 / 1024).toFixed(1);
    if (progress.total > 0 && progress.total !== progress.done) {
      return t('backup.progress.writingRatio', { label, done: mb(progress.done), total: mb(progress.total) });
    }
    return progress.done > 0
      ? t('backup.progress.writingDone', { label, done: mb(progress.done) })
      : t('backup.progress.starting', { label });
  }
  if (progress.total > 0) return t('backup.progress.ratio', { label, done: progress.done, total: progress.total });
  if (progress.done > 0) return t('backup.progress.done', { label, done: progress.done });
  return t('backup.progress.starting', { label });
}

export default function BackupPanel({ visible, onClose, onImported }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
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
      const summary = t('backup.summary', { keys: result.storageCount, media: result.mediaCount, size: (result.bytes / 1024 / 1024).toFixed(2) });
      // 读不出的键/文件会被跳过，抢救原始数据的键也在其中：必须明确告知，
      // 避免用户拿到“成功”的残缺备份。失败键名直接列出（任务书 P0-1）。
      const unreadableNames = formatKeyNames(result.unreadableKeys, t);
      const partialNames = formatKeyNames(result.partialKeys, t);
      const noteParts = [];
      if (result.incomplete) {
        noteParts.push(t('backup.incompleteNote', {
          keys: result.unreadableKeys.length,
          media: result.unreadableMedia.length,
        }));
        if (unreadableNames) noteParts.push(t('backup.incompleteNote.keys', { names: unreadableNames }));
        if (partialNames) noteParts.push(t('backup.incompleteNote.partial', { names: partialNames }));
      }
      const incompleteNote = noteParts.join('');
      if (await Sharing.isAvailableAsync()) {
        if (result.incomplete) {
          Alert.alert(t('backup.alert.incomplete.title'), t('backup.alert.incomplete.shareBody', { summary, note: incompleteNote }));
        }
        await Sharing.shareAsync(result.uri, { mimeType: 'application/json', dialogTitle: t('backup.shareDialogTitle') });
      } else if (result.incomplete) {
        Alert.alert(t('backup.alert.incomplete.title'), t('backup.alert.incomplete.body', { summary, note: incompleteNote }));
      } else {
        Alert.alert(t('backup.alert.exportDone.title'), t('backup.alert.exportDone.body', { summary }));
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        Alert.alert(t('backup.alert.exportCancelled.title'), t('backup.alert.exportCancelled.body'));
      } else {
        Alert.alert(t('backup.alert.exportFailed.title'), error.message || t('backup.alert.exportFailed.body'));
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
        Alert.alert(t('backup.alert.confirmReplace.title'), t('backup.alert.confirmReplace.body'), [
          { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('backup.alert.confirmReplace.continue'), style: 'destructive', onPress: () => resolve(true) },
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
      Alert.alert(t('backup.alert.importDone.title'), t('backup.alert.importDone.body', { keys: result.storageCount, media: result.mediaCount }));
    } catch (error) {
      Alert.alert(t('backup.alert.importFailed.title'), error.message || t('backup.alert.importFailed.body'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('backup.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.hint}>{t('backup.hint')}</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={handleExport} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="share-outline" size={18} color={theme.colors.primaryContrast} />
              <Text style={styles.primaryText}>{busy ? progressText(progress, t) : t('backup.export')}</Text>
            </TouchableOpacity>
            {busy ? (
              <>
                <Text style={styles.progressHint}>
                  {t('backup.progressHint')}
                </Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={cancelExport} activeOpacity={0.8}>
                  <Ionicons name="close-circle-outline" size={18} color={theme.colors.primarySoft} />
                  <Text style={styles.secondaryText}>{t('backup.cancelExport')}</Text>
                </TouchableOpacity>
              </>
            ) : null}
            <Text style={styles.sectionTitle}>{t('backup.restore.section')}</Text>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => handleImport('merge')} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="git-merge-outline" size={18} color={theme.colors.primarySoft} />
              <Text style={styles.secondaryText}>{t('backup.restore.merge')}</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>{t('backup.restore.mergeHint')}</Text>
            <TouchableOpacity style={styles.dangerButton} onPress={() => handleImport('replace')} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="cloud-download-outline" size={18} color={theme.colors.primaryContrast} />
              <Text style={styles.primaryText}>{t('backup.restore.replace')}</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>{t('backup.restore.replaceHint')}</Text>
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
