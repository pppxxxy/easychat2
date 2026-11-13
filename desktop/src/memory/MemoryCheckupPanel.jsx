// 记忆体检（桌面）：把两层记忆（会话摘要 / 角色卡上的记忆总结条目）摊开给用户看，
// 并能停用「已经不可能被读到」的条目。
//
// 判定与清理全部复用共享层：
//   · buildMemoryCheckup（纯函数，判定口径与启动对账一致）
//   · getSessionSummariesStatus / getMessagesBySessionStatus（读盘：保留三态，不压成布尔）
//   · reconcileWorldMemories({ characterId })（只按面板列出的角色退休条目，内容不删）
//
// 读盘纪律（与 Android MemoryCheckupModal 同一条）：
//   · 单个会话读失败不中止体检，但必须计数——「读不出来」不能说成「确实没有」；
//   · boundary 判定读不到消息时保持 null（'unknown'），绝不把未知当健康，
//     也绝不凭「读不出来」去停用条目。
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { useApp } from '../../../src/context/AppContext.js';
import { getCharacterLibrary } from '../../../src/storage/characters.js';
import {
  getMessagesBySessionStatus,
  getSessionSummariesStatus,
  reconcileWorldMemories,
} from '../../../src/storage/sessions.js';
import { buildMemoryCheckup, singleChatSessionsOf } from '../../../src/memory/checkup.js';
import { Button } from '../settings/ui.jsx';

function Section({ title, children, palette, fonts }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: fonts.scaled(13), fontWeight: 800, color: palette.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

export default function MemoryCheckupPanel({ open, onClose, palette, fonts, sessions, characters }) {
  const { t } = useTranslation();
  const { refreshCharacters } = useApp();
  const [summaryStats, setSummaryStats] = useState(null);
  const [messageIds, setMessageIds] = useState(null);
  const [overrides, setOverrides] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanCount, setCleanCount] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setSummaryStats(null);
    setMessageIds(null);
    setOverrides(null);
    setCleanCount(null);
    setError('');
    (async () => {
      const targets = (Array.isArray(sessions) ? sessions : []).filter(item => item && item.id);
      let withSummaries = 0;
      let summariesCount = 0;
      let failed = 0;
      try {
        for (let index = 0; index < targets.length; index += 1) {
          if (!alive) return;
          const status = await getSessionSummariesStatus(String(targets[index].id)).catch(() => null);
          if (status && status.status === 'ok' && status.summaries.length > 0) {
            withSummaries += 1;
            summariesCount += status.summaries.length;
          } else if (
            status === null
            || status.status === 'corrupt'
            // 只有「总结过但摘要键没了」才算异常；从没总结过的会话缺键是正常形态。
            || (status.status === 'missing' && String(targets[index].summarizedUpTo || ''))
          ) {
            failed += 1;
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
            status: failed > 0 ? 'partial' : 'ok',
            done: targets.length,
            total: targets.length,
            withSummaries,
            summariesCount,
            failedSessions: failed,
          });
        }
      } catch (caught) {
        if (alive) {
          setSummaryStats({ status: 'error', done: 0, total: targets.length, withSummaries, summariesCount });
        }
      }

      // boundary 这一半：只对「恰好 1 个单聊会话」的角色读消息（其余靠会话数即可判定）。
      const byCharacter = new Map();
      for (const character of (Array.isArray(characters) ? characters : [])) {
        if (!alive) return;
        const characterId = String((character && character.id) || '');
        const owned = singleChatSessionsOf(targets, characterId);
        if (owned.length !== 1) continue;
        let ids = null;
        try {
          const state = await getMessagesBySessionStatus(String(owned[0].id || ''));
          if (state && state.status === 'ok') {
            ids = new Set((state.messages || []).map(item => String((item && item.id) || '')).filter(Boolean));
          } else if (state && state.status === 'missing') {
            ids = new Set();
          }
        } catch (caught) {
          ids = null;
        }
        byCharacter.set(characterId, ids);
      }
      if (alive) setMessageIds(byCharacter);
    })();
    return () => { alive = false; };
  }, [open, sessions, characters]);

  const report = useMemo(() => buildMemoryCheckup({
    sessions,
    characters: overrides || characters,
    summaryStats,
    messageIdsByCharacter: messageIds,
  }), [sessions, characters, overrides, summaryStats, messageIds]);

  const cleanable = report.issues.filter(item => item.issue !== 'unknown' && item.characterId);
  const unknown = report.issues.filter(item => item.issue === 'unknown');

  const clean = async () => {
    if (cleaning) return;
    setCleaning(true);
    setError('');
    try {
      let retired = 0;
      for (const item of cleanable) {
        const result = await reconcileWorldMemories({ characterId: item.characterId });
        retired += result && Number.isFinite(result.retired) ? result.retired : 0;
      }
      setCleanCount(retired);
      if (typeof refreshCharacters === 'function') await refreshCharacters().catch(() => {});
      const library = await getCharacterLibrary().catch(() => null);
      if (Array.isArray(library)) setOverrides(library);
    } catch (caught) {
      setError((caught && caught.message) || t('memory.checkup.clean.fail'));
    } finally {
      setCleaning(false);
    }
  };

  if (!open) return null;

  const stats = report.summaryStats;
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 48,
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
          width: 'min(640px, 94vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 20,
          color: palette.text,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <strong style={{ fontSize: fonts.scaled(15) }}>{t('memory.checkup.title')}</strong>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              color: palette.textMuted,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        <Section title={t('memory.checkup.sessions.title')} palette={palette} fonts={fonts}>
          <div>{t('memory.checkup.sessions.total', {
            total: report.totalSessions,
            single: report.singleSessions,
            group: report.groupSessions,
          })}
          </div>
          {!stats ? <div>{t('memory.checkup.sessions.scanning', { done: 0, total: report.totalSessions })}</div> : null}
          {stats && stats.status === 'scanning' ? (
            <div>{t('memory.checkup.sessions.scanning', { done: stats.done, total: stats.total })}</div>
          ) : null}
          {stats && stats.status !== 'scanning' ? (
            stats.withSummaries > 0 ? (
              <div>{t('memory.checkup.sessions.summaries', {
                withSummaries: stats.withSummaries,
                count: stats.summariesCount,
              })}
              </div>
            ) : (
              <div>{t('memory.checkup.sessions.none')}</div>
            )
          ) : null}
          {stats && stats.status === 'partial' ? (
            <div>{t('memory.checkup.sessions.partial', { failed: stats.failedSessions || 0 })}</div>
          ) : null}
          {stats && stats.status === 'error' ? <div>{t('memory.checkup.sessions.error')}</div> : null}
          <div style={{ color: palette.textFaint }}>{t('memory.checkup.sessions.hint')}</div>
        </Section>

        <Section title={t('memory.checkup.world.title')} palette={palette} fonts={fonts}>
          {messageIds === null ? (
            <div>{t('memory.checkup.world.reading')}</div>
          ) : report.worldEntries.length === 0 ? (
            <div>{t('memory.checkup.world.none')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {report.worldEntries.map(item => (
                <div key={item.characterId} style={{
                  border: `1px solid ${item.issue ? (palette.danger || '#ff5a5f') : palette.divider}`,
                  borderRadius: 8,
                  padding: '7px 10px',
                }}
                >
                  <div style={{ color: palette.text, fontWeight: 600 }}>
                    {item.characterName || item.characterId}
                    {item.issue ? (
                      <span style={{ marginLeft: 8, color: palette.danger || '#ff5a5f', fontWeight: 400 }}>
                        {t(`memory.checkup.issue.${item.issue}`)}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
                    {t('memory.checkup.world.row', { active: item.activeCount, sessions: item.sessionCount })}
                    {item.retiredCount > 0 ? ` · ${t('memory.checkup.world.retired', { count: item.retiredCount })}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
          {messageIds !== null && cleanable.length === 0 && unknown.length === 0 ? (
            <div style={{ color: palette.success || '#34d399' }}>{t('memory.checkup.world.healthy')}</div>
          ) : null}
          {messageIds !== null && (cleanable.length > 0 || unknown.length > 0) ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {cleanable.length > 0 ? (
                <Button
                  label={cleaning ? t('backup.progress.ratio') : t('memory.checkup.clean.action')}
                  onClick={clean}
                  palette={palette}
                  fonts={fonts}
                  disabled={cleaning}
                />
              ) : null}
            </div>
          ) : null}
          {cleanCount !== null ? (
            <div style={{ color: palette.success || '#34d399' }}>
              {cleanCount > 0
                ? t('memory.checkup.clean.done', { count: cleanCount })
                : t('memory.checkup.clean.nothing')}
            </div>
          ) : null}
          {unknown.length > 0 ? (
            <div style={{ color: palette.textFaint }}>
              {t('memory.checkup.clean.skippedUnknown', { count: unknown.length })}
            </div>
          ) : null}
          {error ? <div style={{ color: palette.danger || '#ff5a5f' }}>{error}</div> : null}
        </Section>

        <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint, lineHeight: 1.6 }}>
          {t('memory.checkup.hint')}
        </div>
      </div>
    </div>
  );
}