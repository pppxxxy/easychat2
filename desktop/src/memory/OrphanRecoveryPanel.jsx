// 孤儿会话恢复（桌面）：把「消息还在、会话记录却丢了」的对话补回列表。
//
// 对应手机 SessionRecoveryModal（记忆页的 ⋯ → 恢复丢失的对话）。
// 数据与判定全部复用共享层 storage/sessionList/orphans.js：
//   · findOrphanSessions —— 扫 @easychat2_messages::* 的消息体，排除已删会话与
//     「按角色 id 存的老消息」，只有会话列表读得出来时才判定（读不出就抛错，
//     不能把「读不到」伪装成「没有丢失」）；
//   · restoreSession —— 沿用原 id 补回列表，并让记忆摘要一起生效。
//
// 桌面为什么需要它：这个问题在桌面同样存在（历史版本 startNewSession 曾静默删会话），
// 而没有恢复入口就意味着那些消息**永远看不到也删不掉**。界面提供「扫描 → 选择角色 →
// 恢复」三步，与手机一致。
import { useCallback, useState } from 'react';

import { useApp } from '../../../src/context/AppContext.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { findOrphanSessions, restoreSession } from '../../../src/storage/sessionList.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Row, Select } from '../settings/ui.jsx';

export default function OrphanRecoveryPanel({ palette, fonts }) {
  const { t } = useTranslation();
  const { characters, refreshSessions } = useApp();
  const [orphans, setOrphans] = useState(null);
  const [assign, setAssign] = useState({});
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const list = await findOrphanSessions();
      setOrphans(Array.isArray(list) ? list : []);
      // 默认把每段孤儿挂到第一个角色（用户可改）；与手机「选角色再恢复」的下限一致。
      const firstId = (Array.isArray(characters) && characters[0]) ? characters[0].id : '';
      const next = {};
      (Array.isArray(list) ? list : []).forEach(item => { next[item.sessionId] = firstId; });
      setAssign(next);
    } catch (error) {
      // 读不出会话列表时明确提示（不是「没有丢失的对话」——那会让用户以为数据没了）。
      Alert.alert(t('memory.scan.fail.title'), t('memory.scan.fail.body'));
      setOrphans(null);
    } finally {
      setBusy(false);
    }
  }, [busy, characters, t]);

  const recover = async orphan => {
    const characterId = assign[orphan.sessionId];
    if (!characterId || busy) return;
    setBusy(true);
    try {
      await restoreSession(orphan.sessionId, characterId);
      await refreshSessions().catch(() => {});
      setOrphans(current => (Array.isArray(current) ? current.filter(item => item.sessionId !== orphan.sessionId) : current));
      Alert.alert(t('memory.recover.success.title'), t('memory.recover.success.body'));
    } catch (error) {
      Alert.alert(t('memory.recover.fail.title'), String((error && error.message) || t('common.error.retryLater')));
    } finally {
      setBusy(false);
    }
  };

  const characterOptions = (Array.isArray(characters) ? characters : []).map(item => ({
    value: item.id,
    label: item.name || t('common.unnamedCharacter'),
  }));

  return (
    <Card title={t('memory.a11y.recover')} palette={palette} fonts={fonts}>
      <Row>
        <Button
          label={busy ? t('backup.progress.ratio') : t('memory.a11y.recover')}
          onClick={scan}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy || characterOptions.length === 0}
        />
      </Row>
      {characterOptions.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('schedule.noRoles')}</div>
      ) : null}
      {orphans !== null && orphans.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('memory.recover.success.body')}</div>
      ) : null}
      {Array.isArray(orphans) && orphans.length > 0 ? (
        <>
          <div style={{ fontSize: fonts.scaled(11), color: palette.primaryMuted || palette.primary }}>
            {t('memory.recoverNotice', { count: orphans.length })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {orphans.map(orphan => (
              <div
                key={orphan.sessionId}
                style={{
                  border: `1px solid ${palette.divider}`,
                  borderRadius: 8,
                  padding: '7px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: fonts.scaled(11),
                  color: palette.textMuted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {orphan.sessionId}
                </span>
                <Select
                  value={assign[orphan.sessionId] || ''}
                  options={characterOptions}
                  onChange={value => setAssign(current => ({ ...current, [orphan.sessionId]: value }))}
                  palette={palette}
                  fonts={fonts}
                  disabled={busy}
                />
                <Button
                  label={t('memory.a11y.recover')}
                  onClick={() => recover(orphan)}
                  palette={palette}
                  fonts={fonts}
                  disabled={busy || !assign[orphan.sessionId]}
                />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Card>
  );
}