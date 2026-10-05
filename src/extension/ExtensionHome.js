// 拓展页首页：分组入口网格。
//
// 替换原 ExtensionScreen 的 4 段 segmentRow + opacity 叠罗汉。
// 7+1 个入口全部同行为（点击=navigate），消灭「跳出 vs 手风琴」二义性。
// 分类从「世界 vs 其他」改为功能语义：创作 / 日常陪伴 / 内容库 / 小游戏。
//
// 摘要行数据来自现有 storage（getMomentsSettings 等已有函数），纯展示不改数据层。
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getMomentsSettings, getProactiveSettings } from '../storage.js';
import { getMusicItems } from '../music/library.js';
import { getBooks } from '../books/library.js';
import { getWorldMap } from '../storage/worldMap.js';
import { GAMES } from '../games/games.js';

const GROUPS = [
  {
    id: 'create',
    items: [
      { id: 'forge', route: 'ext-forge', icon: 'id-card-outline', labelKey: 'ext.home.forge', descKey: 'ext.home.forge.desc' },
      { id: 'image', route: 'ext-image', icon: 'image-outline', labelKey: 'ext.home.image', descKey: 'ext.home.image.desc' },
    ],
  },
  {
    id: 'companion',
    items: [
      { id: 'moments', route: 'ext-moments', icon: 'planet-outline', labelKey: 'ext.home.moments', descKey: 'ext.home.moments.desc' },
      { id: 'proactive', route: 'ext-proactive', icon: 'notifications-outline', labelKey: 'ext.home.proactive', descKey: 'ext.home.proactive.desc' },
      { id: 'diary', route: 'ext-diary', icon: 'book-outline', labelKey: 'ext.home.diary', descKey: 'ext.home.diary.desc' },
      { id: 'screen', route: 'ext-screen', icon: 'eye-outline', labelKey: 'ext.home.screen', descKey: 'ext.home.screen.desc' },
    ],
  },
  {
    id: 'library',
    items: [
      { id: 'music', route: 'ext-music', icon: 'musical-notes-outline', labelKey: 'ext.home.music', descKey: 'ext.home.music.desc' },
      { id: 'books', route: 'ext-books', icon: 'library-outline', labelKey: 'ext.home.books', descKey: 'ext.home.books.desc' },
      { id: 'map', route: 'ext-map', icon: 'map-outline', labelKey: 'ext.home.map', descKey: 'ext.home.map.desc' },
    ],
  },
  {
    id: 'games',
    items: [
      { id: 'games', route: 'ext-games', icon: 'game-controller-outline', labelKey: 'ext.home.games', descKey: 'ext.home.games.desc' },
    ],
  },
];

export default function ExtensionHome() {
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const [momentsEnabled, setMomentsEnabled] = useState(false);
  const [proactiveCount, setProactiveCount] = useState(0);
  const [musicCount, setMusicCount] = useState(0);
  const [bookCount, setBookCount] = useState(0);
  const [houseCount, setHouseCount] = useState(0);

  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // 进入页面时刷新摘要行数据（各 storage 函数已有，纯展示）。
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const load = async () => {
        try {
          const ms = await getMomentsSettings();
          if (!cancelled) setMomentsEnabled(ms.enabled === true);
        } catch { /* ignore */ }
        try {
          const ps = await getProactiveSettings();
          if (!cancelled) setProactiveCount((ps.slots || []).length);
        } catch { /* ignore */ }
        try {
          const ml = await getMusicItems();
          if (!cancelled) setMusicCount(ml.length);
        } catch { /* ignore */ }
        try {
          const bl = await getBooks();
          if (!cancelled) setBookCount(bl.length);
        } catch { /* ignore */ }
        try {
          const map = await getWorldMap();
          if (!cancelled) setHouseCount((map.houses || []).length);
        } catch { /* ignore */ }
      };
      load();
      return () => { cancelled = true; };
    }, [])
  );

  const getSummary = useCallback((itemId) => {
    switch (itemId) {
      case 'moments': return momentsEnabled ? t('ext.home.moments.on') : t('ext.home.moments.off');
      case 'proactive': return t('ext.home.proactive.summary', { count: proactiveCount });
      case 'music': return musicCount > 0 ? t('ext.home.music.summary', { count: musicCount }) : '';
      case 'books': return bookCount > 0 ? t('ext.home.books.summary', { count: bookCount }) : '';
      case 'map': return houseCount > 0 ? t('ext.home.map.summary', { count: houseCount }) : '';
      case 'games': return t('ext.home.games.summary', { count: GAMES.length });
      default: return '';
    }
  }, [momentsEnabled, proactiveCount, musicCount, bookCount, houseCount, t]);

  const renderItem = useCallback(({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate(item.route)}
      activeOpacity={0.85}
    >
      <View style={styles.cardIcon}>
        <Ionicons name={item.icon} size={18} color={theme.colors.primaryContrast} />
      </View>
      <View style={styles.cardText}>
        <Text style={styles.cardTitle}>{t(item.labelKey)}</Text>
        <Text style={styles.cardDesc} numberOfLines={1}>{t(item.descKey)}</Text>
        {(() => { const s = getSummary(item.id); return s ? <Text style={styles.cardSummary} numberOfLines={1}>{s}</Text> : null; })()}
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.colors.textFaint} />
    </TouchableOpacity>
  ), [navigation, styles, theme, t, getSummary]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <FlatList
        data={GROUPS}
        keyExtractor={g => g.id}
        renderItem={({ item: group }) => (
          <View style={styles.group}>
            <Text style={styles.groupTitle}>{t(`ext.home.group.${group.id}`)}</Text>
            {group.items.map(entry => renderItem({ item: entry }))}
          </View>
        )}
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

const createStyles = (theme, fonts, tokens) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
  group: { marginBottom: tokens.spacing.lg },
  groupTitle: {
    color: theme.colors.primaryMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '800',
    marginTop: 14,
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    padding: tokens.metrics.cardPadding,
    marginBottom: tokens.metrics.cardGap,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  cardText: { flex: 1, marginRight: 8 },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700' },
  cardDesc: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 3, lineHeight: fonts.scaled(17) },
  cardSummary: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 4, fontWeight: '600' },
});
