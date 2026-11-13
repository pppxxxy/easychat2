// 生成参数卡（采样）：最大回复令牌 / 温度 / top-p / top-k，逐项开关。
// 存储走共享层 getSamplingSettings / saveSamplingSettings（含「读不出就拒绝写」守卫）。
import { useEffect, useRef, useState } from 'react';

import {
  SAMPLING_FIELDS,
  getSamplingSettings,
  saveSamplingSettings,
} from '../../../src/storage/settings.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Toggle } from './ui.jsx';

const FIELD_LABELS = {
  maxTokens: 'settings.sampling.maxTokens',
  temperature: 'settings.sampling.temperature',
  topP: 'settings.sampling.topP',
  topK: 'settings.sampling.topK',
};

export default function SamplingCard({ palette, fonts }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    getSamplingSettings()
      .then(value => { if (mountedRef.current) setSettings(value); })
      .catch(() => {
        if (mountedRef.current) {
          Alert.alert(tRef.current('settings.sampling.alert.saveFailed.title'), tRef.current('settings.sampling.alert.saveFailed.body'));
        }
      });
    return () => { mountedRef.current = false; };
  }, []);

  const patch = (name, next) => {
    setSettings(current => (current ? { ...current, [name]: { ...current[name], ...next } } : current));
  };

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const saved = await saveSamplingSettings(settings);
      if (mountedRef.current) {
        setSettings(saved);
        Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
      }
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert(t('settings.sampling.alert.saveFailed.title'), t('settings.sampling.alert.saveFailed.body'));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const enabledCount = settings
    ? Object.values(settings).filter(item => item && item.enabled).length
    : 0;

  return (
    <Card
      title={t('settings.sampling.title')}
      hint={t('settings.sampling.hint')}
      palette={palette}
      fonts={fonts}
    >
      {!settings ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : (
        <>
          <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
            {t('settings.sampling.enabledCount', { count: enabledCount })}
          </div>
          {Object.keys(SAMPLING_FIELDS).map(name => {
            const rule = SAMPLING_FIELDS[name];
            const item = settings[name];
            return (
              <Field
                key={name}
                label={t(FIELD_LABELS[name])}
                hint={`${rule.min} – ${rule.max}${rule.integer ? ' · integer' : ''}`}
                palette={palette}
                fonts={fonts}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Toggle
                    checked={!!item.enabled}
                    onChange={value => patch(name, { enabled: value })}
                    label=""
                    palette={palette}
                    fonts={fonts}
                  />
                  <input
                    type="number"
                    min={rule.min}
                    max={rule.max}
                    step={rule.integer ? 1 : 0.01}
                    value={item.enabled ? item.value : ''}
                    placeholder={item.enabled ? '' : t('settings.sampling.serverDefault')}
                    disabled={!item.enabled}
                    onChange={event => {
                      const raw = event.target.value;
                      patch(name, { value: raw === '' ? '' : Number(raw) });
                    }}
                    style={{
                      flex: 1,
                      background: palette.surfaceAlt,
                      color: palette.text,
                      border: `1px solid ${palette.divider}`,
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: fonts.scaled(13),
                      outline: 'none',
                      opacity: item.enabled ? 1 : 0.6,
                    }}
                  />
                </div>
              </Field>
            );
          })}
          <div>
            <Button
              label={saving ? t('backup.progress.ratio') : t('common.save')}
              onClick={save}
              palette={palette}
              fonts={fonts}
              primary
              disabled={saving}
            />
          </div>
        </>
      )}
    </Card>
  );
}