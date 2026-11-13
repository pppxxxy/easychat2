// 位置（桌面）：维护「当前位置」清单，并控制是否把它随对话发给角色。
//
// 对应手机设置页的位置区（storage/location.js + location/geo.js）。桌面上
// 这套能力是**纯文本**的：用户自己写地点名（虚构也行），可选填经纬度；
// 不做真实定位（桌面没有定位权限模型），也不做地图渲染（那是扩展页的网格地图，另一域）。
//
// 注入路径在共享层 chat/chatInjections.js：**两个开关都开**才会把「[当前位置] …」
// 追加进提示词（位置分享 + 位置感知），任一关闭就是空串——不给「开了就默认分享」留后门。
// 桌面只负责改这份设置，不重写注入判定。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  getLocationSettings,
  removePlace,
  saveLocationSettings,
  upsertPlace,
} from '../../../src/storage/location.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Divider, Field, Row, Select, TextInput, Toggle } from './ui.jsx';

export default function LocationCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await getLocationSettings());
    } catch (error) {
      Alert.alert(t('settings.location.awareness.title'), t('common.error.retryLater'));
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const persist = async next => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveLocationSettings(next);
      setSettings(saved);
    } catch (error) {
      Alert.alert(t('settings.location.awareness.saveFailed'), t('settings.location.awareness.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <Card title={t('world.map.real.places.title')} palette={palette} fonts={fonts}>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      </Card>
    );
  }

  const places = Array.isArray(settings.places) ? settings.places : [];
  const placeOptions = places.length > 0
    ? places.map(item => ({ value: item.id, label: item.name }))
    : [{ value: '', label: t('world.map.real.place.empty') }];

  return (
    <Card title={t('world.map.real.places.title')} hint={t('world.map.real.places.hint')} palette={palette} fonts={fonts}>
      <Row>
        <div style={{ flex: 1, minWidth: 160 }}>
          <TextInput
            value={name}
            onChange={setName}
            placeholder={t('world.map.real.place.name.placeholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Button
          label={t('world.map.real.place.add')}
          onClick={() => {
            // 长度上限由共享层 normalizePlace 兜底截断，这里只做空白校验。
            const trimmed = String(name || '').trim();
            if (!trimmed) return;
            // 纯文本地点：不填经纬度（placeToLocation 会回落成只有名字，注入文案仍然成立）。
            persist(upsertPlace(settings, { name: trimmed }));
            setName('');
          }}
          palette={palette}
          fonts={fonts}
          primary
          disabled={!String(name || '').trim() || busy}
        />
      </Row>

      {places.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('world.map.real.place.empty')}</div>
      ) : (
        <>
          <Field label={t('world.map.real.place.name')} palette={palette} fonts={fonts}>
            <Row>
              <Select
                value={String(settings.activePlaceId || '')}
                options={placeOptions}
                onChange={value => persist({ ...settings, activePlaceId: value })}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
              <Button
                label={t('common.delete')}
                onClick={() => persist(removePlace(settings, settings.activePlaceId))}
                palette={palette}
                fonts={fonts}
                tone={palette.danger || '#ff5a5f'}
                disabled={busy || !settings.activePlaceId}
              />
            </Row>
          </Field>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {places.map(item => (
              <span
                key={item.id}
                style={{
                  fontSize: fonts.scaled(10),
                  color: palette.textMuted,
                  border: `1px solid ${item.id === settings.activePlaceId ? (palette.primaryMuted || palette.primary) : palette.divider}`,
                  borderRadius: 999,
                  padding: '1px 8px',
                }}
              >
                {item.name}
              </span>
            ))}
          </div>
        </>
      )}

      <Divider palette={palette} />
      {/* 双开关：两个都开才会注入（与共享层注入判定同一口径）。 */}
      <Toggle
        checked={settings.enabled === true}
        onChange={value => persist({ ...settings, enabled: value })}
        label={t('world.map.real.places.title')}
        palette={palette}
        fonts={fonts}
        disabled={busy}
      />
      <Toggle
        checked={settings.awareness === true}
        onChange={value => persist({ ...settings, awareness: value })}
        label={t('settings.location.awareness.title')}
        palette={palette}
        fonts={fonts}
        disabled={busy}
      />
      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
        {t('settings.location.awareness.hint')}
      </div>
    </Card>
  );
}
