// W2：回合小结（「本次改了什么」+ 撤销）。
//
// 为什么要有它：工具卡片让用户看见**每一步**，但一轮下来真正想知道的是「一共动了哪些文件，
// 不满意能不能退回去」。数据来自最后一个助手消息的工具轨迹（conversation.js 的 turnChanges），
// 所以不需要新的持久化——轨迹本来就在。
//
// 撤销怎么做的（重要，别简化）：
//   不重写历史、不 reset。取 HEAD 的**父提交**，把本轮碰过的文件恢复成那时候的样子
//   （那时不存在的就删掉——否则「撤销」会留下一堆本轮新建的文件），然后**照常提交一次
//   「回滚」**。于是回滚本身也在历史里、可追溯、可再撤销一次。破坏性最小的那个做法。
//
// 门控如实：本地版本控制没开时不给假按钮，直接说明「撤销需要先打开它，或到「文件历史」
// 逐文件恢复」——工作区里那条回退路径一直都在（fileHistory）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../../storage/workspace.js';
import { resolveGitRunner, shouldRecordFileHistory } from '../native.js';
import { turnChanges } from '../conversation.js';

// git 的改动状态 → 展示用操作名（与工具轨迹的 op 同一套）。
const OP_BY_STATUS = Object.freeze({ added: 'write', modified: 'edit', deleted: 'delete' });

const OP_KEYS = Object.freeze({
  write: 'workspace.chat.summary.op.write',
  edit: 'workspace.chat.summary.op.edit',
  mkdir: 'workspace.chat.summary.op.mkdir',
  delete: 'workspace.chat.summary.op.delete',
});

export default function TurnSummaryPanel({ characterId = 'default', messages = null }) {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gitOn, setGitOn] = useState(false);

  useEffect(() => {
    let alive = true;
    getWorkspaceSettings()
      .then(settings => { if (alive) setGitOn(!shouldRecordFileHistory(settings)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [characterId]);

  // 从会话事实推导「本次改了什么」——调用方只传 messages，不新增持久化。
  const changes = useMemo(() => turnChanges(messages), [messages]);
  // W2①：git 开着时以**最近一次提交**为准（那就是本轮的检查点）——它能看见 run_shell
  // 改的文件，而工具轨迹看不见（轨迹里只有写类工具）。git 关着/没仓库时退回工具轨迹推导。
  const [gitFiles, setGitFiles] = useState(null);
  useEffect(() => {
    if (!gitOn) {
      setGitFiles(null);
      return undefined;
    }
    let alive = true;
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        const runner = resolveGitRunner(settings);
        if (!runner) return;
        const handle = runner.open({ characterId });
        if (!(await handle.isRepo())) return;
        const commits = await handle.log({ depth: 1 });
        if (!commits.length) return;
        const changed = await handle.changedInCommit(commits[0].oid);
        if (alive) {
          setGitFiles(changed.map(row => ({ path: row.path, op: OP_BY_STATUS[row.status] || 'edit', count: 1 })));
        }
      } catch (error) {
        // 取不到就退回工具轨迹推导，不打扰用户。
      }
    })();
    return () => { alive = false; };
  }, [characterId, gitOn, messages]);

  const traced = (changes && Array.isArray(changes.files)) ? changes.files : [];
  const files = (gitFiles && gitFiles.length > 0) ? gitFiles : traced;

  const undo = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const settings = await getWorkspaceSettings();
      const runner = resolveGitRunner(settings);
      if (!runner) {
        Alert.alert(t('workspace.chat.summary.undo'), t('workspace.chat.summary.undoHint'));
        return;
      }
      const handle = runner.open({ characterId });
      if (!(await handle.isRepo())) {
        Alert.alert(t('workspace.chat.summary.undo'), t('workspace.chat.summary.undoHint'));
        return;
      }
      const parent = await handle.parentOfHead();
      if (!parent) {
        Alert.alert(t('workspace.chat.summary.undo'), t('workspace.chat.summary.noParent'));
        return;
      }
      const result = await handle.restorePathsFrom(parent, files.map(item => item.path));
      await handle.commitAll(t('workspace.chat.summary.commitMessage', { count: files.length }));
      Alert.alert(
        t('workspace.chat.summary.doneTitle'),
        t('workspace.chat.summary.doneBody', { count: result.restored + result.removed, removed: result.removed }),
      );
    } catch (error) {
      Alert.alert(t('workspace.chat.summary.failTitle'), String((error && error.message) || ''));
    } finally {
      setBusy(false);
    }
  }, [busy, characterId, files, t]);

  if (files.length === 0) return null;

  return (
    <View style={styles.panel}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setCollapsed(value => !value)}
        activeOpacity={0.8}
      >
        <Ionicons name="git-commit-outline" size={14} color={theme.colors.primary} />
        <Text style={styles.title} numberOfLines={1}>
          {t('workspace.chat.summary.title', { count: files.length })}
        </Text>
        <Ionicons
          name={collapsed ? 'chevron-down' : 'chevron-up'}
          size={14}
          color={theme.colors.textFaint}
        />
      </TouchableOpacity>

      {collapsed ? null : files.map(item => (
        <View key={item.path} style={styles.row}>
          <Text style={styles.op} numberOfLines={1}>{t(OP_KEYS[item.op] || OP_KEYS.edit)}</Text>
          <Text style={styles.path} numberOfLines={1}>{item.path}</Text>
          {item.count > 1 ? <Text style={styles.count}>{`×${item.count}`}</Text> : null}
        </View>
      ))}

      {collapsed ? null : (gitOn ? (
        <TouchableOpacity style={styles.undo} onPress={undo} activeOpacity={0.8} disabled={busy}>
          {busy
            ? <ActivityIndicator size="small" color={theme.colors.primary} />
            : <Ionicons name="arrow-undo-outline" size={14} color={theme.colors.primary} />}
          <Text style={styles.undoText}>{t('workspace.chat.summary.undo')}</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.hint}>{t('workspace.chat.summary.undoHint')}</Text>
      ))}
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  panel: {
    marginHorizontal: 12, marginBottom: 4, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 10, backgroundColor: theme.colors.surface,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12.5), fontWeight: '600', marginLeft: 6 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 5, gap: 6 },
  op: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), width: 48 },
  path: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(11.5) },
  count: { color: theme.colors.textFaint, fontSize: fonts.scaled(10.5) },
  undo: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 },
  undoText: { color: theme.colors.primary, fontSize: fonts.scaled(12) },
  hint: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginTop: 8, lineHeight: fonts.scaled(16) },
});
