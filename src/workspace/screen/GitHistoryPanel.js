// 工作区「历史」领域面板（W7）：本地 git 的提交列表 + 点开看某次提交改了什么。
//
// 数据源是本地仓库（isomorphic-git，纯 JS）：设置里打开「本地版本控制」后，每轮结束会有
// 自动检查点提交，所以这里看到的就是「这几轮都干了什么」。diff 渲染复用 DiffView
//（与文件历史、提交详情同一套行模型），不另做一套。
//
// 两个刻意的选择：
// 1. **rail 上不做条件隐藏**：面板里的说明（开关关 / 外部根 / 还没建仓库）比「入口凭空消失」
//    更容易让人知道怎么打开；门控判定仍与工具逐条一致（native.js 的 gitGateReason）。
// 2. **diff 内联渲染，不弹层**：工作区面板禁止自套 Modal（guard-structure 钉着）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import DiffView from '../DiffView.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../../storage/workspace.js';
import { gitGateReason, resolveGitRunner } from '../native.js';
import { commitFileMark, formatCommitTime } from '../gitFormat.js';

export const HISTORY_DEPTH = 50;

export default function GitHistoryPanel({ characterId = 'default' }) {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

  const [status, setStatus] = useState('loading'); // loading | disabled | no-repo | empty | ready
  const [reason, setReason] = useState('');
  const [commits, setCommits] = useState([]);
  const [openOid, setOpenOid] = useState('');
  const [files, setFiles] = useState([]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [diff, setDiff] = useState(null); // { path, before, after }
  const [diffBusy, setDiffBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    setReason('');
    setCommits([]);
    setOpenOid('');
    setFiles([]);
    setDiff(null);
    let git = null;
    try {
      const settings = await getWorkspaceSettings();
      const gate = gitGateReason(settings);
      if (gate) {
        setReason(gate);
        setStatus('disabled');
        return;
      }
      git = resolveGitRunner(settings);
    } catch (error) {
      setReason('SWITCH_OFF');
      setStatus('disabled');
      return;
    }
    if (!git) {
      setReason('SWITCH_OFF');
      setStatus('disabled');
      return;
    }
    try {
      const handle = git.open({ characterId });
      if (!(await handle.isRepo())) {
        setStatus('no-repo');
        return;
      }
      const entries = await handle.log({ depth: HISTORY_DEPTH });
      setCommits(entries);
      setStatus(entries.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      setStatus('no-repo');
    }
  }, [characterId]);

  useEffect(() => { load(); }, [load]);

  const openCommit = useCallback(async commit => {
    if (openOid === commit.oid) {
      setOpenOid('');
      setFiles([]);
      setDiff(null);
      return;
    }
    setOpenOid(commit.oid);
    setFiles([]);
    setDiff(null);
    setFilesBusy(true);
    try {
      const settings = await getWorkspaceSettings();
      const git = resolveGitRunner(settings);
      if (!git) return;
      const handle = git.open({ characterId });
      setFiles(await handle.changedInCommit(commit.oid));
    } catch (error) {
      setFiles([]);
    } finally {
      setFilesBusy(false);
    }
  }, [characterId, openOid]);

  const openFile = useCallback(async (path, oid) => {
    if (diff && diff.path === path && diff.oid === oid) {
      setDiff(null);
      return;
    }
    setDiffBusy(true);
    setDiff({ path, oid, before: '', after: '' });
    try {
      const settings = await getWorkspaceSettings();
      const git = resolveGitRunner(settings);
      if (!git) return;
      const handle = git.open({ characterId });
      const texts = await handle.diffTextsInCommit(oid, path);
      setDiff({ path, oid, before: texts.before, after: texts.after });
    } catch (error) {
      setDiff(null);
    } finally {
      setDiffBusy(false);
    }
  }, [characterId, diff]);

  const renderHint = () => (
    <View style={styles.hintCard}>
      <Ionicons name="information-circle-outline" size={18} color={theme.colors.primaryMuted} />
      <Text style={styles.hintText}>
        {status === 'no-repo'
          ? t('workspace.git.noRepo')
          : (reason === 'EXTERNAL_ROOT' ? t('workspace.git.offExternal') : t('workspace.git.off'))}
      </Text>
    </View>
  );

  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('workspace.git.title')}</Text>
        <TouchableOpacity onPress={load} accessibilityLabel={t('workspace.git.refresh')} hitSlop={8}>
          <Ionicons name="refresh-outline" size={18} color={theme.colors.primarySoft} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollBody}>
        {status === 'loading' ? (
          <ActivityIndicator size="small" color={theme.colors.primary} style={styles.spinner} />
        ) : null}

        {status === 'disabled' || status === 'no-repo' ? renderHint() : null}
        {status === 'empty' ? <Text style={styles.empty}>{t('workspace.git.empty')}</Text> : null}

        {status === 'ready' ? (
          <Text style={styles.count}>{t('workspace.git.commits', { count: commits.length })}</Text>
        ) : null}

        {status === 'ready' ? commits.map(commit => {
          const open = openOid === commit.oid;
          return (
            <View key={commit.oid} style={styles.commitCard}>
              <TouchableOpacity style={styles.commitRow} onPress={() => openCommit(commit)}>
                <Ionicons
                  name={open ? 'chevron-down-outline' : 'chevron-forward-outline'}
                  size={15}
                  color={theme.colors.primaryMuted}
                />
                <View style={styles.commitText}>
                  <Text style={styles.commitMessage} numberOfLines={2}>{commit.message || t('workspace.git.noMessage')}</Text>
                  <Text style={styles.commitMeta}>{String(commit.oid).slice(0, 7)} · {formatCommitTime(commit.at)}</Text>
                </View>
              </TouchableOpacity>

              {open ? (
                <View style={styles.filesBox}>
                  {filesBusy ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : (files.length === 0 ? (
                    <Text style={styles.empty}>{t('workspace.git.noFiles')}</Text>
                  ) : (
                    <>
                      <Text style={styles.filesTitle}>{t('workspace.git.changed', { count: files.length })}</Text>
                      {files.map(item => (
                        <TouchableOpacity
                          key={item.path}
                          style={styles.fileRow}
                          onPress={() => openFile(item.path, commit.oid)}
                        >
                          <Text style={[styles.fileMark, { color: markColor(item.status, theme) }]}>
                            {commitFileMark(item.status)}
                          </Text>
                          <Text style={styles.filePath} numberOfLines={1}>{item.path}</Text>
                        </TouchableOpacity>
                      ))}
                    </>
                  ))}
                </View>
              ) : null}
            </View>
          );
        }) : null}

        {diff ? (
          <View style={styles.diffBox}>
            <Text style={styles.diffTitle}>{t('workspace.git.diffTitle', { path: diff.path })}</Text>
            {diffBusy ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <DiffView oldText={diff.before} newText={diff.after} title={diff.path} height={360} />
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function markColor(status, theme) {
  if (status === 'added') return theme.colors.success || theme.colors.primary;
  if (status === 'deleted') return theme.colors.danger || theme.colors.primary;
  return theme.colors.warning || theme.colors.primarySoft;
}

const createStyles = (theme, fonts) => StyleSheet.create({
  body: { flex: 1, paddingHorizontal: 14, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '600' },
  scrollBody: { paddingBottom: 32 },
  spinner: { marginTop: 24 },
  hintCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 10,
    backgroundColor: theme.colors.surface, marginTop: 8,
  },
  hintText: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18) },
  empty: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 8 },
  count: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginBottom: 6 },
  commitCard: {
    borderRadius: 10, backgroundColor: theme.colors.surface, marginBottom: 8, overflow: 'hidden',
  },
  commitRow: { flexDirection: 'row', alignItems: 'flex-start', padding: 10, gap: 6 },
  commitText: { flex: 1 },
  commitMessage: { color: theme.colors.text, fontSize: fonts.scaled(13) },
  commitMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  filesBox: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border, padding: 10 },
  filesTitle: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginBottom: 6 },
  fileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: 8 },
  fileMark: { fontSize: fonts.scaled(12), fontWeight: '700', width: 12 },
  filePath: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12) },
  diffBox: { marginTop: 10, borderRadius: 10, backgroundColor: theme.colors.surface, padding: 10 },
  diffTitle: { color: theme.colors.text, fontSize: fonts.scaled(12), marginBottom: 6 },
});
