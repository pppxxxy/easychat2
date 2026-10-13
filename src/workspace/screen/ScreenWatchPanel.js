// SW1：工作区左栏「看屏幕」领域面板。
//
// 为什么要有它：screenWatch 原先只有聊天角色一条路（线程绑 characterId），
// 工作区助手想看屏幕得绕去「记忆 → 屏幕对话」再切角色，且线程与聊天场景混在一处。
// 本面板把工作区侧的入口开在左栏（与历史同属「回看」性质，排在它旁边），
// 三块内容：
//   ① 悬浮窗状态（支持性 / 悬浮权限 / 运行中）——复用 overlay.js 的能力查询与降级文案；
//   ② 「开始工作区会话」按钮——开启悬浮窗并落到工作区 scope 的线程；
//   ③ 工作区线程列表（scope='workspace'，点开续聊）。
//
// 边界（如实标注）：
// - SW1 只做「线程分类 + 入口」；会话真正接**工作区 agent 管线**（工具集/权限门控）
//   是 SW2 的事——在那之前，本面板的会话仍走聊天角色管线（与既有 screenWatch 一致），
//   只是线程被标记为 workspace scope，不会与聊天线程串上下文。
// - SW2/SW3 完成后，本面板的「开始会话」会经 pullController 同款的模块级控制器
//   驱动悬浮窗 mini 聊天（原生只做嘴和眼）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import {
  canDrawOverlays,
  isOverlayActive,
  isOverlaySupported,
  requestOverlayPermission,
  startOverlay,
  stopOverlay,
} from '../../screenWatch/overlay.js';
import { getScreenWatchThreads, THREAD_SCOPE_WORKSPACE } from '../../screenWatch/threads.js';
import { screenThreadPreview } from '../../memory/memoryBuckets.js';

// SW1 只做线程分类与入口，面板自身不消费 characterId（SW2 接工作区 agent 管线时才需要，
// 届时再从 props 取）——现在不声明它，避免 no-unused-vars。
export default function ScreenWatchPanel() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [supported, setSupported] = useState(true);
  const [permitted, setPermitted] = useState(true);
  const [active, setActive] = useState(false);
  const [threads, setThreads] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // 状态与线程列表一起刷新：悬浮窗状态来自原生，线程来自存储。
  const refresh = useCallback(async () => {
    setSupported(isOverlaySupported());
    try {
      setPermitted(await canDrawOverlays());
    } catch (error) {
      setPermitted(false);
    }
    try {
      setActive(await isOverlayActive());
    } catch (error) {
      setActive(false);
    }
    try {
      const list = await getScreenWatchThreads();
      setThreads((Array.isArray(list) ? list : []).filter(item => item && item.scope === THREAD_SCOPE_WORKSPACE));
    } catch (error) {
      // 读不到 ≠ 没有（与 useScreenWatchThreads 的三态口径一致）：如实说，不假装空列表。
      setThreads([]);
      setNote(t('workspace.watch.readFailed'));
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await refresh(); })();
    return () => { alive = false; };
  }, [refresh]);

  const toggleOverlay = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      if (active) {
        await stopOverlay();
        setActive(false);
      } else {
        // 权限缺失先要权限（与 ScreenWatchScreen 同一条链路），拿到再开。
        if (!permitted) {
          const granted = await requestOverlayPermission();
          setPermitted(Boolean(granted));
          if (!granted) {
            setNote(t('workspace.watch.permissionDenied'));
            return;
          }
        }
        const started = await startOverlay();
        if (started === false) {
          setNote(t('workspace.watch.startFailed'));
          return;
        }
        setActive(true);
      }
      await refresh();
    } catch (error) {
      setNote(t('workspace.watch.startFailed'));
    } finally {
      setBusy(false);
    }
  }, [active, busy, permitted, refresh, t]);

  const unsupported = !supported;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body}>
      <Text style={styles.title}>{t('workspace.watch.title')}</Text>
      <Text style={styles.hint}>{t('workspace.watch.subtitle')}</Text>

      {/* ① 悬浮窗状态：能力 / 权限 / 运行中三态如实呈现（不可用时给降级说明）。 */}
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <Ionicons
            name={active ? 'radio-outline' : 'radio-button-off-outline'}
            size={18}
            color={active ? theme.colors.primary : theme.colors.textMuted}
          />
          <Text style={styles.statusText} numberOfLines={2}>
            {unsupported
              ? t('workspace.watch.unsupported')
              : (active ? t('workspace.watch.statusOn') : t('workspace.watch.statusOff'))}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.action, (busy || unsupported) && styles.actionDisabled]}
          onPress={toggleOverlay}
          disabled={busy || unsupported}
          accessibilityRole="button"
        >
          {busy ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} /> : null}
          <Text style={styles.actionText}>
            {active ? t('workspace.watch.close') : t('workspace.watch.open')}
          </Text>
        </TouchableOpacity>
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>

      {/* ② 工作区线程列表（scope='workspace'）：与聊天线程分开，不串上下文。 */}
      <Text style={styles.sectionTitle}>{t('workspace.watch.threads')}</Text>
      {threads.length === 0 ? (
        <Text style={styles.hint}>{t('workspace.watch.empty')}</Text>
      ) : (
        threads.map(thread => (
          <View key={thread.id} style={styles.threadRow}>
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={theme.colors.textMuted} />
            <View style={styles.threadInfo}>
              <Text style={styles.threadName} numberOfLines={1}>
                {String(thread.characterName || '').trim() || t('common.characterFallback')}
              </Text>
              <Text style={styles.threadPreview} numberOfLines={1}>
                {screenThreadPreview(thread) || t('workspace.watch.emptyPreview')}
              </Text>
            </View>
            <Text style={styles.threadCount}>{thread.entries.length}</Text>
          </View>
        ))
      )}

      {/* SW2 待办如实标注：会话管线尚未切到工作区 agent（当前仍走聊天角色管线）。 */}
      <Text style={styles.footnote}>{t('workspace.watch.sw2Note')}</Text>
    </ScrollView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  body: { padding: 14, paddingBottom: 28 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '700' },
  hint: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 6, lineHeight: fonts.scaled(17) },
  card: {
    marginTop: 12,
    padding: 12,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    paddingVertical: 9,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  actionDisabled: { opacity: 0.5 },
  actionText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700' },
  note: { color: theme.colors.danger, fontSize: fonts.scaled(11.5), marginTop: 8, lineHeight: fonts.scaled(16) },
  sectionTitle: {
    color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700',
    marginTop: 18, marginBottom: 4,
  },
  threadRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 9, borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  threadInfo: { flex: 1 },
  threadName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  threadPreview: { color: theme.colors.textMuted, fontSize: fonts.scaled(11.5), marginTop: 2 },
  threadCount: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  footnote: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 18, lineHeight: fonts.scaled(16) },
});
