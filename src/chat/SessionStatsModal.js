// 「本会话统计」弹窗（聊天页「⋯」菜单进入）。
//
// 展示本会话累计：token、消息条数、按 API 配置分组的请求数与生成速度
// （首字延迟 / 每秒 token），用来判断哪个服务商/模型性价比更高。
//
// 口径如实标注（面板底部有说明）：E1 起端点返回 usage 时用**真实值**（含缓存命中），
// 不返回时回退估算器——同一估算器下不同服务商可比，但不是精确计费。

import React, { useMemo } from 'react';
import { Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';
import { formatLatency, formatPercent, formatSpeed, formatTokenCount } from './sessionStatsFormat.js';

export default function SessionStatsModal({ visible, onClose, summary, messageCount = 0, onClear }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const groups = (summary && Array.isArray(summary.groups)) ? summary.groups : [];
  const hasData = Boolean(summary && summary.requests > 0);

  const row = (key, label, value) => (
    <View key={key} style={styles.statRow}>
      <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>{t('chat.stats.title')}</Text>
          <ScrollView>
            {row('messages', t('chat.stats.messages'), String(messageCount || 0))}
            {row(
              'requests',
              t('chat.stats.requests'),
              hasData
                ? (summary.failedRequests > 0
                  ? t('chat.stats.requestsWithFailed', { count: summary.requests, failed: summary.failedRequests })
                  : String(summary.requests))
                : '0'
            )}
            {row(
              'tokens',
              t('chat.stats.tokens'),
              hasData
                ? t('chat.stats.tokensDetail', {
                  total: formatTokenCount(summary.totalTokens),
                  prompt: formatTokenCount(summary.promptTokens),
                  completion: formatTokenCount(summary.completionTokens),
                })
                : '—'
            )}
            {row('latency', t('chat.stats.firstToken'), hasData ? formatLatency(summary.avgFirstTokenMs) : '—')}
            {row('speed', t('chat.stats.speed'), hasData ? formatSpeed(summary.tokensPerSec) : '—')}
            {/* E1：缓存命中——端点返回 usage 且确实有命中时才出现这一行
                （老会话/不返回 usage 的端点看不到它，不硬凑数字）。 */}
            {hasData && summary.cachedTokens > 0
              ? row(
                'cache',
                t('chat.stats.cache'),
                t('chat.stats.cacheDetail', {
                  cached: formatTokenCount(summary.cachedTokens),
                  prompt: formatTokenCount(summary.promptTokens),
                  percent: formatPercent(summary.cacheHitRate),
                })
              )
              : null}

            <Text style={styles.statSection}>{t('chat.stats.byConfig')}</Text>
            {!hasData ? (
              <Text style={styles.statEmpty}>{t('chat.stats.empty')}</Text>
            ) : null}
            {groups.map(group => (
              <View key={group.key} style={styles.statGroupCard}>
                <View style={styles.statGroupHead}>
                  <Text style={styles.statGroupTitle} numberOfLines={1}>
                    {group.label || group.key}
                    {group.model ? ` · ${group.model}` : ''}
                  </Text>
                  <Text style={styles.statGroupShare}>{formatPercent(group.share)}</Text>
                </View>
                <View style={styles.statBarTrack}>
                  <View style={[styles.statBarFill, { width: `${Math.max(2, Math.round(group.share * 100))}%` }]} />
                </View>
                <Text style={styles.statGroupMeta} numberOfLines={2}>
                  {t('chat.stats.groupMeta', {
                    count: group.requests,
                    tokens: formatTokenCount(group.totalTokens),
                    latency: formatLatency(group.avgFirstTokenMs),
                    speed: formatSpeed(group.tokensPerSec),
                  })}
                  {group.failedRequests > 0 ? ` · ${t('chat.stats.groupFailed', { failed: group.failedRequests })}` : ''}
                  {group.cachedTokens > 0 ? ` · ${t('chat.stats.groupCache', { percent: formatPercent(group.cacheHitRate) })}` : ''}
                </Text>
              </View>
            ))}

            <Text style={styles.statNote}>{t('chat.stats.note')}</Text>
          </ScrollView>

          <View style={styles.statFooter}>
            {hasData && typeof onClear === 'function' ? (
              <TouchableOpacity
                style={styles.linkRow}
                onPress={() => { onClose(); onClear(); }}
                activeOpacity={0.8}
              >
                <View style={styles.linkLeft}>
                  <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
                  <Text style={[styles.chatSettingsText, { color: theme.colors.danger }]}>
                    {t('chat.stats.clear')}
                  </Text>
                </View>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
