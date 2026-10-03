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

const MODE_LABEL = { ask: '询问', read: '只读', write: '可改' };

export default function WorkspacePanel({ visible, onClose, characterId = 'default' }) {
  const { theme, fonts, tokens } = useTheme();
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
      setError('当前环境无法访问工作区文件系统。');
      return;
    }
    setLoading(true);
    try {
      const list = await listWorkspaceFiles({ root, characterId, fileSystem });
      setFiles(list);
      setError('');
    } catch (caught) {
      setError('读取工作区失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, [characterId, fileSystem, root]);

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
        await Sharing.shareAsync(fileUri(name), { dialogTitle: `分享 ${name}` });
        return;
      }
      if (isAllowedWorkspaceFile(name)) {
        const result = await readWorkspaceFile({ root, characterId, path: name, fileSystem });
        await Clipboard.setStringAsync(result.content);
        Alert.alert('已复制', '当前环境不支持分享，文本内容已复制到剪贴板。');
        return;
      }
      Alert.alert('无法分享', '当前环境不支持文件分享。');
    } catch (caught) {
      Alert.alert('分享失败', '无法分享该文件，请稍后重试。');
    }
  }, [characterId, fileSystem, fileUri, root]);

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
      Alert.alert('打开失败', '文件读取失败，可能已被清理。');
    }
  }, [characterId, fileSystem, root, shareFile]);

  const handleDelete = useCallback(name => {
    Alert.alert('删除文件', `确定从工作区删除「${name}」吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          FileSystem.deleteAsync(fileUri(name), { idempotent: true })
            .then(() => {
              setFiles(list => list.filter(entry => entry !== name));
              if (preview && preview.path === name) setPreview(null);
            })
            .catch(() => Alert.alert('删除失败', '文件删除失败，请稍后重试。'));
        },
      },
    ]);
  }, [fileUri, preview]);

  const startTextForm = useCallback(() => {
    if (!canWrite) {
      Alert.alert('当前模式不可写', '请到「设置 → 工作区」把模式切换为「可改」。');
      return;
    }
    setForm({ kind: 'text', name: '', content: '' });
  }, [canWrite]);

  const startDocxForm = useCallback(() => {
    if (!canWrite) {
      Alert.alert('当前模式不可写', '请到「设置 → 工作区」把模式切换为「可改」。');
      return;
    }
    setForm({ kind: 'docx', name: '', content: '' });
  }, [canWrite]);

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
      Alert.alert('保存失败', '写入失败，请检查是否越出工作区或磁盘空间不足。');
    }
  }, [characterId, fileSystem, form, refresh, root]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <SheetHeader title="工作区" onClose={onClose} />

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.modeRow}>
            <Ionicons name="briefcase-outline" size={15} color={theme.colors.primaryMuted} />
            <Text style={styles.modeText}>
              当前模式：{MODE_LABEL[mode] || mode}
              {canWrite ? '（可新建/修改/导出）' : '（只读浏览；要写入请到设置改为「可改」）'}
            </Text>
          </View>
          <Text style={styles.sandboxHint} numberOfLines={1}>沙盒：{characterId}</Text>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.actionButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startTextForm}
              activeOpacity={0.85}
            >
              <Ionicons name="document-text-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>新建文本</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startDocxForm}
              activeOpacity={0.85}
            >
              <Ionicons name="download-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>导出 Word</Text>
            </TouchableOpacity>
          </View>

          {form ? (
            <View style={styles.formCard}>
              <FieldLabel>{form.kind === 'text' ? '新建文本文件' : '导出 Word 文档'}</FieldLabel>
              <TextField
                style={styles.input}
                placeholder={form.kind === 'text' ? '文件名（如 笔记.txt）' : '文档标题'}
                value={form.name}
                onChangeText={value => setForm(current => ({ ...current, name: value }))}
              />
              <TextField
                style={[styles.input, styles.contentInput]}
                placeholder="正文内容（换行分段）"
                value={form.content}
                onChangeText={value => setForm(current => ({ ...current, content: value }))}
                multiline
              />
              <View style={styles.formActions}>
                <GhostButton title="取消" small onPress={() => setForm(null)} />
                <PrimaryButton title="保存" small onPress={submitForm} />
              </View>
            </View>
          ) : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.colors.primary} /></View>
          ) : null}

          {!loading && files.length === 0 && !error ? (
            <EmptyState
              icon="briefcase-outline"
              title="工作区还是空的"
              description={canWrite
                ? '新建文本或导出 Word 后，文件会出现在这里；开启 agent 后角色也能读写它们。'
                : '角色在「可改」模式下写入的文件会出现在这里。'}
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
                  <TouchableOpacity style={styles.fileAction} onPress={() => shareFile(name)} accessibilityLabel={`分享 ${name}`}>
                    <Ionicons name="share-outline" size={16} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.fileAction} onPress={() => handleDelete(name)} accessibilityLabel={`删除 ${name}`}>
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
              <FieldHint>{preview && preview.truncated ? '内容较长，仅显示前 1MB。' : '文本预览（只读）'}</FieldHint>
              <Text style={styles.previewText}>{preview ? preview.content : ''}</Text>
              <View style={styles.formActions}>
                <GhostButton
                  title="复制"
                  small
                  onPress={() => {
                    if (preview) Clipboard.setStringAsync(preview.content).catch(() => {});
                  }}
                />
                <GhostButton title="分享" small onPress={() => { if (preview) shareFile(preview.path); }} />
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