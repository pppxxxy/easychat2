// 本会话统计（桌面）：请求数 / token / 首字延迟 / 生成速度 / 按配置分组。
//
// 数据本来就在落盘（共享层 useChatSend 每次请求都 recordSessionRequest），
// 手机版有 SessionStatsModal 读它，桌面此前没有任何入口——用户看不到「哪个服务商
// 更划算」这类信息。本面板补上这个入口，展示口径与手机逐条对齐：
//   · 端点返回 usage 时是真实值（含缓存命中），不返回时回退估算；
//   · 分组按请求数从多到少；组内 token/延迟/速度/缓存命中率都用同一套格式化函数；
//   · 无数据时明确说「还没有请求记录」，不显示一排 0 假装有数据。
import { useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { summarizeStats } from '../../../src/chat/sessionStats.js';
import {
  formatLatency,
  formatPercent,
  formatSpeed,
  formatTokenCount,
} from '../../../src/chat/sessionStatsFormat.js';
import { clearSessionStats, getSessionStats } from '../../../src/storage/sessionStats.js';
import { Alert } from '../platform/alert.js';
import { Button } from '../settings/ui.jsx';

function StatRow({ label, value, palette, fonts }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', justifyContent: 'space-between' }}>
      <span style={{ fontSize: fonts.scaled(12), color: palette.textMuted, flex: 'none' }}>{label}</span>
      <span style={{
        fontSize: fonts.scaled(12),
        color: palette.text,
        textAlign: 'right',
        minWidth: 0,
        wordBreak: 'break-word',
        fontVariantNumeric: 'tabular-nums',
      }}
      >
        {value}
      </span>
    </div>
  );
}

export default function SessionStatsPanel({
  open,
  onClose,
  sessionId,
  messageCount = 0,
  palette,
  fonts,
  onCleared,
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState(null);
  const [clearing, setClearing] = useState(false);

  // 每次打开都重读：统计是随请求累加的，缓存住会显示上一次的旧数字。
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setSummary(null);
    getSessionStats(sessionId)
      .then(stats => {
        if (!cancelled) setSummary(summarizeStats(stats));
      })
      .catch(() => {
        // 读失败不假装是「没有数据」：给空摘要但保留 messageCount 一行仍然有用，
        // 真正的失败已由存储层自己的三态处理（损坏时不写回）。
        if (!cancelled) setSummary(summarizeStats(null));
      });
    return () => { cancelled = true; };
  }, [open, sessionId]);

  if (!open) return null;

  const data = summary;
  const hasData = Boolean(data && data.requests > 0);
  const groups = data && Array.isArray(data.groups) ? data.groups : [];

  const clear = () => {
    if (!sessionId || clearing) return;
    Alert.alert(
      t('chat.stats.clearConfirm.title'),
      t('chat.stats.clearConfirm.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chat.stats.clearConfirm.confirm'),
          style: 'destructive',
          onPress: () => {
            setClearing(true);
            clearSessionStats(sessionId)
              .then(() => {
                setSummary(summarizeStats(null));
                if (typeof onCleared === 'function') onCleared();
              })
              .catch(() => Alert.alert(t('chat.stats.clearConfirm.title'), t('common.error.retryLater')))
              .then(() => setClearing(false));
          },
        },
      ]
    );
  };

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 49,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(560px, 94vw)',
          maxHeight: '86vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 20,
          color: palette.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(15) }}>{t('chat.stats.title')}</strong>
          <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
        </div>

        {!data ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
        ) : (
          <>
            <StatRow label={t('chat.stats.messages')} value={String(messageCount || 0)} palette={palette} fonts={fonts} />
            <StatRow
              label={t('chat.stats.requests')}
              value={hasData
                ? (data.failedRequests > 0
                  ? t('chat.stats.requestsWithFailed', { count: data.requests, failed: data.failedRequests })
                  : String(data.requests))
                : '0'}
              palette={palette}
              fonts={fonts}
            />
            <StatRow
              label={t('chat.stats.tokens')}
              value={hasData
                ? t('chat.stats.tokensDetail', {
                  total: formatTokenCount(data.totalTokens),
                  prompt: formatTokenCount(data.promptTokens),
                  completion: formatTokenCount(data.completionTokens),
                })
                : '—'}
              palette={palette}
              fonts={fonts}
            />
            <StatRow
              label={t('chat.stats.firstToken')}
              value={hasData ? formatLatency(data.avgFirstTokenMs) : '—'}
              palette={palette}
              fonts={fonts}
            />
            <StatRow
              label={t('chat.stats.speed')}
              value={hasData ? formatSpeed(data.tokensPerSec) : '—'}
              palette={palette}
              fonts={fonts}
            />
            {/* 缓存命中只在「端点确实返回 usage 且有命中」时出现：
                老会话/不返回 usage 的端点看不到这一行，不硬凑数字。 */}
            {hasData && data.cachedTokens > 0 ? (
              <StatRow
                label={t('chat.stats.cache')}
                value={t('chat.stats.cacheDetail', {
                  cached: formatTokenCount(data.cachedTokens),
                  prompt: formatTokenCount(data.promptTokens),
                  percent: formatPercent(data.cacheHitRate),
                })}
                palette={palette}
                fonts={fonts}
              />
            ) : null}

            <div style={{ fontSize: fonts.scaled(12), fontWeight: 700, marginTop: 4 }}>
              {t('chat.stats.byConfig')}
            </div>
            {!hasData ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('chat.stats.empty')}</div>
            ) : null}
            {groups.map(group => (
              <div
                key={group.key}
                style={{
                  border: `1px solid ${palette.divider}`,
                  borderRadius: 10,
                  padding: '8px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{
                    fontSize: fonts.scaled(12),
                    fontWeight: 700,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  >
                    {group.label || group.key}
                    {group.model ? ` · ${group.model}` : ''}
                  </span>
                  <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted, flex: 'none' }}>
                    {formatPercent(group.share)}
                  </span>
                </div>
                {/* 占比条：与手机的 statBarFill 同口径（至少 2% 宽度，避免看不见）。 */}
                <div style={{ height: 4, borderRadius: 2, background: palette.surfaceAlt, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.max(2, Math.round(group.share * 100))}%`,
                    background: palette.primaryMuted || palette.primary,
                  }}
                  />
                </div>
                <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.5 }}>
                  {t('chat.stats.groupMeta', {
                    count: group.requests,
                    tokens: formatTokenCount(group.totalTokens),
                    latency: formatLatency(group.avgFirstTokenMs),
                    speed: formatSpeed(group.tokensPerSec),
                  })}
                  {group.failedRequests > 0
                    ? ` · ${t('chat.stats.groupFailed', { failed: group.failedRequests })}`
                    : ''}
                  {group.cachedTokens > 0
                    ? ` · ${t('chat.stats.groupCache', { percent: formatPercent(group.cacheHitRate) })}`
                    : ''}
                </span>
              </div>
            ))}

            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6, marginTop: 2 }}>
              {t('chat.stats.note')}
            </div>
            {hasData ? (
              <div>
                <Button
                  label={clearing ? t('backup.progress.ratio') : t('chat.stats.clear')}
                  onClick={clear}
                  palette={palette}
                  fonts={fonts}
                  tone={palette.danger || '#ff5a5f'}
                  disabled={clearing}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}