import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import CardForgeScreen from './CardForgeScreen.js';
import DailyWifeView from './games/DailyWifeView.js';
import DiaryPanel from './DiaryPanel.js';
import ImageGenScreen from './ImageGenScreen.js';
import MapPanel from './MapPanel.js';
import MomentsView from './MomentsView.js';
import ProactivePanel from './ProactivePanel.js';
import { GAMES } from './games/games.js';
import { getMomentsSettings } from './storage.js';
import { EmptyState, PrimaryButton } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';

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
  { id: 'forge', label: '制卡', icon: 'id-card-outline' },
];

// 「世界」把赋予角色生命力的扩展收拢在一处：动态、互动，后续新增也归到这里。
const WORLD_SEGMENT = { id: 'world', label: '世界', icon: 'earth-outline' };

function GamesView() {
  const [activeGameId, setActiveGameId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

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

  if (activeGame && activeGame.native === 'daily-wife') {
    // 原生游戏：需要读角色库，WebView 拿不到存储，走独立面板。
    // 放在 WebView 守卫之前：原生游戏不依赖 WebView，环境不支持也能玩。
    return <DailyWifeView onBack={backToList} />;
  }

  if (!WebViewComponent) {
    return (
      <EmptyState
        icon="alert-circle-outline"
        title="环境不支持"
        description="当前环境不支持游戏运行，请更新应用到最新版本。"
      />
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
          <EmptyState
            icon="cloud-offline-outline"
            title="加载失败"
            description="网络或资源异常，请重试。"
            action={
              <PrimaryButton
                title="重试"
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

// 「世界」折叠分组：赋予角色生命力的扩展都收拢在这里。
// 互动在分组内就地展开编辑；动态是虚拟化长列表，展开会切到独立面板（避免 FlatList 嵌套滚动）。
function WorldView({ momentsEnabled, onOpenMoments }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  // 互动分组初始保持折叠：进入页面先看到分组列表，不默认展开编辑面板。
  const [openSection, setOpenSection] = useState('');

  const sections = useMemo(() => {
    const list = [];
    if (momentsEnabled) {
      list.push({ id: 'moments', label: '动态', icon: 'planet-outline', description: '角色会随时间生成自己的动态' });
    }
    list.push({ id: 'interactive', label: '互动', icon: 'chatbubbles-outline', description: '角色在指定时间主动发来消息' });
    list.push({ id: 'diary', label: '日记', icon: 'book-outline', description: '角色为你和它的对话写日记' });
    list.push({ id: 'map', label: '地图', icon: 'map-outline', description: '在网格地图上为自己和角色安家' });
    return list;
  }, [momentsEnabled]);

  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      {sections.map(section => {
        const expanded = openSection === section.id;
        const isMoments = section.id === 'moments';
        return (
          <View key={section.id} style={styles.worldGroup}>
            <TouchableOpacity
              style={styles.worldHeader}
              onPress={() => {
                if (isMoments) {
                  onOpenMoments();
                  return;
                }
                setOpenSection(expanded ? '' : section.id);
              }}
              activeOpacity={0.85}
            >
              <View style={styles.worldIcon}>
                <Ionicons name={section.icon} size={18} color={theme.colors.primaryContrast} />
              </View>
              <View style={styles.gameText}>
                <Text style={styles.gameName}>{section.label}</Text>
                <Text style={styles.gameDescription}>{section.description}</Text>
              </View>
              <Ionicons
                name={isMoments ? 'chevron-forward' : (expanded ? 'chevron-down' : 'chevron-forward')}
                size={18}
                color={theme.colors.textFaint}
              />
            </TouchableOpacity>
            {!isMoments && expanded ? (
              <View style={styles.worldBody}>
                {section.id === 'diary'
                  ? <DiaryPanel embedded />
                  : (section.id === 'map' ? <MapPanel embedded /> : <ProactivePanel embedded />)}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

export default function ExtensionScreen({ route }) {
  const [segment, setSegment] = useState('games');
  const [momentsEnabled, setMomentsEnabled] = useState(false);
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

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

  // 角色页会带参数跳过来（例如「导入到制卡」），按参数切到对应模块
  useEffect(() => {
    const params = route && route.params;
    if (!params || !params.segment) return;
    // 旧入口的 'moments' 现在归到「世界」分组下
    setSegment(params.segment === 'moments' ? 'world' : params.segment);
  }, [route && route.params]);

  const segments = useMemo(() => [...SEGMENTS, WORLD_SEGMENT], []);

  // 动态被关闭时不能停留在动态面板上
  useEffect(() => {
    if (!momentsEnabled && segment === 'moments') setSegment('world');
  }, [momentsEnabled, segment]);

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
          <ImageGenScreen embedded active={segment === 'image'} />
        </View>
        <View
          style={[styles.pane, segment === 'forge' ? styles.paneVisible : styles.paneHidden]}
          pointerEvents={segment === 'forge' ? 'auto' : 'none'}
        >
          <CardForgeScreen
            active={segment === 'forge'}
            refreshKey={route && route.params ? route.params.ts : 0}
          />
        </View>
        <View
          style={[styles.pane, segment === 'world' ? styles.paneVisible : styles.paneHidden]}
          pointerEvents={segment === 'world' ? 'auto' : 'none'}
        >
          <WorldView
            momentsEnabled={momentsEnabled}
            onOpenMoments={() => setSegment('moments')}
          />
        </View>
        {momentsEnabled ? (
          <View
            style={[styles.pane, segment === 'moments' ? styles.paneVisible : styles.paneHidden]}
            pointerEvents={segment === 'moments' ? 'auto' : 'none'}
          >
            <View style={styles.gameBar}>
              <TouchableOpacity
                style={styles.backButton}
                onPress={() => setSegment('world')}
                activeOpacity={0.8}
              >
                <Ionicons name="chevron-back" size={18} color={theme.colors.textMuted} />
                <Text style={styles.backButtonText}>世界</Text>
              </TouchableOpacity>
              <Text style={styles.gameBarTitle}>动态</Text>
            </View>
            <MomentsView active={segment === 'moments'} />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  segmentRow: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.spacing.xs,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: tokens.radius.sm,
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
    borderRadius: tokens.metrics.cardRadius,
    padding: tokens.metrics.cardPadding,
    marginBottom: tokens.metrics.cardGap,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    ...tokens.elevation(1, theme),
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
  webview: { flex: 1, backgroundColor: theme.colors.background },
  retryButton: {
    marginTop: 14,
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
  worldGroup: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: tokens.metrics.cardGap,
    overflow: 'hidden',
    ...tokens.elevation(1, theme),
  },
  worldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: tokens.metrics.cardPadding,
  },
  worldIcon: {
    width: 40,
    height: 40,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  worldBody: {
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    paddingBottom: tokens.metrics.cardPadding,
    minHeight: 320,
  },
});
