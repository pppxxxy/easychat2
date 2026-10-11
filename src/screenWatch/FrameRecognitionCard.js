// 「画面识别来源」卡片（看屏幕面板内）：屏幕画面走主模型直接看，还是先经图片识别
// （OCR）模型转成文字描述。
//
// 为什么单独一个组件：ScreenWatchScreen.js 已接近行数上限，而这块的状态与交互
// （读配置 / 切换 / 落盘 / 与「图片识别是否就绪」联动提示）是自足的。
//
// 口径：默认「主模型直接看」——与既有行为完全一致；选「先转文字」时不要求主模型
// 支持识图，但要求图片识别本身可用（否则这次请求既没图也没描述）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  getImageRecognitionSettings,
  saveImageRecognitionSettings,
} from '../storage/settings/imageRecognition.js';
import { resolveImageRecognitionPlan } from '../imageRecognition/index.js';

const SOURCES = ['main', 'ocr'];

export default function FrameRecognitionCard() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  // null = 还没读到（显示「检查中」，不猜一个来源出来——猜错会让用户以为设置没生效）。
  const [source, setSource] = useState(null);
  // OCR 这次能不能用（开关/配置/模型名/密钥四项）：只在选 ocr 时提示，选 main 时无关。
  const [ocrReady, setOcrReady] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await getImageRecognitionSettings().catch(() => null);
      const plan = await resolveImageRecognitionPlan(settings).catch(() => null);
      if (cancelled) return;
      const next = String((settings && settings.screenWatchSource) || '');
      setSource(next === 'ocr' ? 'ocr' : 'main');
      setOcrReady(!!(plan && plan.ready));
    })();
    return () => { cancelled = true; };
  }, []);

  const select = useCallback(async next => {
    if (!SOURCES.includes(next) || next === source) return;
    setSource(next);
    try {
      const stored = await getImageRecognitionSettings();
      await saveImageRecognitionSettings({ ...stored, screenWatchSource: next });
    } catch (error) {
      // 落盘失败就把界面回退到磁盘上的真实值，避免显示一个其实没保存的选择。
      const stored = await getImageRecognitionSettings().catch(() => null);
      const actual = String((stored && stored.screenWatchSource) || '');
      setSource(actual === 'ocr' ? 'ocr' : 'main');
    }
  }, [source]);

  const option = (value, labelKey, metaKey) => {
    const active = source === value;
    return (
      <TouchableOpacity
        key={value}
        style={[styles.optionRow, active && styles.optionRowActive]}
        onPress={() => select(value)}
        activeOpacity={0.85}
        accessibilityRole="radio"
        accessibilityState={{ selected: active }}
        accessibilityLabel={t(labelKey)}
      >
        <Ionicons
          name={active ? 'radio-button-on' : 'radio-button-off'}
          size={18}
          color={active ? theme.colors.primary : theme.colors.textFaint}
        />
        <View style={styles.optionBody}>
          <Text style={styles.optionTitle}>{t(labelKey)}</Text>
          <Text style={styles.optionMeta}>{t(metaKey)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Card style={styles.card}>
      <Text style={styles.title}>{t('screenWatch.frameSource.title')}</Text>
      <Text style={styles.hint}>
        {source === null ? t('screenWatch.frameSource.loading') : t('screenWatch.frameSource.hint')}
      </Text>
      {option('main', 'screenWatch.frameSource.main', 'screenWatch.frameSource.mainMeta')}
      {option('ocr', 'screenWatch.frameSource.ocr', 'screenWatch.frameSource.ocrMeta')}
      {source === 'ocr' && ocrReady === false ? (
        <Text style={styles.warn}>{t('screenWatch.frameSource.notReady')}</Text>
      ) : null}
    </Card>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  card: { marginBottom: tokens.metrics.cardGap },
  title: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginBottom: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginBottom: 8 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: 8,
  },
  optionRowActive: { borderColor: theme.colors.primary },
  optionBody: { flex: 1, marginLeft: 8 },
  optionTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  optionMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 3 },
  warn: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16) },
});
