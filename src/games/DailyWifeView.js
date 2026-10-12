// 「今日老婆/老公」小游戏：点击游戏卡进入，展示当天随机抽取的角色卡。
// 原生面板（读角色库），WebView 拿不到 RN 存储，走 GamesView 的 native 分支。
// 「今日」语义：按「本地日期 + 称呼」稳定抽取，同一天同称呼固定同一位，跨天自动换。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { pickDailyCharacter, buildDailyDateStr } from './dailyWife.js';
import { useApp } from '../context/AppContext.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function DailyWifeView({ onBack }) {
  // startupError：App 启动读角色库失败时的可见错误态（AppContext 注释自称「任何界面都能
  // 读到」，此前全仓零消费方）。不读它就会把失败回落的内置 EasyChat2 助手当成
  // 「今天你的老婆是」——用户既看不到错误，也以为自己抽到了助手。
  const { characters, loaded, startupError } = useApp();
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [mode, setMode] = useState('wife');

  // 「今日」语义靠日期串，挂载时算一次就冻结了日期 → 应用长期驻留后台再回前台会跨天不换人，
  // 与 dailyWife.js / 本文件顶部注释的「跨天自动换」矛盾（buildDailyDateStr 本身接受 now）。
  // 照 agentTaskScheduler.js:46 与 ProactivePanel.js:454 的 AppState 写法：回前台重算。
  const [dateStr, setDateStr] = useState(() => buildDailyDateStr());
  const refreshDateStr = useCallback(() => {
    // 同一天不触发重渲染（返回原值时 React 会跳过 setState）。
    setDateStr(current => {
      const next = buildDailyDateStr();
      return next === current ? current : next;
    });
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') refreshDateStr();
    });
    return () => subscription.remove();
  }, [refreshDateStr]);

  // 只有「加载完成且没有启动错误」时才参与抽取：初始/失败回落快照是 [DEFAULT_CHARACTER]，
  // 拿它抽取等于把内置助手当今日老婆（P2-2）。
  const pickable = loaded && !startupError && characters.length > 0;
  const picked = useMemo(
    () => (pickable ? pickDailyCharacter(characters, dateStr, mode) : null),
    [pickable, characters, dateStr, mode]
  );

  const isWife = mode === 'wife';

  return (
    <View style={styles.flex}>
      <View style={styles.gameBar}>
        <TouchableOpacity style={styles.backButton} onPress={onBack} activeOpacity={0.8}>
          <Ionicons name="chevron-back" size={18} color={theme.colors.textMuted} />
          <Text style={styles.backButtonText}>{t('dailyWife.back')}</Text>
        </TouchableOpacity>
        <Text style={styles.gameBarTitle}>{isWife ? t('dailyWife.title.wife') : t('dailyWife.title.husband')}</Text>
      </View>

      <View style={styles.modeRow}>
        {[
          { value: 'wife', label: t('dailyWife.title.wife') },
          { value: 'husband', label: t('dailyWife.title.husband') },
        ].map(option => {
          const active = mode === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[styles.modeChip, active && styles.modeChipActive]}
              onPress={() => setMode(option.value)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.modeChipText, active && styles.modeChipTextActive]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {startupError ? (
          <View style={styles.emptyBox}>
            <Ionicons name="alert-circle-outline" size={36} color={theme.colors.danger} />
            <Text style={styles.emptyTitle}>{t('error.storage.characterIndexReadFailed')}</Text>
            <Text style={styles.emptyHint}>{String(startupError.body || startupError.title || '')}</Text>
          </View>
        ) : !loaded ? (
          <View style={styles.emptyBox}>
            <Ionicons name="hourglass-outline" size={36} color={theme.colors.textFaint} />
            <Text style={styles.emptyTitle}>{t('dailyWife.loading')}</Text>
          </View>
        ) : picked ? (
          <View style={[styles.cardBox, tokens.elevation(2, theme)]}>
            <View style={styles.avatarWrap}>
              {picked.avatarUri ? (
                <Image source={{ uri: picked.avatarUri }} style={styles.avatarImage} />
              ) : (
                <View style={styles.avatarFallback}>
                  <Text style={styles.avatarFallbackText}>
                    {(picked.name || '?').charAt(0)}
                  </Text>
                </View>
              )}
            </View>
            <Text style={styles.dateText}>{dateStr}</Text>
            <Text style={styles.todayLabel}>
              {isWife ? t('dailyWife.today.wife') : t('dailyWife.today.husband')}
            </Text>
            <Text style={styles.nameText}>{picked.name || t('dailyWife.unnamed')}</Text>
            {String(picked.description || '').trim() ? (
              <Text style={styles.descText} numberOfLines={4}>
                {String(picked.description).trim()}
              </Text>
            ) : null}
            {String(picked.personality || '').trim() ? (
              <Text style={styles.personalityText} numberOfLines={3}>
                {String(picked.personality).trim()}
              </Text>
            ) : null}
            {(Array.isArray(picked.tags) && picked.tags.length > 0) ? (
              <View style={styles.tagRow}>
                {picked.tags.slice(0, 4).map(tag => (
                  <View key={tag} style={styles.tagChip}>
                    <Text style={styles.tagChipText}>{tag}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Text style={styles.hintText}>
              {t('dailyWife.tomorrowHint')}
            </Text>
          </View>
        ) : (
          // 角色库空（或库里没有任何可抽取的条目）时才落到这里。此前这个空态写成
          // `loaded && characters.length === 0`，而 characterLibrary 删光也至少留一张卡、
          // AppContext 初始与失败回落都是 [DEFAULT_CHARACTER]，所以它恒不可达——
          // 真正被渲染的永远是「内置助手当今日老婆」的卡片分支。
          <View style={styles.emptyBox}>
            <Ionicons name="people-outline" size={36} color={theme.colors.textFaint} />
            <Text style={styles.emptyTitle}>{t('dailyWife.empty.title')}</Text>
            <Text style={styles.emptyHint}>{t('dailyWife.empty.hint')}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  flex: { flex: 1 },
  gameBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingRight: 10 },
  backButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 2 },
  gameBarTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginLeft: 6 },
  modeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  modeChip: {
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 18,
    paddingVertical: 8,
    marginHorizontal: 6,
  },
  modeChipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryAlpha(0.14),
  },
  modeChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '600' },
  modeChipTextActive: { color: theme.colors.primary, fontWeight: '700' },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 30,
  },
  emptyBox: { alignItems: 'center', paddingVertical: 40 },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(17),
    fontWeight: '800',
    marginTop: 12,
  },
  emptyHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(19),
    textAlign: 'center',
    marginTop: 6,
  },
  cardBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 20,
    alignItems: 'center',
  },
  avatarWrap: {
    width: 148,
    height: 148,
    borderRadius: 74,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
    marginBottom: 14,
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.18),
  },
  avatarFallbackText: { color: theme.colors.primarySoft, fontSize: 56, fontWeight: '800' },
  dateText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
    letterSpacing: 1,
  },
  todayLabel: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(13),
    marginTop: 6,
  },
  nameText: {
    color: theme.colors.text,
    fontSize: fonts.scaled(22),
    fontWeight: '800',
    marginTop: 4,
  },
  descText: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(19),
    textAlign: 'center',
    marginTop: 10,
  },
  personalityText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    textAlign: 'center',
    marginTop: 6,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 12,
  },
  tagChip: {
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginHorizontal: 4,
    marginTop: 6,
  },
  tagChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11) },
  hintText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    marginTop: 16,
    textAlign: 'center',
  },
});
