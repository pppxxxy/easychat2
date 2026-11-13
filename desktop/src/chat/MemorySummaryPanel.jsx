// 记忆总结面板（桌面）：对应手机 chat/MemorySummarySheet。
//
// 两个动作：改设置（开关 / 阈值 / 记忆长度），或「开始总结」。
// 口径照抄手机（用户指定过）：
//   · 总结**开启**时，发送的是摘要 + 全部历史，记忆长度不生效 → 那一行隐藏，
//     只留一条说明（否则用户会以为改了没用）；
//   · 总结**关闭**时没有摘要兜底，改为只发最近「记忆长度」轮。
// 写入走 patchMemorySummarySettings（不是整体写）：设置页的预设卡也在编辑同一份设置，
// 整体写会把对方改的字段打回默认。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  DEFAULT_MEMORY_LENGTH,
  MEMORY_LENGTH_MAX,
  getMemorySummarySettings,
  patchMemorySummarySettings,
} from '../../../src/storage/settings.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, TextInput, Toggle } from '../settings/ui.jsx';

// 与存储层同口径的整数解析：非法/非正数回落 fallback，超上限截断。
function normalizeInt(raw, fallback, max = 0) {
  const parsed = Math.trunc(Number(String(raw).trim()));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max > 0 ? Math.min(parsed, max) : parsed;
}

export default function MemorySummaryPanel({
  open,
  onClose,
  onSummarize,
  summarizing,
  canSummarize,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState('');
  const [length, setLength] = useState(String(DEFAULT_MEMORY_LENGTH));

  // 每次打开都重读：设置页那边也可能刚改过。
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoaded(false);
    getMemorySummarySettings()
      .then(settings => {
        if (cancelled) return;
        setSaved(settings);
        setEnabled(settings.enabled);
        setThreshold(String(settings.threshold));
        setLength(String(settings.historyRounds));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert(t('preset.alert.loadFailed.title'), t('preset.alert.loadFailed.body'));
      });
    return () => { cancelled = true; };
  }, [open, t]);

  const persist = useCallback(async () => {
    if (!saved) return false;
    const nextThreshold = normalizeInt(threshold, saved.threshold);
    const nextLength = normalizeInt(length, saved.historyRounds, MEMORY_LENGTH_MAX);
    if (nextThreshold !== Math.trunc(Number(String(threshold).trim()))) {
      Alert.alert(
        t('preset.alert.thresholdInvalid.title'),
        t('preset.alert.thresholdInvalid.body', { fallback: nextThreshold })
      );
    }
    if (nextLength !== Math.trunc(Number(String(length).trim()))) {
      Alert.alert(
        t('chat.summary.settings.lengthInvalid.title'),
        t('chat.summary.settings.lengthInvalid.body', { max: MEMORY_LENGTH_MAX, fallback: nextLength })
      );
    }
    setBusy(true);
    try {
      const next = await patchMemorySummarySettings({
        enabled,
        threshold: nextThreshold,
        historyRounds: nextLength,
      });
      setSaved(next);
      setEnabled(next.enabled);
      setThreshold(String(next.threshold));
      setLength(String(next.historyRounds));
      return true;
    } catch (error) {
      Alert.alert(t('preset.alert.saveFailed.title'), t('preset.alert.saveFailed.body'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [enabled, length, saved, t, threshold]);

  if (!open) return null;

  // 开始总结前先把草稿落地：面板里看到的值就是这次总结要用的值。
  const summarize = async () => {
    if (!loaded || busy || summarizing || !canSummarize) return;
    if (!(await persist())) return;
    onClose();
    if (typeof onSummarize === 'function') onSummarize();
  };

  return (
    <div
      role="presentation"
      onClick={() => { if (!busy) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{ width: 'min(520px, 94vw)', maxHeight: '86vh', overflow: 'auto' }}
      >
        <Card title={t('chat.summary.settings.title')} palette={palette} fonts={fonts}>
          {!loaded ? (
            <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
          ) : (
            <>
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                label={t('preset.memory.title')}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
              <Field label={t('preset.memory.thresholdLabel')} palette={palette} fonts={fonts}>
                <div style={{ width: 140 }}>
                  <TextInput
                    value={threshold}
                    onChange={setThreshold}
                    type="number"
                    palette={palette}
                    fonts={fonts}
                    disabled={busy}
                  />
                </div>
              </Field>
              {/* 总结开启时记忆长度不生效 → 那一行隐藏，只留说明。 */}
              {enabled ? (
                <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
                  {t('chat.summary.settings.lengthDisabled')}
                </div>
              ) : (
                <Field
                  label={t('chat.summary.settings.lengthLabel')}
                  hint={t('chat.summary.settings.lengthHint', { rounds: normalizeInt(length, DEFAULT_MEMORY_LENGTH, MEMORY_LENGTH_MAX) })}
                  palette={palette}
                  fonts={fonts}
                >
                  <div style={{ width: 140 }}>
                    <TextInput
                      value={length}
                      onChange={setLength}
                      type="number"
                      palette={palette}
                      fonts={fonts}
                      disabled={busy}
                    />
                  </div>
                </Field>
              )}
              <Row>
                <Button
                  label={busy ? t('backup.progress.ratio') : t('common.save')}
                  onClick={async () => { if (await persist()) onClose(); }}
                  palette={palette}
                  fonts={fonts}
                  disabled={busy}
                />
                <Button
                  label={summarizing ? t('chat.menu.summarizing') : t('chat.menu.summary')}
                  onClick={summarize}
                  palette={palette}
                  fonts={fonts}
                  primary
                  disabled={busy || summarizing || !canSummarize}
                />
                <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} disabled={busy} />
              </Row>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
