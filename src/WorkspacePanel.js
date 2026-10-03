// 工作区面板：浏览当前角色沙盒内的文本/Markdown 与导出的 .docx。
// - 文本文件：预览、复制、分享、删除；
// - 可改模式：新建文本、把一段文本导出为 Word（.docx），并分享；
// - 顶部只读展示当前工作模式（在设置页修改），提示只读/询问模式下不可写。
// 入口在「设置 → 工作区」卡片。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { EmptyState, FieldHint, FieldLabel, GhostButton, PrimaryButton, SheetHeader, TextField } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { getWorkspaceSettings } from './storage.js';
import { buildDocxBytes, bytesToBase64, splitDocxParagraphs } from './workspace/docx.js';
import { getWorkspaceFileSystem, defaultWorkspaceRoot } from './workspace/native.js';
import { isAllowedWorkspaceFile, sandboxDirectory } from './workspace/paths.js';
import { ensureDocxFileName, ensureTextFileName, isDocxName, sanitizeWorkspaceFileName } from './workspace/naming.js';
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from './workspace/store.js';

const MODE_LABEL_KEY = { ask: 'settings.workspace.mode.ask', read: 'settings.workspace.mode.read', write: 'settings.workspace.mode.write' };

export default function WorkspacePanel({ visible, onClose, characterId = 'default' }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const fileSystem = useMemo(() => getWorkspaceFileSystem(), []);
  const root = useMemo(() => defaultWorkspaceRoot(), []);

  const [mode, setMode] = useState('ask');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  // 编辑表单：{ kind:'text'|'docx', name, content } | null
  const [form, setForm] = useState(null);

  const canWrite = mode === 'write';
  const sandboxRoot = useMemo(() => sandboxDirectory(root, characterId), [root, characterId]);

  const fileUri = useCallback(name => `${sandboxRoot}${name}`, [sandboxRoot]);

  const refresh = useCallback(async () => {
    if (!fileSystem) {
      setError(t('workspace.panel.err.fileSystem'));
      return;
    }
    setLoading(true);
    try {
      const list = await listWorkspaceFiles({ root, characterId, fileSystem });
      setFiles(list);
      setError('');
    } catch (caught) {
      setError(t('workspace.panel.err.read'));
    } finally {
      setLoading(false);
    }
  }, [characterId, fileSystem, root, t]);

  useEffect(() => {
    if (!visible) return;
    getWorkspaceSettings()
      .then(settings => setMode(settings.mode))
      .catch(() => {});
    setPreview(null);
    setForm(null);
    refresh();
  }, [visible, refresh]);

  const shareFile = useCallback(async name => {
    try {
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(fileUri(name), { dialogTitle: t('workspace.panel.share.dialog', { name }) });
        return;
      }
      if (isAllowedWorkspaceFile(name)) {
        const result = await readWorkspaceFile({ root, characterId, path: name, fileSystem });
        await Clipboard.setStringAsync(result.content);
        Alert.alert(t('workspace.panel.copied.title'), t('workspace.panel.copied.body'));
        return;
      }
      Alert.alert(t('workspace.panel.err.share'), t('workspace.panel.err.shareUnsupported'));
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.share'), t('workspace.panel.err.share'));
    }
  }, [characterId, fileSystem, fileUri, root, t]);

  const openFile = useCallback(async name => {
    if (String(name || '').endsWith('/')) return;
    if (!isAllowedWorkspaceFile(name)) {
      shareFile(name);
      return;
    }
    try {
      const result = await readWorkspaceFile({ root, characterId, path: name, fileSystem });
      setPreview(result);
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.open'), t('workspace.panel.err.open'));
    }
  }, [characterId, fileSystem, root, shareFile, t]);

  const handleDelete = useCallback(name => {
    Alert.alert(t('workspace.panel.delete.title'), t('workspace.panel.delete.body', { name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          FileSystem.deleteAsync(fileUri(name), { idempotent: true })
            .then(() => {
              setFiles(list => list.filter(entry => entry !== name));
              if (preview && preview.path === name) setPreview(null);
            })
            .catch(() => Alert.alert(t('workspace.panel.err.delete'), t('workspace.panel.err.delete')));
        },
      },
    ]);
  }, [fileUri, preview, t]);

  const startTextForm = useCallback(() => {
    if (!canWrite) {
      Alert.alert(t('workspace.panel.locked.title'), t('workspace.panel.locked.body'));
      return;
    }
    setForm({ kind: 'text', name: '', content: '' });
  }, [canWrite, t]);

  const startDocxForm = useCallback(() => {
    if (!canWrite) {
      Alert.alert(t('workspace.panel.locked.title'), t('workspace.panel.locked.body'));
      return;
    }
    setForm({ kind: 'docx', name: '', content: '' });
  }, [canWrite, t]);

  const submitForm = useCallback(async () => {
    if (!form) return;
    const content = String(form.content || '');
    try {
      if (form.kind === 'text') {
        const path = ensureTextFileName(form.name);
        await writeWorkspaceFile({ root, characterId, path, content, fileSystem });
      } else {
        const path = ensureDocxFileName(form.name);
        const bytes = buildDocxBytes({
          title: sanitizeWorkspaceFileName(form.name, ''),
          paragraphs: splitDocxParagraphs(content),
        });
        await writeWorkspaceBinaryFile({ root, characterId, path, base64: bytesToBase64(bytes), fileSystem });
      }
      setForm(null);
      await refresh();
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.save'), t('workspace.panel.err.save'));
    }
  }, [characterId, fileSystem, form, refresh, root, t]);

  const modeLabel = t(MODE_LABEL_KEY[mode] || MODE_LABEL_KEY.ask);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <SheetHeader title={t('workspace.panel.title')} onClose={onClose} />

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.modeRow}>
            <Ionicons name="briefcase-outline" size={15} color={theme.colors.primaryMuted} />
            <Text style={styles.modeText}>
              {t('workspace.panel.mode.prefix')}{modeLabel}
              {canWrite ? t('workspace.panel.mode.suffixWrite') : t('workspace.panel.mode.suffixReadonly')}
            </Text>
          </View>
          <Text style={styles.sandboxHint} numberOfLines={1}>{t('workspace.panel.sandbox', { id: characterId })}</Text>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.actionButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startTextForm}
              activeOpacity={0.85}
            >
              <Ionicons name="document-text-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>{t('workspace.panel.newText')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startDocxForm}
              activeOpacity={0.85}
            >
              <Ionicons name="download-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>{t('workspace.panel.exportWord')}</Text>
            </TouchableOpacity>
          </View>

          {form ? (
            <View style={styles.formCard}>
              <FieldLabel>{form.kind === 'text' ? t('workspace.panel.form.newText') : t('workspace.panel.form.exportWord')}</FieldLabel>
              <TextField
                style={styles.input}
                placeholder={form.kind === 'text' ? t('workspace.panel.form.nameText') : t('workspace.panel.form.nameDocx')}
                value={form.name}
                onChangeText={value => setForm(current => ({ ...current, name: value }))}
              />
              <TextField
                style={[styles.input, styles.contentInput]}
                placeholder={t('workspace.panel.form.content')}
                value={form.content}
                onChangeText={value => setForm(current => ({ ...current, content: value }))}
                multiline
              />
              <View style={styles.formActions}>
                <GhostButton title={t('common.cancel')} small onPress={() => setForm(null)} />
                <PrimaryButton title={t('common.save')} small onPress={submitForm} />
              </View>
            </View>
          ) : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.colors.primary} /></View>
          ) : null}

          {!loading && files.length === 0 && !error ? (
            <EmptyState
              icon="briefcase-outline"
              title={t('workspace.panel.empty.title')}
              description={canWrite
                ? t('workspace.panel.empty.write')
                : t('workspace.panel.empty.read')}
            />
          ) : null}

          {files.map(name => (
            <View key={name} style={styles.fileRow}>
              <TouchableOpacity style={styles.fileMain} onPress={() => openFile(name)} activeOpacity={0.8}>
                <Ionicons
                  name={String(name).endsWith('/') ? 'folder-outline' : (isDocxName(name) ? 'document-outline' : 'document-text-outline')}
                  size={16}
                  color={theme.colors.primaryMuted}
                />
                <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
              </TouchableOpacity>
              {!String(name).endsWith('/') ? (
                <>
                  <TouchableOpacity style={styles.fileAction} onPress={() => shareFile(name)} accessibilityLabel={t('workspace.panel.a11y.share', { name })}>
                    <Ionicons name="share-outline" size={16} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.fileAction} onPress={() => handleDelete(name)} accessibilityLabel={t('workspace.panel.a11y.delete', { name })}>
                    <Ionicons name="trash-outline" size={16} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          ))}
        </ScrollView>

        <Modal visible={!!preview} animationType="slide" onRequestClose={() => setPreview(null)}>
          <View style={styles.container}>
            <SheetHeader title={preview ? preview.path : ''} onClose={() => setPreview(null)} />
            <ScrollView contentContainerStyle={styles.body}>
              <FieldHint>{preview && preview.truncated ? t('workspace.panel.preview.truncated') : t('workspace.panel.preview.hint')}</FieldHint>
              <Text style={styles.previewText}>{preview ? preview.content : ''}</Text>
              <View style={styles.formActions}>
                <GhostButton
                  title={t('common.copy')}
                  small
                  onPress={() => {
                    if (preview) Clipboard.setStringAsync(preview.content).catch(() => {});
                  }}
                />
                <GhostButton title={t('workspace.panel.a11y.share', { name: preview ? preview.path : '' })} small onPress={() => { if (preview) shareFile(preview.path); }} />
              </View>
            </ScrollView>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  modeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  modeText: { color: theme.colors.text, fontSize: fonts.scaled(13), marginLeft: 6, flex: 1 },
  sandboxHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 12 },
  errorText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), marginBottom: 10 },
  actionRow: { flexDirection: 'row', marginBottom: 12 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 10,
  },
  actionButtonDisabled: { opacity: 0.5 },
  actionText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 5 },
  formCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.metrics.cardPadding,
    marginBottom: 12,
  },
  input: { marginTop: 8 },
  contentInput: { minHeight: 120, textAlignVertical: 'top' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 20 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  fileMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  fileName: { color: theme.colors.text, fontSize: fonts.scaled(13), marginLeft: 8, flex: 1 },
  fileAction: { paddingHorizontal: 6, paddingVertical: 4 },
  previewText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(20), marginTop: 8 },
});