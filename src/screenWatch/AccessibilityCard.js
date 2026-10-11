// 「无障碍权限」卡片（看屏幕面板内）：状态查询 + 一键跳到系统无障碍设置。
//
// 为什么需要它：跨应用截屏目前走 MediaProjection，而它是**逐会话授权**——每次开启
// 悬浮窗都要用户在系统弹窗里重新确认。用户反馈「在 App 外截屏一直失败」，授权链路
// 本身就是最可疑的一环。无障碍服务在用户手动开启后由系统常驻绑定，不需要每次重新
// 授权，是更省事的备选路径。
//
// 口径纪律（不许把话说满）：
// - 本批**只做**「状态查询 + 引导开启」，画面采集仍由悬浮窗（MediaProjection）完成；
// - 无障碍截屏 API 的可用性**未在本地核实**（沙箱无 Android SDK/Java），所以界面上
//   不承诺「开启后就能截屏」；
// - 跳转只能到系统无障碍**总列表**，无法直达本应用那一项（系统没有这样的 Intent
//   extra，未核实是否存在厂商扩展），所以文案明确写「在列表里找到本应用」。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

import { isAccessibilityEnabled, isOverlaySupported, openAccessibilitySettings } from './overlay.js';

export default function AccessibilityCard() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  // null = 还没查到（显示「检查中」，不猜成「未开启」——猜错会把用户引去改一个
  // 本来就正常的设置）。
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const supported = isOverlaySupported();

  const refresh = useCallback(async () => {
    const next = await isAccessibilityEnabled();
    setEnabled(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await isAccessibilityEnabled();
      if (!cancelled) setEnabled(next);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleOpenSettings = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openAccessibilitySettings();
    } finally {
      setBusy(false);
      // 跳转后回到本页时状态可能已变：再查一次（面板不重建也能刷新）。
      refresh();
    }
  }, [busy, refresh]);

  if (!supported) return null;

  const statusText = enabled === null
    ? t('screenWatch.accessibility.statusUnknown')
    : (enabled ? t('screenWatch.accessibility.statusOn') : t('screenWatch.accessibility.statusOff'));

  return (
    <Card style={styles.card}>
      <Text style={styles.title}>{t('screenWatch.accessibility.title')}</Text>
      <Text style={styles.hint}>{t('screenWatch.accessibility.description')}</Text>
      <View style={styles.statusRow}>
        <View style={[styles.dot, enabled === true && styles.dotActive]} />
        <Text style={styles.status}>{statusText}</Text>
      </View>
      <TouchableOpacity
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={handleOpenSettings}
        disabled={busy}
        activeOpacity={0.85}
      >
        {busy
          ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
          : <Ionicons name="accessibility-outline" size={18} color={theme.colors.primaryContrast} />}
        <Text style={styles.buttonText}>{t('screenWatch.accessibility.open')}</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>{t('screenWatch.accessibility.howTo')}</Text>
      <Text style={styles.hint}>{t('screenWatch.accessibility.notEnough')}</Text>
    </Card>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  card: { marginBottom: tokens.metrics.cardGap },
  title: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginBottom: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, marginBottom: 10 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.textFaint,
    marginRight: 6,
  },
  dotActive: { backgroundColor: theme.colors.primary },
  status: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 12,
  },
  buttonDisabled: { opacity: tokens.opacity.disabled },
  buttonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 8 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 10, lineHeight: fonts.scaled(16) },
});
