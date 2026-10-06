// 记忆体检弹层（Phase 4）：把两层记忆摊开给用户看，并提供「清理不可用条目」的维护入口。
//
//   · 会话级摘要：多少个会话有摘要、共多少条（逐会话读，带进度——多会话时可能慢）；
//   · 角色卡上的「记忆总结」条目：每个角色生效多少条、是否还有合法读者
//     （内置助手 / 多会话 / 无会话承载 = 已不可能被读到）。
//
// 「清理」只做一件安全的事：把不可能被读到的条目退休（enabled:false + stale:true，
// 内容保留），即调用与启动对账同一个 reconcileWorldMemories。绝不删内容。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useApp } from '../context/AppContext.js';
import {
  getCharacterLibrary,
  getSessionSummariesStatus,
  reconcileWorldMemories,
} from '../storage.js';
import { Card, FieldHint, GhostButton, PrimaryButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

import { buildMemoryCheckup } from './checkup.js';

export default function MemoryCheckupModal({ visible, onClose, sessions = [], characters = [] }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();
  const { refreshCharacters } = useApp();

  // 清理后角色库变了（storage 直接改盘），这里留一份本地覆盖数据，报告立即刷新；
  // 同时让 AppContext 重新读盘，避免内存快照过期后在编辑角色时把退休标记覆盖回去。
  const [overrides, setOverrides] = useState(null);
  const [summaryStats, setSummaryStats] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanCount, setCleanCount] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setOverrides(null);
    setSummaryStats(null);
    setCleanCount(null);
    setError('');
    (async () => {
      const targets = (Array.isArray(sessions) ? sessions : []).filter(item => item && item.id);
      let withSummaries = 0;
      let summariesCount = 0;
      try {
        for (let index = 0; index < targets.length; index += 1) {
          if (!alive) return;
          // 单个会话读失败不中止体检：跳过它，其余照常统计。
          const status = await getSessionSummariesStatus(String(targets[index].id)).catch(() => null);
          if (status && status.status === 'ok' && status.summaries.length > 0) {
            withSummaries += 1;
            summariesCount += status.summaries.length;
          }
          if (alive) {
            setSummaryStats({
              status: 'scanning',
              done: index + 1,
              total: targets.length,
              withSummaries,
              summariesCount,
            });
          }
        }
        if (alive) {
          setSummaryStats({
            status: 'ok',
            done: targets.length,
            total: targets.length,
            withSummaries,
            summariesCount,
          });
        }
      } catch (caught) {
        if (alive) {
          setSummaryStats({ status: 'error', done: 0, total: targets.length, withSummaries, summariesCount });
        }
      }
    })();
    return () => { alive = false; };
  }, [visible, sessions]);

  const report = useMemo(() => buildMemoryCheckup({
    sessions,
    characters: overrides || characters,
    summaryStats,
  }), [sessions, characters, overrides, summaryStats]);

  const handleClean = useCallback(async () => {
    if (cleaning) return;
    setCleaning(true);
    setError('');
    try {
      const result = await reconcileWorldMemories();
      setCleanCount(result && Number.isFinite(result.retired) ? result.retired : 0);
      // 重新读盘（storage 已改），并让 AppContext 同步内存角色库——不然用户随后
      // 编辑角色时会用旧快照整表覆盖，把刚打上的退休标记抹掉。
      if (typeof refreshCharacters === 'function') await refreshCharacters().catch(() => {});
      const library = await getCharacterLibrary().catch(() => null);
      if (Array.isArray(library)) setOverrides(library);
    } catch (caught) {
      setError((caught && caught.message) || t('memory.checkup.clean.fail'));
    } finally {
      setCleaning(false);
    }
  }, [cleaning, refreshCharacters, t]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('memory.checkup.title')}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Card style={styles.card}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="chatbubbles-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('memory.checkup.sessions.title')}</Text>
            </View>
            <Text style={styles.line}>
              {t('memory.checkup.sessions.total', {
                total: report.totalSessions,
                single: report.singleSessions,
                group: report.groupSessions,
              })}
            </Text>
            {summaryStats && summaryStats.status === 'scanning' ? (
              <View style={styles.scanRow}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <Text style={styles.line}>
                  {t('memory.checkup.sessions.scanning', {
                    done: summaryStats.done,
                    total: summaryStats.total,
                  })}
                </Text>
              </View>
            ) : null}
            {summaryStats && summaryStats.status === 'ok' ? (
              summaryStats.summariesCount > 0 ? (
                <Text style={styles.line}>
                  {t('memory.checkup.sessions.summaries', {
                    withSummaries: summaryStats.withSummaries,
                    count: summaryStats.summariesCount,
                  })}
                </Text>
              ) : (
                <Text style={styles.line}>{t('memory.checkup.sessions.none')}</Text>
              )
            ) : null}
            {summaryStats && summaryStats.status === 'error' ? (
              <Text style={styles.line}>{t('memory.checkup.sessions.error')}</Text>
            ) : null}
            <FieldHint style={styles.hint}>{t('memory.checkup.sessions.hint')}</FieldHint>
          </Card>

          <Card style={styles.card}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="id-card-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('memory.checkup.world.title')}</Text>
            </View>

            {report.worldEntries.length === 0 ? (
              <Text style={styles.line}>{t('memory.checkup.world.none')}</Text>
            ) : report.worldEntries.map(item => (
              <View key={item.characterId || item.characterName} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {item.characterName || t('memory.unnamedCharacter')}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {t('memory.checkup.world.row', {
                      active: item.activeCount,
                      sessions: item.sessionCount,
                    })}
                    {item.retiredCount > 0
                      ? ` · ${t('memory.checkup.world.retired', { count: item.retiredCount })}`
                      : ''}
                  </Text>
                </View>
                {item.issue ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{t(`memory.checkup.issue.${item.issue}`)}</Text>
                  </View>
                ) : (
                  <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
                )}
              </View>
            ))}

            {report.issues.length > 0 ? (
              <>
                <PrimaryButton
                  title={t('memory.checkup.clean.action')}
                  onPress={handleClean}
                  loading={cleaning}
                  disabled={cleaning}
                  style={styles.cleanButton}
                />
                {cleanCount !== null ? (
                  <Text style={styles.doneLine}>
                    {cleanCount > 0
                      ? t('memory.checkup.clean.done', { count: cleanCount })
                      : t('memory.checkup.clean.nothing')}
                  </Text>
                ) : null}
              </>
            ) : (
              <Text style={styles.healthyLine}>{t('memory.checkup.world.healthy')}</Text>
            )}
            <FieldHint style={styles.hint}>{t('memory.checkup.hint')}</FieldHint>
          </Card>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.footer}>
            <GhostButton title={t('common.close')} onPress={onClose} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 32 },
  card: { marginBottom: tokens.metrics.cardGap },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 6 },
  line: {
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(19),
    marginTop: 4,
  },
  scanRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  rowMain: { flex: 1, marginRight: 8 },
  rowName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  rowMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  badge: {
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), fontWeight: '700' },
  cleanButton: { marginTop: 12 },
  doneLine: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 10, lineHeight: fonts.scaled(18) },
  healthyLine: { color: theme.colors.primary, fontSize: fonts.scaled(12), marginTop: 10 },
  errorText: {
    color: theme.colors.danger || theme.colors.text,
    fontSize: fonts.scaled(12),
    marginTop: 4,
    marginBottom: 8,
  },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 8 },
});
