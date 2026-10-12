// 记忆体检弹层（Phase 4）：把两层记忆摊开给用户看，并提供「清理不可用条目」的维护入口。
//
//   · 会话级摘要：多少个会话有摘要、共多少条（逐会话读，带进度——多会话时可能慢）；
//   · 角色卡上的「记忆总结」条目：每个角色生效多少条、是否还有合法读者
//     （内置助手 / 多会话 / 无会话承载 / boundary 不属于唯一会话 = 读不到或读不到本该读到的）。
//
// 「清理」只做一件安全的事：把不可能被读到的条目退休（enabled:false + stale:true，
// 内容保留），即调用与启动对账同一个 reconcileWorldMemories。绝不删内容。
// 清理按**面板列出的角色逐个**调用（characterId），不再全库对账：按钮说的是
// 「停用这些读不到的条目」，那就只动这些（先例：storage/memoryOwnership.js:91 已支持
// characterId 参数），否则用户会看到「停用了 N 条」却对不上自己看到的列表。
//
// 读盘一律保留状态、不压成布尔：摘要读失败（corrupt）与「没有摘要」在界面上必须分开
//（sessions.partial / sessions.error），角色卡条目的 boundary 判不出来时显示「无法判定」
//（issue.unknown）而不是绿勾——否则就是「体检说正常、对账在悄悄改」。

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
import { getCharacterLibrary } from '../storage/characters.js';
import {
  getMessagesBySessionStatus,
  getSessionSummariesStatus,
  reconcileWorldMemories,
} from '../storage/sessions.js';
import { Card, FieldHint, GhostButton, PrimaryButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

import { buildMemoryCheckup, singleChatSessionsOf } from './checkup.js';

export default function MemoryCheckupModal({ visible, onClose, sessions = [], characters = [] }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();
  const { refreshCharacters } = useApp();

  // 清理后角色库变了（storage 直接改盘），这里留一份本地覆盖数据，报告立即刷新；
  // 同时让 AppContext 重新读盘，避免内存快照过期后在编辑角色时把退休标记覆盖回去。
  const [overrides, setOverrides] = useState(null);
  const [summaryStats, setSummaryStats] = useState(null);
  // 唯一会话角色的消息 id 集合（Map<角色 id, Set | null>），供 boundary 判定。
  const [messageIdsByCharacter, setMessageIdsByCharacter] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanCount, setCleanCount] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setOverrides(null);
    setSummaryStats(null);
    setMessageIdsByCharacter(null);
    setCleanCount(null);
    setError('');
    (async () => {
      const targets = (Array.isArray(sessions) ? sessions : []).filter(item => item && item.id);
      let withSummaries = 0;
      let summariesCount = 0;
      let failedSessions = 0;
      try {
        for (let index = 0; index < targets.length; index += 1) {
          if (!alive) return;
          const target = targets[index];
          // 单个会话读失败不中止体检：跳过它、其余照常统计；但**必须记下来**——
          // getSessionSummariesStatus 对 corrupt 返回 {status:'corrupt'}（不抛），
          // 只认 'ok' 会把「读不出来」和「没有摘要」压成同一种显示。
          const status = await getSessionSummariesStatus(String(target.id)).catch(() => null);
          if (status && status.status === 'ok' && status.summaries.length > 0) {
            withSummaries += 1;
            summariesCount += status.summaries.length;
          } else if (
            status === null
            || status.status === 'corrupt'
            // 'missing' 只有在这个会话**已经总结过**（会话行上还留着 summarizedUpTo 边界）
            // 时才算异常：appendSessionSummary 先写摘要、再推边界，所以边界在而摘要键
            // 没了 = 摘要真的丢了。从没总结过的会话缺键是正常形态（新会话都这样），
            // 算进去会变成「每个新会话一条假警报」。
            || (status.status === 'missing' && String(target.summarizedUpTo || ''))
          ) {
            failedSessions += 1;
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
            // 有读不出来的会话就是 'partial'，不能报 'ok'：否则界面会显示
            // 「还没有任何会话记忆摘要」，把「读失败」说成「确实没有」。
            status: failedSessions > 0 ? 'partial' : 'ok',
            done: targets.length,
            total: targets.length,
            withSummaries,
            summariesCount,
            failedSessions,
          });
        }
      } catch (caught) {
        if (alive) {
          setSummaryStats({ status: 'error', done: 0, total: targets.length, withSummaries, summariesCount });
        }
      }

      // P1-4：唯一会话角色的条目是否合法，还取决于 boundary 是否属于那个会话。
      // 会话数那一半 worldMemoryIssue 自己算；这一半要读消息，所以照
      // storage/memoryOwnership.js:37-59（planRetireForCharacter）的做法，
      // 只对「恰好 1 个单聊会话」的角色读一次。
      const idsByCharacter = new Map();
      for (const character of (Array.isArray(characters) ? characters : [])) {
        if (!alive) return;
        const characterId = String((character && character.id) || '');
        const owned = singleChatSessionsOf(targets, characterId);
        if (owned.length !== 1) continue; // 0 / ≥2 个会话由会话数即可判定，不必读消息
        let ids = null;
        try {
          const state = await getMessagesBySessionStatus(String(owned[0].id || ''));
          if (state && state.status === 'ok') {
            ids = new Set((state.messages || [])
              .map(item => String((item && item.id) || ''))
              .filter(Boolean));
          } else if (state && state.status === 'missing') {
            // 会话行在、消息体从没写过：boundary 不可能命中（与对账的 [] 同口径）。
            ids = new Set();
          }
          // corrupt：保持 null —— 读不出来就是「无法判定」，绝不猜成健康。
        } catch (caught) {
          ids = null;
        }
        idsByCharacter.set(characterId, ids);
      }
      if (alive) setMessageIdsByCharacter(idsByCharacter);
    })();
    return () => { alive = false; };
  }, [visible, sessions, characters]);

  const report = useMemo(() => buildMemoryCheckup({
    sessions,
    characters: overrides || characters,
    summaryStats,
    messageIdsByCharacter,
  }), [sessions, characters, overrides, summaryStats, messageIdsByCharacter]);

  // 'unknown' = 消息读不出来、无法判定（见 checkup.js worldMemoryIssue）：
  // 这些角色不进「清理」名单——凭「读不出来」去退休条目，正是
  // planWorldMemoryRetire 对 messageIds=null 刻意不做的猜测。
  const cleanableIssues = report.issues.filter(item => item.issue !== 'unknown' && item.characterId);
  const unknownIssues = report.issues.filter(item => item.issue === 'unknown');

  const handleClean = useCallback(async () => {
    if (cleaning) return;
    setCleaning(true);
    setError('');
    try {
      // 逐角色清理（memoryOwnership.js:91 已支持 characterId）：按钮说的是
      // 「停用这些读不到的条目」，那就只动面板列出的这些角色，不做全库对账——
      // 全库对账会连带停用用户从未被告知的条目（尤其是体检没列出来的那些）。
      let retired = 0;
      for (const item of cleanableIssues) {
        const result = await reconcileWorldMemories({ characterId: item.characterId });
        retired += result && Number.isFinite(result.retired) ? result.retired : 0;
      }
      setCleanCount(retired);
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
  }, [cleaning, cleanableIssues, refreshCharacters, t]);

  // 「清理」区域：没有可清理的问题时显示「结构正常」。
  const renderWorldActions = () => {
    // 归属判定还没读完（messageIdsByCharacter 还是 null）：此时什么都别下结论，
    // 更不能显示「结构正常」——那正是「未知当健康」。
    if (messageIdsByCharacter === null) return null;
    if (cleanableIssues.length === 0 && unknownIssues.length === 0) {
      return <Text style={styles.healthyLine}>{t('memory.checkup.world.healthy')}</Text>;
    }
    return (
      <>
        {cleanableIssues.length > 0 ? (
          <PrimaryButton
            title={t('memory.checkup.clean.action')}
            onPress={handleClean}
            loading={cleaning}
            disabled={cleaning}
            style={styles.cleanButton}
          />
        ) : null}
        {unknownIssues.length > 0 ? (
          <Text style={styles.doneLine}>
            {t('memory.checkup.clean.skippedUnknown', { count: unknownIssues.length })}
          </Text>
        ) : null}
        {cleanCount !== null ? (
          <Text style={styles.doneLine}>
            {cleanCount > 0
              ? t('memory.checkup.clean.done', { count: cleanCount })
              : t('memory.checkup.clean.nothing')}
          </Text>
        ) : null}
      </>
    );
  };

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
            {/* 'partial'：部分会话摘要读不出来。有摘要就照常报数，但不许在
                summariesCount === 0 时显示「还没有任何会话记忆摘要」——那会把
                「读失败」说成「确实没有」；改为只显示失败条数。 */}
            {summaryStats && (summaryStats.status === 'ok' || summaryStats.status === 'partial')
              && summaryStats.summariesCount > 0 ? (
                <Text style={styles.line}>
                  {t('memory.checkup.sessions.summaries', {
                    withSummaries: summaryStats.withSummaries,
                    count: summaryStats.summariesCount,
                  })}
                </Text>
              ) : null}
            {summaryStats && summaryStats.status === 'ok' && summaryStats.summariesCount === 0 ? (
              <Text style={styles.line}>{t('memory.checkup.sessions.none')}</Text>
            ) : null}
            {summaryStats && summaryStats.status === 'partial' ? (
              <Text style={styles.doneLine}>
                {t('memory.checkup.sessions.partial', { failed: summaryStats.failedSessions })}
              </Text>
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

            {messageIdsByCharacter === null ? (
              // 归属判定（boundary 比对）还没读完：不能先按「无法判定」把徽章刷一遍
              // 再翻成正常——buildMemoryCheckup 对「未读到消息」的角色返回 'unknown'，
              // 那正是它该有的语义，只是不该在加载中出现。先给一个读盘提示。
              <View style={styles.scanRow}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <Text style={styles.line}>{t('memory.checkup.world.reading')}</Text>
              </View>
            ) : report.worldEntries.length === 0 ? (
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

            {renderWorldActions()}
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
