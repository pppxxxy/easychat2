// 真实地图视图（自写位置版）：位置清单可增删改、一次只用一个；地图按选中位置标注。
//
// 设计变更（用户裁决）：**不再读取系统定位**——位置由用户手写，真实的或虚构的都行
//（例：山东青岛、美国华盛顿、霍格沃茨魔法学院），因此没有权限申请、没有取点、没有超时。
// 坐标是可选字段：填了才在地图上标注（WGS-84 → GCJ-02，见 location/geo.js），
// 留空就只把文字位置分享给角色（虚构地点不必填坐标）。
// 开关是全局的（@easychat2_location.enabled）：关闭后不再把位置分享给角色；
// 地图标注始终跟随选中项，不受它影响（本地浏览与对外分享是两件事）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, PrimaryButton, TextField } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  PLACE_LIMIT,
  getLocationSettings,
  removePlace,
  updateLocationSettings,
  upsertPlace,
} from '../storage.js';
import { formatCoordinate, resolveActivePlace, wgs84ToGcj02 } from '../location/geo.js';
import { buildRealMapHtml } from './realMapHtml.js';

// react-native-webview 是可选能力，缺失时降级为文字提示（与 RichHtmlMessage 一致）。
let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch (error) {
  WebViewComponent = null;
}

// 首次使用写入的三条示例：跟当前语言，中文就是用户点名的那三个。
const EXAMPLE_PLACE_IDS = ['place-example-1', 'place-example-2', 'place-example-3'];
const EXAMPLE_PLACE_KEYS = [
  'world.map.real.example.qingdao',
  'world.map.real.example.washington',
  'world.map.real.example.hogwarts',
];

export default function RealMapView() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();

  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [webReady, setWebReady] = useState(false);
  const webRef = useRef(null);

  // 位置编辑器（新增/编辑共用）：draftLat/draftLng 用字符串在编辑，保存时解析。
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftLat, setDraftLat] = useState('');
  const [draftLng, setDraftLng] = useState('');
  const [editorError, setEditorError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      const loaded = await getLocationSettings();
      if (!alive) return;
      // 首次使用：写入三条示例，让用户一眼看懂能怎么写（删光后不再自动冒出来，
      // 靠 seeded 标记记住「示例已经给过了」）。
      if (loaded.seeded !== true && loaded.places.length === 0) {
        const examples = EXAMPLE_PLACE_IDS.map((id, index) => ({
          id,
          name: t(EXAMPLE_PLACE_KEYS[index]),
        }));
        const saved = await updateLocationSettings(current => {
          if (current.seeded === true || current.places.length > 0) {
            return { ...current, seeded: true };
          }
          let next = current;
          examples.forEach(item => { next = upsertPlace(next, item); });
          return { ...next, seeded: true, activePlaceId: examples[0].id };
        });
        if (alive) setSettings(saved);
        return;
      }
      if (alive) setSettings(loaded);
    })().catch(() => {
      if (alive) {
        setSettings({ enabled: false, awareness: false, places: [], activePlaceId: '', seeded: true, tileUrl: '' });
      }
    });
    return () => { alive = false; };
  }, [t]);

  // html 只依赖瓦片模板。若依赖整个 settings，选中/编辑每次变化都会重建 source，
  // WebView 的 source 一变就可能整页重载——而 webReady 还是 true，标记会注进旧文档。
  const tileUrl = settings && settings.tileUrl ? settings.tileUrl : undefined;
  const html = useMemo(() => buildRealMapHtml({ tileUrl }), [tileUrl]);

  useEffect(() => {
    setWebReady(false);
  }, [html]);

  const inject = useCallback(script => {
    const ref = webRef.current;
    if (ref && ref.injectJavaScript) ref.injectJavaScript(`${script};true;`);
  }, []);

  const activePlace = useMemo(() => resolveActivePlace(settings), [settings]);

  // 标注 = 选中项（有坐标时）。坐标可能为空（虚构地点），此时清掉标记。
  useEffect(() => {
    if (!webReady) return;
    const latitude = activePlace ? activePlace.latitude : null;
    const longitude = activePlace ? activePlace.longitude : null;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      inject('window.__clearMarker && window.__clearMarker()');
      return;
    }
    const gcj = wgs84ToGcj02(latitude, longitude);
    if (!Number.isFinite(gcj.latitude) || !Number.isFinite(gcj.longitude)) return;
    inject(`window.__setMarker && window.__setMarker(${gcj.latitude}, ${gcj.longitude})`);
  }, [webReady, activePlace, inject]);

  const persist = useCallback(async updater => {
    setBusy(true);
    try {
      const saved = await updateLocationSettings(updater);
      setSettings(saved);
      setError('');
      return saved;
    } catch (caught) {
      setError(t('world.map.real.saveFailed'));
      return null;
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleSelect = useCallback(place => {
    if (!place || busy || !settings || settings.activePlaceId === place.id) return;
    persist(current => ({ ...current, activePlaceId: place.id }));
  }, [busy, persist, settings]);

  const handleToggleShare = useCallback(value => {
    persist(current => ({ ...current, enabled: value === true }));
  }, [persist]);

  const openEditor = useCallback(place => {
    setEditingId(place ? String(place.id) : '');
    setDraftName(place ? String(place.name || '') : '');
    setDraftLat(place && Number.isFinite(place.latitude) ? String(place.latitude) : '');
    setDraftLng(place && Number.isFinite(place.longitude) ? String(place.longitude) : '');
    setEditorError('');
    setEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditingId('');
    setEditorError('');
  }, []);

  const handleSave = useCallback(async () => {
    const name = String(draftName || '').trim();
    if (!name) {
      setEditorError(t('world.map.real.place.name.required'));
      return;
    }
    const latText = String(draftLat || '').trim();
    const lngText = String(draftLng || '').trim();
    // 坐标要么都填、要么都不填：只填一半说明还没想好，提示而不是静默丢掉。
    if ((latText !== '') !== (lngText !== '')) {
      setEditorError(t('world.map.real.place.coords.pair'));
      return;
    }
    let latitude = null;
    let longitude = null;
    if (latText !== '' && lngText !== '') {
      latitude = Number(latText);
      longitude = Number(lngText);
      const valid = Number.isFinite(latitude) && Number.isFinite(longitude)
        && latitude >= -90 && latitude <= 90
        && longitude >= -180 && longitude <= 180;
      if (!valid) {
        setEditorError(t('world.map.real.place.coords.invalid'));
        return;
      }
    }
    const isNew = !editingId;
    if (isNew && settings && settings.places.length >= PLACE_LIMIT) {
      setEditorError(t('world.map.real.place.limit', { count: PLACE_LIMIT }));
      return;
    }
    const saved = await persist(current => upsertPlace(current, {
      id: editingId,
      name,
      latitude,
      longitude,
    }));
    if (saved) closeEditor();
  }, [closeEditor, draftLat, draftLng, draftName, editingId, persist, settings, t]);

  const confirmDelete = useCallback(place => {
    if (!place || busy) return;
    Alert.alert(
      t('world.map.real.place.delete.title'),
      t('world.map.real.place.delete.body', { name: place.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => { persist(current => removePlace(current, place.id)); },
        },
      ],
      { cancelable: true }
    );
  }, [busy, persist, t]);

  if (!settings) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const places = settings.places;
  const shareEnabled = settings.enabled === true;

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>{t('world.map.real.places.title')}</Text>
      <Text style={styles.hint}>{t('world.map.real.places.hint')}</Text>

      {places.length === 0 ? (
        <Text style={styles.emptyText}>{t('world.map.real.place.empty')}</Text>
      ) : places.map(place => {
        const selected = place.id === settings.activePlaceId;
        const hasCoordinates = Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
        return (
          <View key={place.id} style={[styles.placeRow, selected && styles.placeRowActive]}>
            <TouchableOpacity
              style={styles.placeMain}
              onPress={() => handleSelect(place)}
              activeOpacity={0.85}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={17}
                color={selected ? theme.colors.primary : theme.colors.textFaint}
              />
              <View style={styles.placeText}>
                <Text style={[styles.placeName, selected && styles.placeNameActive]} numberOfLines={1}>
                  {place.name}
                </Text>
                <Text style={styles.placeMeta} numberOfLines={1}>
                  {hasCoordinates
                    ? formatCoordinate(place.latitude, place.longitude, 4)
                    : t('world.map.real.place.noCoords')}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.placeIcon}
              onPress={() => openEditor(place)}
              activeOpacity={0.85}
              accessibilityLabel={t('world.map.real.place.edit')}
            >
              <Ionicons name="create-outline" size={17} color={theme.colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.placeIcon}
              onPress={() => confirmDelete(place)}
              activeOpacity={0.85}
              accessibilityLabel={t('world.map.real.place.delete.title')}
            >
              <Ionicons name="trash-outline" size={17} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
        );
      })}

      {places.length < PLACE_LIMIT ? (
        <TouchableOpacity style={styles.addButton} onPress={() => openEditor(null)} activeOpacity={0.85}>
          <Ionicons name="add" size={16} color={theme.colors.primary} />
          <Text style={styles.addButtonText}>{t('world.map.real.place.add')}</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.hint}>{t('world.map.real.place.limit', { count: PLACE_LIMIT })}</Text>
      )}

      <View style={styles.shareRow}>
        <View style={styles.shareText}>
          <Text style={styles.shareTitle}>{t('world.map.real.share')}</Text>
          <Text style={styles.shareHint}>{t('world.map.real.share.hint')}</Text>
        </View>
        <Switch
          value={shareEnabled}
          onValueChange={handleToggleShare}
          disabled={busy}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      {settings.awareness !== true ? (
        <Text style={styles.privacyNote}>{t('world.map.real.awarenessOff')}</Text>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {WebViewComponent ? (
        <WebViewComponent
          ref={webRef}
          style={styles.map}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled={false}
          setSupportMultipleWindows={false}
          scrollEnabled={false}
          source={{ html }}
          onLoadEnd={() => setWebReady(true)}
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.hint}>{t('world.map.real.unsupported')}</Text>
        </View>
      )}

      <Modal visible={editorOpen} transparent animationType="fade" onRequestClose={closeEditor}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>
              {editingId ? t('world.map.real.place.edit') : t('world.map.real.place.add')}
            </Text>
            <FieldLabel>{t('world.map.real.place.name')}</FieldLabel>
            <TextField
              value={draftName}
              onChangeText={setDraftName}
              placeholder={t('world.map.real.place.name.placeholder')}
              autoCorrect={false}
            />
            <FieldLabel style={styles.coordLabel}>{t('world.map.real.place.coords')}</FieldLabel>
            <View style={styles.coordRow}>
              <TextField
                style={styles.coordInput}
                value={draftLat}
                onChangeText={setDraftLat}
                keyboardType="numbers-and-punctuation"
                placeholder={t('world.map.real.place.lat')}
              />
              <TextField
                style={styles.coordInput}
                value={draftLng}
                onChangeText={setDraftLng}
                keyboardType="numbers-and-punctuation"
                placeholder={t('world.map.real.place.lng')}
              />
            </View>
            <FieldHint>{t('world.map.real.place.coords.hint')}</FieldHint>
            {editorError ? <Text style={styles.errorText}>{editorError}</Text> : null}
            <View style={styles.modalActions}>
              <GhostButton title={t('common.cancel')} onPress={closeEditor} />
              <PrimaryButton title={t('common.save')} onPress={handleSave} disabled={busy} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, minHeight: 420 },
  center: { minHeight: 120, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  sectionTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginTop: 4 },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 6,
  },
  emptyText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    textAlign: 'center',
    paddingVertical: 14,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    marginTop: 8,
    paddingRight: 6,
  },
  placeRowActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryAlpha(0.12),
  },
  placeMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingLeft: 10,
  },
  placeText: { flex: 1, marginLeft: 8 },
  placeName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  placeNameActive: { color: theme.colors.primarySoft },
  placeMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  placeIcon: { paddingHorizontal: 8, paddingVertical: 8 },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
    paddingVertical: 9,
    marginTop: 10,
  },
  addButtonText: { color: theme.colors.primary, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 5 },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  shareText: { flex: 1, marginRight: 12 },
  shareTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  shareHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 3,
  },
  privacyNote: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 10,
  },
  errorText: {
    color: theme.colors.danger || theme.colors.text,
    fontSize: fonts.scaled(12),
    marginTop: 10,
  },
  map: { height: 320, borderRadius: tokens.radius.md, overflow: 'hidden', marginTop: 12 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    padding: 16,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  modalTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginBottom: 12 },
  coordLabel: { marginTop: 12 },
  coordRow: { flexDirection: 'row' },
  coordInput: { flex: 1, marginRight: 8 },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 16,
  },
});
