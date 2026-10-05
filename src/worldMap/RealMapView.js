// 真实地图视图：WebView 自绘瓦片地图 + 定位开关/刷新/标注。
// 默认高德栅格瓦片为 GCJ-02，标注前把 WGS-84 转成 GCJ-02（见 location/geo.js）。
// 开关是全局的（@easychat2_location.enabled）：关闭即停止标注、不再注入对话上下文。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getLocationSettings, setLastLocation, updateLocationSettings } from '../storage.js';
import { describeLocation, wgs84ToGcj02 } from '../location/geo.js';
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

  // 位置/就绪变化时把标记（转 GCJ-02）同步进 WebView；页面重载完成后（webReady 回 true）会重新注入。
  useEffect(() => {
    const last = settings && settings.last;
    if (!webReady || !last) return;
    const gcj = wgs84ToGcj02(last.latitude, last.longitude);
    if (!Number.isFinite(gcj.latitude) || !Number.isFinite(gcj.longitude)) return;
    inject(`window.__setMarker && window.__setMarker(${gcj.latitude}, ${gcj.longitude})`);
  }, [webReady, settings, inject]);

  // 取点失败按错误码给不同文案：这些都是可诊断、可操作的一类，
  // 不能再笼统提示「请稍后重试」（真机上「权限都给了却一直失败」最常见的成因）。
  const describeCaptureError = useCallback(caught => {
    if (caught && caught.code === 'SERVICES_DISABLED') return t('world.map.real.servicesOff');
    if (caught && caught.code === 'LOCATION_UNAVAILABLE') return t('world.map.real.unavailable');
    return t('world.map.real.failed');
  }, [t]);

  const capture = useCallback(async () => {
    let granted = false;
    try {
      granted = await ensureLocationPermission();
    } catch (caught) {
      // 权限查询本身不可用（原生模块缺失等）：不能再说「未获得定位权限」——
      // 用户明明已经授权，那条文案会把人引到错误的排查方向。
      setError(describeCaptureError(caught));
      return false;
    }
    if (!granted) {
      setError(t('world.map.real.permission.denied'));
      return false;
    }
    const location = await captureLocation();
    const saved = await setLastLocation(location);
    setSettings(saved);
    setError('');
    return true;
  }, [describeCaptureError, t]);

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

  if (!enabled) {
    return (
      <View style={styles.guide}>
        <Ionicons name="location-outline" size={34} color={theme.colors.primaryMuted} />
        <Text style={styles.guideTitle}>{t('world.map.real.empty.title')}</Text>
        <Text style={styles.guideBody}>{t('world.map.real.empty.body')}</Text>
        <Text style={styles.privacyNote}>{t('world.map.real.privacy.hint')}</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
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

      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionButton} onPress={handleRefresh} disabled={busy} activeOpacity={0.85}>
          {busy
            ? <ActivityIndicator size="small" color={theme.colors.primary} />
            : <Ionicons name="refresh" size={14} color={theme.colors.primary} />}
          <Text style={styles.actionText}>{busy ? t('world.map.real.locating') : t('world.map.real.refresh')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton} onPress={handleDisable} disabled={busy} activeOpacity={0.85}>
          <Ionicons name="close-circle-outline" size={14} color={theme.colors.textMuted} />
          <Text style={[styles.actionText, styles.actionTextMuted]}>{t('world.map.real.disable')}</Text>
        </TouchableOpacity>
      </View>

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
          <Text style={styles.guideBody}>{t('world.map.real.unsupported')}</Text>
        </View>
      )}
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
  map: { flex: 1, minHeight: 360, borderRadius: tokens.radius.md, overflow: 'hidden' },
});
