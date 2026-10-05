// 游戏中心：原生 / 网页两组，列表 + WebView 详情。
//
// 从 ExtensionScreen.js 提取为独立组件；Stack 化后物理返回天然工作，
// 删除原 BackHandler 补丁。游戏详情的返回按钮改为导航返回。
import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { EmptyState, PrimaryButton } from '../ui/index.js';
import { GAMES } from '../games/games.js';
import DailyWifeView from '../games/DailyWifeView.js';

let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch {
  WebViewComponent = null;
}

export default function GamesView() {
  const [activeGameId, setActiveGameId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();

  const activeGame = useMemo(
    () => GAMES.find(game => game.id === activeGameId) || null,
    [activeGameId]
  );

  const openGame = useCallback(game => {
    setFailed(false);
    setReloadKey(0);
    setActiveGameId(game.id);
  }, []);

  const backToList = useCallback(() => {
    setActiveGameId('');
    setFailed(false);
  }, []);

  const nativeGames = useMemo(() => GAMES.filter(g => g.native), []);
  const webGames = useMemo(() => GAMES.filter(g => !g.native), []);

  const renderGameCard = useCallback(({ item }) => (
    <TouchableOpacity style={styles.gameCard} onPress={() => openGame(item)} activeOpacity={0.85}>
      <View style={styles.gameIcon}>
        <Ionicons name="game-controller" size={20} color={theme.colors.primaryContrast} />
      </View>
      <View style={styles.gameText}>
        <Text style={styles.gameName}>{item.name}</Text>
        <Text style={styles.gameDescription}>{item.description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.colors.textFaint} />
    </TouchableOpacity>
  ), [openGame, styles]);

  if (activeGame && activeGame.native === 'daily-wife') {
    return <DailyWifeView onBack={backToList} />;
  }

  if (!WebViewComponent) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <EmptyState
          icon="alert-circle-outline"
          title={t('ext.games.env.title')}
          description={t('ext.games.env.body')}
        />
      </SafeAreaView>
    );
  }

  if (activeGame) {
    return (
      <View style={styles.container}>
        <View style={styles.gameBar}>
          <TouchableOpacity style={styles.backButton} onPress={backToList} activeOpacity={0.8}>
            <Ionicons name="chevron-back" size={18} color={theme.colors.textMuted} />
            <Text style={styles.backButtonText}>{t('ext.games.back')}</Text>
          </TouchableOpacity>
          <Text style={styles.gameBarTitle}>{activeGame.name}</Text>
        </View>
        {failed ? (
          <EmptyState
            icon="cloud-offline-outline"
            title={t('ext.games.load.title')}
            description={t('ext.games.load.body')}
            action={
              <PrimaryButton
                title={t('common.retry')}
                small
                onPress={() => {
                  setFailed(false);
                  setReloadKey(value => value + 1);
                }}
              />
            }
          />
        ) : (
          <WebViewComponent
            key={`${activeGame.id}-${reloadKey}`}
            originWhitelist={['*']}
            source={{ html: activeGame.html }}
            style={styles.webview}
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
            onError={() => setFailed(true)}
            onHttpError={() => setFailed(true)}
          />
        )}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.listContent}>
        <Text style={styles.sectionHeader}>{t('ext.games.section.native')}</Text>
        {nativeGames.map(game => (
          <React.Fragment key={game.id}>{renderGameCard({ item: game })}</React.Fragment>
        ))}
        <Text style={styles.sectionHeader}>{t('ext.games.section.web')}</Text>
        {webGames.map(game => (
          <React.Fragment key={game.id}>{renderGameCard({ item: game })}</React.Fragment>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme, fonts, tokens) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
  gameCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    padding: tokens.metrics.cardPadding,
    marginBottom: tokens.metrics.cardGap,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  gameIcon: {
    width: 40,
    height: 40,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  gameText: { flex: 1, marginRight: 8 },
  gameName: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700' },
  gameDescription: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 4, lineHeight: fonts.scaled(17) },
  gameBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingRight: 10 },
  backButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 2 },
  gameBarTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginLeft: 6 },
  sectionHeader: {
    color: theme.colors.primaryMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '800',
    marginTop: 14,
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  webview: { flex: 1, backgroundColor: theme.colors.background },
});
