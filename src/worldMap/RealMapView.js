// 真实地图视图：WebView 自绘瓦片地图 + 定位开关/刷新/标注 + 手工标点。
// 默认高德栅格瓦片为 GCJ-02，标注前把 WGS-84 转成 GCJ-02（见 location/geo.js）；
// 反过来用户在图上标点时拿到的是 GCJ-02，存盘前用 gcj02ToWgs84 转回 WGS-84。
// 开关是全局的（@easychat2_location.enabled）：关闭即停止标注、不再注入对话上下文。
// 标点：点「标点」按钮进入标点模式 → 点地图取点 → 填名称 → 存成新的「我的位置」。
// 标注点只用于本地地图显示，不参与对话注入（注入仍走 last + 30 分钟时效）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  addNamedLocation,
  getLocationSettings,
  removeNamedLocation,
  setActiveLocationId,
  setLastLocation,
  updateLocationSettings,
} from '../storage.js';
import { describeLocation, gcj02ToWgs84, wgs84ToGcj02 } from '../location/geo.js';
import { captureLocation, ensureLocationPermission, isLocationSupported } from '../location/service.js';
import { buildRealMapHtml } from './realMapHtml.js';

// react-native-webview 是可选能力，缺失时降级为文字提示（与 RichHtmlMessage 一致）。
let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch (error) {
  WebViewComponent = null;
}

export default function RealMapView() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();

  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [webReady, setWebReady] = useState(false);
  const webRef = useRef(null);
  // 标点：marking=已进入标点模式，draft=地图上刚取到、等待命名的那一个点。
  const [marking, setMarking] = useState(false);
  const [draft, setDraft] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getLocationSettings()
      .then(value => { if (alive) setSettings(value); })
      .catch(() => { if (alive) setSettings({ enabled: false, last: null, tileUrl: '' }); });
    return () => { alive = false; };
  }, []);

  // html 只依赖瓦片模板。若依赖整个 settings，开关/位置每次变化都会重建 source，
  // WebView 的 source 一变就可能整页重载——而 webReady 还是 true，标记会被注进旧文档。
  const tileUrl = settings && settings.tileUrl ? settings.tileUrl : undefined;
  const html = useMemo(() => buildRealMapHtml({ tileUrl }), [tileUrl]);

  // 换了瓦片模板（source 变化 → 页面会重载）时先回到「未就绪」；
  // 等 onLoadEnd 把 webReady 置回 true，下面的标记注入才会执行到新文档上。
  useEffect(() => {
    setWebReady(false);
  }, [html]);

  const inject = useCallback(script => {
    const ref = webRef.current;
    if (ref && ref.injectJavaScript) ref.injectJavaScript(`${script};true;`);
  }, []);

  // 位置/标注点/就绪变化时把全部标注同步进 WebView（转 GCJ-02）；
  // 页面重载完成后（webReady 回 true）会重新注入。
  useEffect(() => {
    if (!webReady) return;
    const list = [];
    const active = settings && settings.activeLocationId;
    // GPS 当前位置用独立配色，和用户标注点区分开。
    const last = settings && settings.last;
    if (last && !active) {
      const gcj = wgs84ToGcj02(last.latitude, last.longitude);
      if (Number.isFinite(gcj.latitude) && Number.isFinite(gcj.longitude)) {
        list.push({ lat: gcj.latitude, lng: gcj.longitude, kind: 'current' });
      }
    }
    const named = settings && Array.isArray(settings.locations) ? settings.locations : [];
    named.forEach(item => {
      const gcj = wgs84ToGcj02(item.latitude, item.longitude);
      if (!Number.isFinite(gcj.latitude) || !Number.isFinite(gcj.longitude)) return;
      list.push({ lat: gcj.latitude, lng: gcj.longitude, kind: 'named', active: item.id === active });
    });
    inject(`window.__setMarkers && window.__setMarkers(${JSON.stringify(list)})`);
  }, [webReady, settings, inject]);

  const setMarkingMode = useCallback(on => {
    setMarking(on);
    inject(`window.__setMarking && window.__setMarking(${on ? 'true' : 'false'})`);
  }, [inject]);

  // 点图取点：地图回传的是 GCJ-02（高德瓦片坐标），存盘前转回 WGS-84，
  // 否则下次按 WGS-84 再转一次 GCJ-02 标注会叠加偏移。
  const onMapMessage = useCallback(event => {
    let payload = null;
    try {
      payload = JSON.parse((event && event.nativeEvent && event.nativeEvent.data) || '');
    } catch (caught) {
      return;
    }
    if (!payload || payload.type !== 'map-tap') return;
    const wgs = gcj02ToWgs84(payload.lat, payload.lng);
    if (!Number.isFinite(wgs.latitude) || !Number.isFinite(wgs.longitude)) return;
    setMarkingMode(false);
    setDraft({ latitude: wgs.latitude, longitude: wgs.longitude });
    setDraftName('');
  }, [setMarkingMode]);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    setDraftName('');
  }, []);

  const saveNamedLocation = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await addNamedLocation({
        name: draftName.trim() || t('world.map.real.mark.unnamed'),
        latitude: draft.latitude,
        longitude: draft.longitude,
      });
      setSettings(saved);
      setDraft(null);
      setDraftName('');
      setError('');
    } catch (caught) {
      setError(t('world.map.real.failed'));
    } finally {
      setSaving(false);
    }
  }, [draft, draftName, t]);

  const focusNamedLocation = useCallback(async id => {
    try {
      const saved = await setActiveLocationId(id);
      setSettings(saved);
    } catch (caught) {
      setError(t('world.map.real.failed'));
    }
  }, [t]);

  const confirmRemoveNamedLocation = useCallback(item => {
    Alert.alert(
      t('world.map.real.mark.remove.title'),
      item.name || t('world.map.real.mark.unnamed'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('world.map.real.mark.remove.confirm'),
          style: 'destructive',
          onPress: () => {
            removeNamedLocation(item.id)
              .then(saved => setSettings(saved))
              .catch(() => setError(t('world.map.real.failed')));
          },
        },
      ]
    );
  }, [t]);

  const capture = useCallback(async () => {
    const granted = await ensureLocationPermission();
    if (!granted) {
      setError(t('world.map.real.permission.denied'));
      return false;
    }
    const location = await captureLocation();
    const saved = await setLastLocation(location);
    setSettings(saved);
    setError('');
    return true;
  }, [t]);

  // 取点失败按错误码给不同文案：系统定位服务关闭是可诊断、可操作的一类，
  // 不能再笼统提示「请稍后重试」（真机上权限都给了却永远失败最常见的成因）。
  const describeCaptureError = useCallback(caught => (
    caught && caught.code === 'SERVICES_DISABLED'
      ? t('world.map.real.servicesOff')
      : t('world.map.real.failed')
  ), [t]);

  // 开启前的隐私确认：位置属敏感信息，且开启后配合「位置感知」会随对话分享
  // 模糊位置——必须在取点之前让用户知情并有机会取消。
  const confirmPrivacy = useCallback(() => new Promise(resolve => {
    Alert.alert(
      t('world.map.real.privacy.title'),
      t('world.map.real.privacy.body'),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('world.map.real.privacy.confirm'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  }), [t]);

  const handleEnable = useCallback(async () => {
    if (busy) return;
    if (!isLocationSupported()) {
      setError(t('world.map.real.unsupported'));
      return;
    }
    setBusy(true);
    try {
      const confirmed = await confirmPrivacy();
      if (!confirmed) return;
      // 先授权 + 取点，成功后才把 enabled 写盘：用户拒绝授权时必须保持关闭
      // （需求 1.2 与 SECURITY.md 的「拒绝后保持关闭」），不能在未授权时就写成开。
      // capture() 失败时已设好对应文案（拒绝/失败），这里直接返回、不改设置。
      const ok = await capture();
      if (!ok) return;
      const saved = await updateLocationSettings(current => ({ ...current, enabled: true }));
      setSettings(saved);
    } catch (caught) {
      setError(describeCaptureError(caught));
    } finally {
      setBusy(false);
    }
  }, [busy, capture, confirmPrivacy, describeCaptureError, t]);

  const handleDisable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 关闭时一并清掉最近位置：位置是敏感数据，开关关掉后不该继续留在盘上
      // 等着被重新注入（与「关闭时不取点、不注入对话」的披露一致）。
      const saved = await updateLocationSettings(current => ({ ...current, enabled: false, last: null }));
      setSettings(saved);
      setError('');
    } catch (caught) {
      setError(t('world.map.real.failed'));
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  const handleRefresh = useCallback(async () => {
    if (busy) return;
    if (!isLocationSupported()) {
      setError(t('world.map.real.unsupported'));
      return;
    }
    setBusy(true);
    try {
      await capture();
    } catch (caught) {
      // 保留上一次成功位置（Requirement 2.4）。
      setError(describeCaptureError(caught));
    } finally {
      setBusy(false);
    }
  }, [busy, capture, describeCaptureError, t]);

  if (!settings) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const enabled = settings.enabled === true;
  const last = settings.last;
  const description = describeLocation(last);
  const locations = Array.isArray(settings.locations) ? settings.locations : [];

  // 地图区在「已开启」与「未开启」两种状态下都要渲染：标点不依赖定位授权
  // （用户可手动画出「我的位置」），所以未开启时也能在地图上标点。
  const renderMapArea = () => (
    <>
      <View style={styles.actions}>
        {enabled ? (
          <TouchableOpacity style={styles.actionButton} onPress={handleRefresh} disabled={busy} activeOpacity={0.85}>
            {busy
              ? <ActivityIndicator size="small" color={theme.colors.primary} />
              : <Ionicons name="refresh" size={14} color={theme.colors.primary} />}
            <Text style={styles.actionText}>{busy ? t('world.map.real.locating') : t('world.map.real.refresh')}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.actionButton, marking && styles.actionButtonActive]}
          onPress={() => setMarkingMode(!marking)}
          activeOpacity={0.85}
        >
          <Ionicons name={marking ? 'close' : 'add-circle-outline'} size={14} color={marking ? theme.colors.primaryContrast : theme.colors.primary} />
          <Text style={[styles.actionText, marking && styles.actionTextActive]}>
            {marking ? t('world.map.real.mark.cancel') : t('world.map.real.mark')}
          </Text>
        </TouchableOpacity>
        {enabled ? (
          <TouchableOpacity style={styles.actionButton} onPress={handleDisable} disabled={busy} activeOpacity={0.85}>
            <Ionicons name="close-circle-outline" size={14} color={theme.colors.textMuted} />
            <Text style={[styles.actionText, styles.actionTextMuted]}>{t('world.map.real.disable')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {marking ? <Text style={styles.markHint}>{t('world.map.real.mark.hint')}</Text> : null}

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
          onMessage={onMapMessage}
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.guideBody}>{t('world.map.real.unsupported')}</Text>
        </View>
      )}

      {locations.length > 0 ? (
        <View style={styles.locationList}>
          <Text style={styles.locationListTitle}>{t('world.map.real.mark.listTitle')}</Text>
          <ScrollView style={styles.locationListScroll} nestedScrollEnabled>
            {locations.map(item => {
              const selected = item.id === settings.activeLocationId;
              return (
                <View key={item.id} style={[styles.locationRow, selected && styles.locationRowActive]}>
                  <TouchableOpacity
                    style={styles.locationRowMain}
                    onPress={() => focusNamedLocation(selected ? '' : item.id)}
                    activeOpacity={0.85}
                  >
                    <Ionicons
                      name={selected ? 'radio-button-on' : 'radio-button-off'}
                      size={15}
                      color={selected ? theme.colors.primary : theme.colors.textMuted}
                    />
                    <View style={styles.locationRowText}>
                      <Text style={styles.locationRowName} numberOfLines={1}>
                        {item.name || t('world.map.real.mark.unnamed')}
                      </Text>
                      <Text style={styles.locationRowMeta} numberOfLines={1}>{describeLocation(item)}</Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.locationRemove}
                    onPress={() => confirmRemoveNamedLocation(item)}
                    activeOpacity={0.7}
                    accessibilityLabel={t('world.map.real.mark.remove.confirm')}
                  >
                    <Ionicons name="trash-outline" size={15} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <Modal
        visible={!!draft}
        transparent
        animationType="fade"
        onRequestClose={cancelDraft}
      >
        <View style={styles.overlay}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>{t('world.map.real.mark.title')}</Text>
            <Text style={styles.dialogHint}>{draft ? describeLocation(draft) : ''}</Text>
            <TextInput
              style={styles.input}
              value={draftName}
              onChangeText={setDraftName}
              placeholder={t('world.map.real.mark.placeholder')}
              placeholderTextColor={theme.colors.textFaint}
              autoFocus
              maxLength={40}
            />
            <View style={styles.dialogActions}>
              <TouchableOpacity style={styles.dialogButton} onPress={cancelDraft} activeOpacity={0.85}>
                <Text style={styles.dialogButtonTextMuted}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.dialogButton, styles.dialogButtonPrimary]}
                onPress={saveNamedLocation}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
                  : <Text style={styles.dialogButtonTextPrimary}>{t('common.confirm')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  if (!enabled) {
    return (
      <View style={styles.guide}>
        <Ionicons name="location-outline" size={34} color={theme.colors.primaryMuted} />
        <Text style={styles.guideTitle}>{t('world.map.real.empty.title')}</Text>
        <Text style={styles.guideBody}>{t('world.map.real.empty.body')}</Text>
        <Text style={styles.privacyNote}>{t('world.map.real.privacy.hint')}</Text>
        <Text style={styles.privacyNote}>{t('world.map.real.mark.offHint')}</Text>
        {renderMapArea()}
        <TouchableOpacity style={styles.primaryButton} onPress={handleEnable} disabled={busy} activeOpacity={0.85}>
          {busy
            ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            : <Ionicons name="navigate" size={15} color={theme.colors.primaryContrast} />}
          <Text style={styles.primaryButtonText}>{t('world.map.real.enable')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="location" size={16} color={theme.colors.primary} />
        <View style={styles.headerText}>
          <Text style={styles.locationText} numberOfLines={1}>
            {description || t('world.map.real.noPosition')}
          </Text>
          <Text style={styles.headerHint} numberOfLines={1}>{t('world.map.real.hint')}</Text>
        </View>
      </View>

      {settings.awareness !== true ? (
        <Text style={styles.privacyNote}>{t('world.map.real.awarenessOff')}</Text>
      ) : null}

      {renderMapArea()}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, minHeight: 420 },
  center: { flex: 1, minHeight: 420, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  guide: {
    minHeight: 360,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 30,
  },
  guideTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginTop: 12 },
  guideBody: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    textAlign: 'center',
    marginTop: 8,
  },
  privacyNote: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    textAlign: 'center',
    marginTop: 10,
    paddingHorizontal: 4,
  },
  errorText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), marginTop: 10, textAlign: 'center' },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 16,
  },
  primaryButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 6 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingTop: 4 },
  headerText: { flex: 1, marginLeft: 8 },
  locationText: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  headerHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 10, marginBottom: 10 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 10,
  },
  actionText: { color: theme.colors.primary, fontSize: fonts.scaled(12), fontWeight: '600', marginLeft: 5 },
  actionTextMuted: { color: theme.colors.textMuted },
  actionButtonActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  actionTextActive: { color: theme.colors.primaryContrast },
  markHint: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  locationList: { marginTop: 10 },
  locationListTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  locationListScroll: { maxHeight: 170, marginTop: 6 },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 6,
  },
  locationRowActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.12) },
  locationRowMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  locationRowText: { flex: 1, marginLeft: 8 },
  locationRowName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  locationRowMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  locationRemove: { paddingHorizontal: 6, paddingVertical: 4, marginLeft: 6 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.lg,
  },
  dialogTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800' },
  dialogHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 6 },
  input: {
    marginTop: 12,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    backgroundColor: theme.colors.surfaceAlt,
  },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  dialogButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: tokens.metrics.buttonRadius,
    marginLeft: 10,
  },
  dialogButtonPrimary: { backgroundColor: theme.colors.primary },
  dialogButtonTextMuted: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '600' },
  dialogButtonTextPrimary: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700' },
  map: { flex: 1, minHeight: 360, borderRadius: tokens.radius.md, overflow: 'hidden' },
});
