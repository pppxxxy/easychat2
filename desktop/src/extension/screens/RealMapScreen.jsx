// 真实地图（桌面）：对应手机 worldMap/RealMapView.js 的「地图 + 位置列表」部分。
//
// 地图本体完全复用共享层 worldMap/realMapHtml.js 的 buildRealMapHtml：
// 自绘 slippy map（Web Mercator 瓦片拼贴，无外部 CDN），并且已经处理好脚本注入
// 转义（safeJson 把 < > & 转成 \uXXXX）。桌面用 <iframe srcDoc> 承载同一份 HTML，
// 再通过 contentWindow 调它暴露的 __setView / __setMarker / __clearMarker。
//
// 与手机的差别只有两处，都是平台事实：
//   · 手机用 WebView + injectJavaScript；桌面用 iframe + contentWindow 直调；
//   · 手机经 wgs84ToGcj02 把用户填的 WGS-84 坐标转成高德瓦片用的 GCJ-02；
//     桌面调同一个共享函数（location/geo.js），不重写偏移算法。
//
// 数据与校验全在共享层 storage/location.js：PLACE_LIMIT、normalizePlace、
// upsertPlace、removePlace、saveLocationSettings（读坏时拒绝写）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  PLACE_LIMIT,
  getLocationSettings,
  removePlace,
  saveLocationSettings,
  upsertPlace,
} from '../../../../src/storage/location.js';
import { formatCoordinate, wgs84ToGcj02 } from '../../../../src/location/geo.js';
import { buildRealMapHtml } from '../../../../src/worldMap/realMapHtml.js';
import { Alert } from '../../platform/alert.js';
import { Button, Card, Field, Row } from '../../settings/ui.jsx';

const EMPTY_PLACE = { name: '', latitude: '', longitude: '', share: false };

export default function RealMapScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(EMPTY_PLACE);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const next = await getLocationSettings();
      setSettings(next);
      setLoadFailed(false);
    } catch (error) {
      // 读坏时不冒充「没有任何位置」：那会让用户以为位置丢了，一保存还会覆盖。
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const places = useMemo(
    () => (settings && Array.isArray(settings.places) ? settings.places : []),
    [settings]
  );
  const selected = places.find(item => item.id === selectedId) || null;

  // 地图 HTML：瓦片地址与文案来自共享构建器（同一份模板，两端不可能画得不一样）。
  const html = useMemo(() => buildRealMapHtml({
    tileUrl: settings && settings.tileUrl ? settings.tileUrl : undefined,
    subdomains: settings && settings.subdomains ? settings.subdomains : undefined,
    strings: {
      attribution: t('world.map.real.html.attribution'),
      zoomIn: t('world.map.real.html.zoomIn'),
      zoomOut: t('world.map.real.html.zoomOut'),
      recenter: t('world.map.real.html.recenter'),
      hint: t('world.map.real.html.hint'),
    },
  }), [settings, t]);

  // 把选中位置标到地图上：WGS-84 → GCJ-02（与手机同一个共享函数）。
  useEffect(() => {
    const frame = frameRef.current;
    const win = frame && frame.contentWindow;
    if (!win) return;
    const lat = Number(selected && selected.latitude);
    const lng = Number(selected && selected.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const gcj = wgs84ToGcj02(lat, lng);
      if (win.__setMarker) win.__setMarker(gcj.latitude, gcj.longitude);
    } else if (win.__clearMarker) {
      // 虚构地点不必填坐标：清掉标记而不是留在上一个位置。
      win.__clearMarker();
    }
  }, [selected, html]);

  const persist = async next => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveLocationSettings(next);
      setSettings(saved);
    } catch (error) {
      Alert.alert(t('world.map.real.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!settings) return;
    const name = String(draft.name || '').trim();
    if (!name) {
      Alert.alert(t('world.map.real.place.name.required'));
      return;
    }
    const lat = String(draft.latitude || '').trim();
    const lng = String(draft.longitude || '').trim();
    // 坐标要么都填要么都不填；只填一个是明确的输入错误，不该静默丢弃。
    if ((lat && !lng) || (!lat && lng)) {
      Alert.alert(t('world.map.real.place.coords.pair'));
      return;
    }
    const latitude = lat ? Number(lat) : NaN;
    const longitude = lng ? Number(lng) : NaN;
    if (lat && (!Number.isFinite(latitude) || Math.abs(latitude) > 90
      || !Number.isFinite(longitude) || Math.abs(longitude) > 180)) {
      Alert.alert(t('world.map.real.place.coords.invalid'));
      return;
    }
    // upsertPlace 负责 id、上限（PLACE_LIMIT）与规范化——桌面不重写这些判定。
    const next = upsertPlace(settings, {
      id: selected ? selected.id : undefined,
      name,
      latitude: lat ? latitude : null,
      longitude: lng ? longitude : null,
      share: draft.share === true,
    });
    if (next === settings) {
      Alert.alert(t('world.map.real.place.limit', { count: PLACE_LIMIT }));
      return;
    }
    await persist(next);
    setDraft(EMPTY_PLACE);
  };

  const pick = place => {
    setSelectedId(place.id);
    setDraft({
      name: place.name || '',
      latitude: place.latitude == null ? '' : String(place.latitude),
      longitude: place.longitude == null ? '' : String(place.longitude),
      share: place.share === true,
    });
  };

  const removeSelected = () => {
    if (!settings || !selected) return;
    persist(removePlace(settings, selected.id))
      .then(() => { setSelectedId(''); setDraft(EMPTY_PLACE); })
      .catch(() => {});
  };

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {loadFailed ? (
          <div style={{ padding: 16, fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>
            {t('world.map.real.loadFailed')}
          </div>
        ) : (
          <iframe
            ref={frameRef}
            title={t('world.map.real.places.title')}
            srcDoc={html}
            // 地图页是自绘 HTML：不给 allow-same-origin 之外的权限，也不放行导航。
            sandbox="allow-scripts"
            style={{ flex: 1, width: '100%', border: 'none', background: '#1a1a2e' }}
          />
        )}
      </div>

      <div style={{ width: 300, flex: 'none', borderLeft: `1px solid ${palette.divider}`, overflow: 'auto', padding: 12 }}>
        <Card title={t('world.map.real.places.title')} palette={palette} fonts={fonts}>
          {places.length === 0 ? (
            <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
              {t('world.map.real.place.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {places.map(place => (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => pick(place)}
                  style={{
                    textAlign: 'left',
                    background: place.id === selectedId ? palette.surfaceAlt : 'transparent',
                    color: palette.text,
                    border: `1px solid ${place.id === selectedId ? palette.primaryMuted || palette.primary : palette.divider}`,
                    borderRadius: 8,
                    padding: '6px 10px',
                    fontSize: fonts.scaled(12),
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{place.name || t('world.map.real.place.name')}</div>
                  <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                    {place.latitude == null || place.longitude == null
                      ? t('world.map.real.place.noCoords')
                      : formatCoordinate(place.latitude, place.longitude)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title={selected ? t('world.map.real.place.edit') : t('world.map.real.place.add')} palette={palette} fonts={fonts}>
          <Field label={t('world.map.real.place.name')} palette={palette} fonts={fonts}>
            <input
              type="text"
              value={draft.name}
              onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
              style={inputStyle(palette, fonts)}
            />
          </Field>
          <Row>
            <Field label={t('world.map.real.place.lat')} palette={palette} fonts={fonts}>
              <input
                type="text"
                inputMode="decimal"
                value={draft.latitude}
                onChange={event => setDraft(current => ({ ...current, latitude: event.target.value }))}
                style={inputStyle(palette, fonts)}
              />
            </Field>
            <Field label={t('world.map.real.place.lng')} palette={palette} fonts={fonts}>
              <input
                type="text"
                inputMode="decimal"
                value={draft.longitude}
                onChange={event => setDraft(current => ({ ...current, longitude: event.target.value }))}
                style={inputStyle(palette, fonts)}
              />
            </Field>
          </Row>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: fonts.scaled(11), color: palette.textMuted }}>
            <input
              type="checkbox"
              checked={draft.share === true}
              onChange={event => setDraft(current => ({ ...current, share: event.target.checked }))}
            />
            {t('world.map.real.share')}
          </label>
          <Row>
            <Button
              label={selected ? t('common.save') : t('world.map.real.place.add')}
              onClick={submit}
              palette={palette}
              fonts={fonts}
              disabled={busy || !settings}
            />
            {selected ? (
              <Button
                label={t('common.delete')}
                onClick={removeSelected}
                palette={palette}
                fonts={fonts}
                tone={palette.danger || '#ff5a5f'}
                disabled={busy}
              />
            ) : null}
            <Button
              label={t('common.cancel')}
              onClick={() => { setSelectedId(''); setDraft(EMPTY_PLACE); }}
              palette={palette}
              fonts={fonts}
            />
          </Row>
        </Card>
      </div>
    </div>
  );
}

function inputStyle(palette, fonts) {
  return {
    width: '100%',
    boxSizing: 'border-box',
    background: palette.surface,
    color: palette.text,
    border: `1px solid ${palette.divider}`,
    borderRadius: 8,
    padding: '5px 8px',
    fontSize: fonts.scaled(11),
  };
}
