// J1 二期的「文件历史」入口：查看写前快照并恢复。
//
// 为什么单独一个 sheet：快照数据层（fileHistory.js）2026-10-10 之前只有记录与恢复能力，
// 但**没有任何 UI 或工具调用它**——用户够不着，等于「后悔药做了没上架」。
//
// 交互（两种形态）：
//   · 总览：列出所有有快照的文件（数量 / 最新时间 / 可恢复数）→ 点进去看某个文件；
//   · 单文件：按时间倒序列出快照 → 点一条看「与当前内容的差异」→ 恢复。
// 恢复沿用 fileHistory 的语义：**恢复前先快照当前**（天然可逆：再恢复一次就回去）。
//
// 边界（如实告知，见 hint 文案）：只覆盖 write_workspace_file / edit_workspace_file
// 改动的文件；run_shell 命令改的文件不在快照范围内。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import DiffView from './DiffView.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { shouldRecordFileHistory } from './native.js';
import {
  listFileHistory,
  listFileHistoryPaths,
  readFileHistoryEntry,
  restoreFileHistory,
} from './fileHistory.js';

const FILE_LIMIT = 50;

function formatTime(at) {
  const date = new Date(Number(at) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function FileHistorySheet({
  visible,
  onClose,
  store,
  characterId = '',
  path = '',
  onRestored,
  // W7 退旧：本地 git 开着时快照不再新增，历史以「历史」面板为准——这里只留一个指路条，
  // 不把老快照藏起来（它们仍然可看可恢复，只是不再增长）。
  onOpenHistory = null,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // 本地 git 是否接管了历史（决定要不要显示指路条）。
  const [gitTakesOver, setGitTakesOver] = useState(false);
  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    getWorkspaceSettings()
      .then(settings => { if (alive) setGitTakesOver(!shouldRecordFileHistory(settings)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [visible]);

  // 指定了 path 就直接进单文件视图；否则先看总览。
  const [activePath, setActivePath] = useState(path);
  const [overview, setOverview] = useState([]);
  const [entries, setEntries] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [preview, setPreview] = useState(null); // { entry, current }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    if (!store || typeof store.readWorkspaceFile !== 'function') {
      setOverview([]);
      setEntries([]);
      return;
    }
    setBusy(true);
    try {
      if (activePath) {
        const list = await listFileHistory(store, characterId, activePath, { limit: FILE_LIMIT });
        setEntries(list);
      } else {
        setOverview(await listFileHistoryPaths(store, characterId));
      }
    } catch (error) {
      if (activePath) setEntries([]);
      else setOverview([]);
    } finally {
      setBusy(false);
    }
  }, [store, characterId, activePath]);

  // 打开/切换视图时重读；关闭时清掉预览，避免下次打开看到上一次的内容。
  useEffect(() => {
    if (!visible) {
      setPreview(null);
      setSelectedId('');
      setNotice('');
      return;
    }
    setActivePath(path);
    setNotice('');
    setPreview(null);
    setSelectedId('');
  }, [visible, path]);

  useEffect(() => {
    if (!visible) return;
    reload();
  }, [visible, reload]);

  // 选中一条快照：读快照内容 + 当前内容，交给 DiffView 渲染「恢复后会变成什么」。
  const openPreview = useCallback(async entry => {
    if (!entry) return;
    setSelectedId(entry.id);
    setNotice('');
    if (entry.restorable === false) {
      setPreview(null);
      setNotice(t('workspace.fileHistory.notRestorable'));
      return;
    }
    setBusy(true);
    try {
      const [full, current] = await Promise.all([
        readFileHistoryEntry(store, characterId, entry.id),
        store.readWorkspaceFile({ characterId, path: entry.path }).catch(() => null),
      ]);
      setPreview({
        entry: full || entry,
        current: current && typeof current.content === 'string' ? current.content : '',
      });
    } catch (error) {
      setPreview(null);
      setNotice(t('workspace.fileHistory.restoreFail'));
    } finally {
      setBusy(false);
    }
  }, [store, characterId, t]);

  const doRestore = useCallback(async entry => {
    if (!entry) return;
    setBusy(true);
    try {
      // 当前内容读出来交给恢复逻辑：它会先快照当前（可逆），再写回旧内容。
      const current = await store.readWorkspaceFile({ characterId, path: entry.path })
        .then(result => (result && typeof result.content === 'string' ? result.content : ''))
        .catch(() => null);
      const result = await restoreFileHistory(store, characterId, entry.id, { currentContent: current });
      if (result && result.ok) {
        setNotice(t('workspace.fileHistory.restoreOk', { time: formatTime(entry.at) }));
        setPreview(null);
        setSelectedId('');
        await reload();
        if (typeof onRestored === 'function') onRestored(result.restoredPath || entry.path);
      } else {
        setNotice(t('workspace.fileHistory.restoreFail'));
      }
    } catch (error) {
      setNotice(t('workspace.fileHistory.restoreFail'));
    } finally {
      setBusy(false);
    }
  }, [store, characterId, t, reload, onRestored]);

  const confirmRestore = useCallback(entry => {
    Alert.alert(
      t('workspace.fileHistory.restoreTitle'),
      t('workspace.fileHistory.restoreBody', {
        path: entry.path,
        time: formatTime(entry.at),
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('workspace.fileHistory.restore'), onPress: () => { doRestore(entry); } },
      ]
    );
  }, [t, doRestore]);

  const sourceLabel = useCallback(source => (
    source === 'push-baseline'
      ? t('workspace.fileHistory.source.pushBaseline')
      : t('workspace.fileHistory.source.tool')
  ), [t]);

  const list = activePath ? entries : overview;
  const isEmpty = !busy && list.length === 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHeader}>
            {activePath && !path ? (
              <TouchableOpacity
                onPress={() => { setActivePath(''); setPreview(null); setSelectedId(''); setNotice(''); }}
                hitSlop={8}
                style={styles.backButton}
              >
                <Ionicons name="chevron-back" size={16} color={theme.colors.textMuted} />
                <Text style={styles.backText}>{t('workspace.fileHistory.back')}</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {activePath ? t('workspace.fileHistory.titleFile', { path: activePath }) : t('workspace.fileHistory.title')}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} style={styles.closeButton}>
              <Ionicons name="close" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>

          {gitTakesOver && onOpenHistory ? (
            <TouchableOpacity
              style={styles.gitHint}
              onPress={() => { onOpenHistory(); if (onClose) onClose(); }}
            >
              <Ionicons name="git-branch-outline" size={16} color={theme.colors.primary} />
              <Text style={styles.gitHintText}>{t('workspace.fileHistory.gitHint')}</Text>
            </TouchableOpacity>
          ) : null}

          {busy ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          ) : isEmpty ? (
            <View style={styles.center}>
              <Ionicons name="time-outline" size={30} color={theme.colors.textFaint} />
              <Text style={styles.emptyText}>
                {activePath ? t('workspace.fileHistory.emptyFile') : t('workspace.fileHistory.empty')}
              </Text>
            </View>
          ) : (
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {activePath
                ? entries.map(entry => {
                  const isBaseline = entry.id === (entries[entries.length - 1] || {}).id;
                  const selected = selectedId === entry.id;
                  return (
                    <View key={entry.id}>
                      <TouchableOpacity
                        style={[styles.row, selected && styles.rowActive]}
                        onPress={() => openPreview(entry)}
                        activeOpacity={0.8}
                      >
                        <Ionicons
                          name={entry.restorable === false ? 'alert-circle-outline' : 'document-text-outline'}
                          size={16}
                          color={selected ? theme.colors.primary : theme.colors.textFaint}
                        />
                        <View style={styles.rowTextBlock}>
                          <Text style={[styles.rowTitle, selected && styles.rowTitleActive]} numberOfLines={1}>
                            {formatTime(entry.at)}
                            {isBaseline ? ` · ${t('workspace.fileHistory.baseline')}` : ''}
                          </Text>
                          <Text style={styles.rowMeta} numberOfLines={1}>
                            {`${sourceLabel(entry.source)} · ${t('workspace.fileHistory.size', { size: entry.size })}`}
                            {entry.restorable === false ? ` · ${t('workspace.fileHistory.notRestorable')}` : ''}
                          </Text>
                        </View>
                        {entry.restorable === false ? null : (
                          <TouchableOpacity onPress={() => confirmRestore(entry)} hitSlop={8} style={styles.actionButton}>
                            <Text style={styles.actionText}>{t('workspace.fileHistory.restore')}</Text>
                          </TouchableOpacity>
                        )}
                      </TouchableOpacity>
                      {selected && preview ? (
                        <View style={styles.previewBlock}>
                          <Text style={styles.previewTitle}>{t('workspace.fileHistory.previewTitle')}</Text>
                          <DiffView
                            oldText={preview.current}
                            newText={String(preview.entry.content || '')}
                            title={entry.path}
                            height={240}
                          />
                        </View>
                      ) : null}
                    </View>
                  );
                })
                : overview.map(item => (
                  <TouchableOpacity
                    key={item.path}
                    style={styles.row}
                    onPress={() => { setActivePath(item.path); setNotice(''); }}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="document-outline" size={16} color={theme.colors.textFaint} />
                    <View style={styles.rowTextBlock}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{item.path}</Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {`${t('workspace.fileHistory.count', { count: item.count })} · ${formatTime(item.latestAt)}`}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
                  </TouchableOpacity>
                ))}
              {notice ? <Text style={styles.notice}>{notice}</Text> : null}
              <Text style={styles.hint}>{t('workspace.fileHistory.hint')}</Text>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  gitHint: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 8,
    padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface,
  },
  gitHintText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12) },
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: tokens.radius.lg,
    borderTopRightRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    maxHeight: '85%',
    paddingBottom: 10,
    ...tokens.elevation(2, theme),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', marginRight: 6 },
  backText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginLeft: 2 },
  sheetTitle: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  closeButton: { marginLeft: 8 },
  center: { alignItems: 'center', paddingVertical: 38 },
  emptyText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginTop: 10,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  list: { flexGrow: 0 },
  listContent: { paddingHorizontal: 12, paddingBottom: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  rowActive: {
    backgroundColor: theme.colors.primaryAlpha(0.15),
    borderColor: theme.colors.primary,
  },
  rowTextBlock: { flex: 1, marginLeft: 10, marginRight: 8 },
  rowTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  rowTitleActive: { color: theme.colors.primarySoft },
  rowMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 3 },
  actionButton: { paddingHorizontal: 8, paddingVertical: 4 },
  actionText: { color: theme.colors.primary, fontSize: fonts.scaled(12), fontWeight: '700' },
  previewBlock: { marginTop: 6, marginBottom: 2 },
  previewTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 6 },
  notice: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 10, textAlign: 'center' },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 14,
    paddingHorizontal: 4,
  },
});
