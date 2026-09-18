import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import ImageGenScreen from './ImageGenScreen';
import MomentsView from './MomentsView';
import { GAMES } from './games/games';
import { getMomentsSettings } from './storage';
import { useTheme } from './theme/ThemeContext';

let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch (error) {
  WebViewComponent = null;
}

const SEGMENTS = [
  { id: 'games', label: '游戏', icon: 'game-controller-outline' },
  { id: 'image', label: '生图', icon: 'image-outline' },
];

const MOMENTS_SEGMENT = { id: 'moments', label: '朋友圈', icon: 'planet-outline' };

function GamesView() {
  const [activeGameId, setActiveGameId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

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

  if (!WebViewComponent) {
    return (
      <View style={styles.empty}>
        <Ionicons name="alert-circle-outline" size={32} color={theme.colors.textFaint} />
        <Text style={styles.emptyText}>当前环境不支持游戏运行，请更新应用到最新版本。</Text>
      </View>
    );
  }

  if (activeGame) {
    return (
      <View style={styles.flex}>
        <View style={styles.gameBar}>
          <TouchableOpacity style={styles.backButton} onPress={backToList} activeOpacity={0.8}>
            <Ionicons name="chevron-back" size={18} color={theme.colors.textMuted} />
            <Text style={styles.backButtonText}>返回列表</Text>
          </TouchableOpacity>
          <Text style={styles.gameBarTitle}>{activeGame.name}</Text>
        </View>
        {failed ? (
          <View style={styles.empty}>
            <Ionicons name="cloud-offline-outline" size={32} color={theme.colors.textFaint} />
            <Text style={styles.emptyText}>加载失败，请重试。</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                setFailed(false);
                setReloadKey(value => value + 1);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.retryButtonText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <WebViewComponent
            key={`${activeGame.id}-${reloadKey}`}
            originWhitelist={['*']}
            source={{ html: activeGame.html }}
            style={styles.webview}
            javaScriptEnabled
            domStorageEnabled={false}
            setSupportMultipleWindows={false}
            onError={() => setFailed(true)}
            onHttpError={() => setFailed(true)}
          />
        )}
      </View>
    );
  }

  return (
    <FlatList
      data={GAMES}
      keyExtractor={game => game.id}
      contentContainerStyle={styles.listContent}
      renderItem={({ item }) => (
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
      )}
    />
  );
}

export default function ExtensionScreen() {
  const [segment, setSegment] = useState('games');
  const [momentsEnabled, setMomentsEnabled] = useState(false);
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

  const navigation = useNavigation();
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getMomentsSettings()
        .then(settings => {
          if (!cancelled) setMomentsEnabled(settings.enabled === true);
        })
        .catch(() => {});
    };
    load();
    if (!navigation) return () => { cancelled = true; };
    const unsubscribe = navigation.addListener('focus', load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [navigation]);

  const segments = useMemo(
    () => (momentsEnabled ? [...SEGMENTS, MOMENTS_SEGMENT] : SEGMENTS),
    [momentsEnabled]
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.segmentRow}>
        {segments.map(item => {
          const active = item.id === segment;
          return (
            <TouchableOpacity
              key={item.id}
              style={[styles.segment, active && styles.segmentActive]}
              onPress={() => setSegment(item.id)}
              activeOpacity={0.85}
            >
              <Ionicons
                name={item.icon}
                size={16}
                color={active ? theme.colors.primaryContrast : theme.colors.textFaint}
              />
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={styles.body}>
        <View
          style={[styles.pane, segment === 'games' ? styles.paneVisible : styles.paneHidden]}
          pointerEvents={segment === 'games' ? 'auto' : 'none'}
        >
          <GamesView />
        </View>
        <View
          style={[styles.pane, segment === 'image' ? styles.paneVisible : styles.paneHidden]}
          pointerEvents={segment === 'image' ? 'auto' : 'none'}
        >
          <ImageGenScreen embedded />
        </View>
        {momentsEnabled ? (
          <View
            style={[styles.pane, segment === 'moments' ? styles.paneVisible : styles.paneHidden]}
            pointerEvents={segment === 'moments' ? 'auto' : 'none'}
          >
            <MomentsView active={segment === 'moments'} />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  segmentRow: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 4,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 9,
  },
  segmentActive: { backgroundColor: theme.colors.primary },
  segmentText: { color: theme.colors.textFaint, fontSize: fonts.scaled(14), fontWeight: '600', marginLeft: 6 },
  segmentTextActive: { color: theme.colors.primaryContrast },
  body: { flex: 1 },
  pane: { ...StyleSheet.absoluteFillObject },
  paneVisible: { opacity: 1, zIndex: 1 },
  paneHidden: { opacity: 0, zIndex: 0 },
  flex: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
  gameCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  gameIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
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
  webview: { flex: 1, backgroundColor: theme.colors.background },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: 10, textAlign: 'center', lineHeight: fonts.scaled(19) },
  retryButton: {
    marginTop: 14,
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
});
