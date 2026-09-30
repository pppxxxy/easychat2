import './src/polyfills';
import 'react-native-gesture-handler';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Ionicons from '@expo/vector-icons/Ionicons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import ChatScreen from './src/ChatScreen.js';
import CharacterScreen from './src/CharacterScreen.js';
import MemoryScreen from './src/MemoryScreen.js';
import ExtensionScreen from './src/ExtensionScreen.js';
import SettingsScreen from './src/SettingsScreen.js';
import DisclaimerModal from './src/disclaimer.js';
import OnboardingModal from './src/OnboardingModal.js';
import {
  acknowledgeDisclaimer,
  completeOnboarding,
  isDisclaimerAcknowledged,
  isOnboardingDone,
  migrateLegacyMessages,
} from './src/storage.js';
import { AppProvider, useApp } from './src/context/AppContext.js';
import { runDiaryForNewDay } from './src/diary/runDiary.js';
import {
  ackPendingMessages,
  addOpenRoleListener,
  consumeInitialRole,
  consumePendingMessages,
  isProactiveMessageAvailable,
} from './src/proactiveMessage.js';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext.js';
import { maskSecrets } from './src/secrets.js';
import { getCharacterEditGuard, resolveTabName, shouldConfirmTabLeave } from './src/characterEditGuard.js';
import { recordDiagnostic } from './src/diagnostics.js';

const Tab = createBottomTabNavigator();

// 通知点击可能在导航容器挂载完成前到达；用容器 ref + isReady 守卫，
// 未就绪时先把角色入队，onReady 后再消费，避免 navigate 抛
// "navigation object hasn't been initialized yet"。
const navigationRef = createNavigationContainerRef();

// 未捕获的 JS 异常：记录到本地诊断日志（脱敏）后交给原处理器，
// 保留 RN 自身的红屏/崩溃行为，只增加可追溯性。
if (global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
  const previousHandler = global.ErrorUtils.getGlobalHandler
    ? global.ErrorUtils.getGlobalHandler()
    : null;
  global.ErrorUtils.setGlobalHandler((error, isFatal) => {
    try {
      recordDiagnostic('unhandled', error, isFatal ? 'fatal' : 'non-fatal');
    } catch (recordError) {}
    if (typeof previousHandler === 'function') previousHandler(error, isFatal);
  });
}

class StartupErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    recordDiagnostic('startup', error, maskSecrets(String(info && info.componentStack || '')));
    console.log(
      'StartupErrorBoundary',
      maskSecrets(error && error.message),
      maskSecrets(info && info.componentStack)
    );
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.crashScreen}>
          <Text style={styles.crashTitle}>启动失败</Text>
          <Text style={styles.crashHint}>请把以下内容截图反馈：</Text>
          <ScrollView style={styles.crashScroll}>
            <Text style={styles.crashText} selectable>
              {maskSecrets(String(this.state.error && this.state.error.message))}
              {'\n\n'}
              {maskSecrets(String(this.state.error && this.state.error.stack))}
            </Text>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const TAB_ICONS = {
  聊天: ['chatbubble-outline', 'chatbubble'],
  记忆: ['albums-outline', 'albums'],
  角色: ['people-outline', 'people'],
  扩展: ['extension-puzzle-outline', 'extension-puzzle'],
  设置: ['settings-outline', 'settings'],
};

function Header() {
  const insets = useSafeAreaInsets();
  const { theme, fonts, tokens } = useTheme();
  return (
    <View style={[styles.header, {
      paddingTop: insets.top + 12,
      backgroundColor: theme.colors.background,
      borderBottomColor: theme.colors.divider,
    }]}>
      <View style={styles.brandRow}>
        <View style={[styles.logoBadge, { backgroundColor: theme.colors.primary }, tokens.elevation(2, theme)]}>
          <Ionicons name="chatbubbles" size={20} color={theme.colors.primaryContrast} />
        </View>
        <View style={styles.brandText}>
          <Text style={[styles.title, { color: theme.colors.text, fontSize: fonts.scaled(22) }]}>EasyChat2</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textFaint, fontSize: fonts.scaled(11) }]}>AI CHAT APP</Text>
        </View>
      </View>
    </View>
  );
}

function StartupFlow({ onReady }) {
  const [stage, setStage] = useState('loading');

  useEffect(() => {
    if (stage === 'done' && typeof onReady === 'function') onReady();
  }, [onReady, stage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ack = await isDisclaimerAcknowledged();
        if (cancelled) return;
        if (!ack) {
          setStage('disclaimer');
          return;
        }
        const done = await isOnboardingDone();
        if (cancelled) return;
        setStage(done ? 'done' : 'onboarding');
      } catch (error) {
        if (!cancelled) setStage('disclaimer');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onDisclaimerClose = useCallback(async () => {
    try {
      await acknowledgeDisclaimer();
      const done = await isOnboardingDone();
      setStage(done ? 'done' : 'onboarding');
    } catch (error) {
      Alert.alert('保存失败', '完成状态保存失败，请重试。');
    }
  }, []);

  const onOnboardingFinish = useCallback(async () => {
    try {
      await completeOnboarding();
      setStage('done');
    } catch (error) {
      Alert.alert('保存失败', '完成状态保存失败，请重试。');
    }
  }, []);

  return (
    <>
      <DisclaimerModal visible={stage === 'disclaimer'} onClose={onDisclaimerClose} />
      <OnboardingModal visible={stage === 'onboarding'} onFinish={onOnboardingFinish} />
    </>
  );
}

function StartupSession() {
  const { characters, loaded, refreshSessions } = useApp();
  const [retry, setRetry] = useState(0);
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);
  const retryTimerRef = useRef(null);
  const retryAttemptsRef = useRef(0);

  useEffect(() => {
    if (!loaded || startedRef.current || inFlightRef.current) return undefined;
    let cancelled = false;
    inFlightRef.current = true;
    (async () => {
      let failed = false;
      try {
        await migrateLegacyMessages(charactersRef.current);
      } catch (error) {
        failed = true;
      }
      try {
        await refreshSessions();
      } catch (error) {
        failed = true;
      }
      if (!cancelled) {
        if (failed) {
          retryAttemptsRef.current += 1;
          if (retryAttemptsRef.current >= 5) {
            // 迁移反复失败不能无限静默重试：停下并明确告知，避免每次启动都空转。
            startedRef.current = true;
            Alert.alert('启动迁移失败', '旧聊天记录整理未能完成，请检查存储空间后重启应用。');
          } else {
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              setRetry(value => value + 1);
            }, 3000);
          }
        } else {
          startedRef.current = true;
        }
      }
      inFlightRef.current = false;
    })();
    return () => {
      cancelled = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [loaded, retry, refreshSessions]);

  return null;
}

// 角色日记：过了一天之后的第一次启动，为开启日记的角色补写前一天的日记。
// 纯后台任务，失败静默（日记是增值功能，不影响启动与聊天）。
function DiaryStartup() {
  const { loaded } = useApp();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!loaded || startedRef.current) return;
    startedRef.current = true;
    runDiaryForNewDay().catch(() => {});
  }, [loaded]);

  return null;
}

// 定时主动消息：通知点击（热启动走事件、冷启动走启动 intent）切换到对应角色并进入聊天页。
// 与上下文约定一致：切换失败回滚由 AppContext 负责，这里只提示，不在 context 层弹 UI。
function ProactiveMessageBridge({ navigationReady }) {
  const { loaded, switchCharacter, switchSession, ingestProactiveMessages } = useApp();
  const pendingRoleRef = useRef(null);

  // 消费原生待写队列：把到点时生成、但尚未写入会话的主动消息落库。
  // 只有写入成功的、以及永远无法处理的（结构残缺）才 ack 删除；
  // 角色暂时不在库或写入失败的**保留**，下次启动再试，绝不静默丢消息。
  // 返回本次每条消息实际落到的会话（roleId → sessionId），供跳转精确切段。
  const ingestPending = useCallback(async () => {
    if (!loaded) return { targetSessions: {} };
    const messages = await consumePendingMessages();
    if (messages.length === 0) return { targetSessions: {} };
    const { written, skipped, targetSessions } = await ingestProactiveMessages(messages);
    const acked = [...written, ...skipped];
    if (acked.length > 0) await ackPendingMessages(acked);
    return { targetSessions: targetSessions || {} };
  }, [loaded, ingestProactiveMessages]);

  const openRole = useCallback(async roleId => {
    if (!roleId) return;
    // 加载/导航任一未就绪都先入队，避免在挂载完成前调用 navigate。
    //
    // 必须同时门控 loaded：loaded 前调 switchCharacter 会抛「角色尚未加载完成」，
    // 被 catch 吞掉后 roleId 既没入队、原生 pendingRoleId 也已在 drain 时清空
    // → roleId 消费一次即永久丢失（冷启动点通知不跳转的根因）。
    if (!loaded || !navigationReady || !navigationRef.isReady()) {
      pendingRoleRef.current = roleId;
      return;
    }
    try {
      // 先落库；落库会返回消息实际写入的会话 id。
      const { targetSessions } = await ingestPending();
      await switchCharacter(roleId);
      // 精确切到消息实际落到的会话：只 switchCharacter + ensureCharacterSession 会取该角色
      // 的第一段会话，若消息落在另一段（衔接对话选了其它历史），就会停在旧会话看不到新消息。
      const targetSessionId = targetSessions && targetSessions[roleId];
      if (targetSessionId) {
        // switchSession 内部读最新 sessionsRef，能命中刚落库新建的会话；
        // 会话不存在时静默忽略（switchCharacter 已切到该角色的会话）。
        await switchSession(targetSessionId).catch(() => {});
      }
      navigationRef.navigate('聊天');
    } catch (error) {
      Alert.alert('打开失败', '该角色可能已删除，无法打开主动消息会话。');
    }
  }, [loaded, navigationReady, switchCharacter, switchSession, ingestPending]);

  // 加载与导航都就绪后再消费排队中的角色。
  useEffect(() => {
    if (!loaded || !navigationReady || !pendingRoleRef.current) return;
    const roleId = pendingRoleRef.current;
    pendingRoleRef.current = null;
    openRole(roleId);
  }, [loaded, navigationReady, openRole]);

  useEffect(() => {
    if (!isProactiveMessageAvailable()) return undefined;
    if (loaded) {
      (async () => {
        try {
          // 启动即消费一轮：App 未打开期间到点的消息在这里补写进会话。
          await ingestPending();
          const roleId = await consumeInitialRole();
          if (roleId) await openRole(roleId);
        } catch (error) {
          // 原生模块读取失败时静默，不影响主流程
        }
      })();
    }
    const unsubscribe = addOpenRoleListener(openRole);
    return () => unsubscribe();
  }, [loaded, openRole, ingestPending]);

  return null;
}

function AppShell() {
  const { theme: palette, tokens } = useTheme();
  const [navigationReady, setNavigationReady] = useState(false);
  const navTheme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: palette.colors.background,
      card: palette.colors.background,
      text: palette.colors.text,
      border: palette.colors.surface,
      primary: palette.colors.primary,
    },
  };
  // 角色页有未保存编辑时拦截 Tab 切换：底部 Tab 页面保持挂载、切走不丢表单，
  // 但用户容易忘记保存导致修改不生效；确认框把「离开」变成顺手保存的入口。
  //
  // tabPress 事件的 target 是「路由 key」（形如 聊天-xxxx），不是路由名；
  // 而 navigationRef.navigate 只认路由名——直接把 key 传进去会静默 no-op，
  // 表现为点了「直接离开 / 保存并离开」都跳不走、每次切 Tab 又弹一次。
  // 因此先用根状态把 key 解析回路由名，再做比较与导航。
  const handleTabPress = useCallback(event => {
    const guard = getCharacterEditGuard();
    let currentName = '';
    try {
      currentName = String(navigationRef.current?.getCurrentRoute()?.name || '');
    } catch (error) {
      currentName = '';
    }
    let targetName = '';
    try {
      targetName = resolveTabName(navigationRef.getRootState(), event && event.target);
    } catch (error) {
      targetName = '';
    }
    if (!shouldConfirmTabLeave({ dirty: guard.dirty, currentName, targetName })) return;
    event.preventDefault();
    Alert.alert(
      '未保存的修改',
      '角色编辑尚未保存，修改不会在聊天中生效。切换标签不会丢失编辑，退出应用会丢失。',
      [
        { text: '留下编辑', style: 'cancel' },
        { text: '直接离开', onPress: () => navigationRef.navigate(targetName) },
        {
          text: '保存并离开',
          onPress: async () => {
            const saved = await guard.save();
            if (saved) navigationRef.navigate(targetName);
          },
        },
      ]
    );
  }, []);
  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      onReady={() => setNavigationReady(true)}
    >
      <StatusBar style={palette.id === 'light' ? 'dark' : 'light'} />
      <ProactiveMessageBridge navigationReady={navigationReady} />
      <Header />
      <Tab.Navigator
        screenListeners={{ tabPress: handleTabPress }}
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: [styles.tabBar, {
            backgroundColor: palette.colors.surfaceAlt,
            borderTopColor: palette.colors.divider,
          }, tokens.elevation(2, palette)],
          tabBarActiveTintColor: palette.colors.primaryMuted,
          tabBarInactiveTintColor: palette.colors.textFaint,
          tabBarLabelStyle: styles.tabLabel,
          tabBarIcon: ({ color, focused }) => {
            const [outline, filled] = TAB_ICONS[route.name] || ['ellipse-outline', 'ellipse'];
            return (
              <View style={[styles.tabIconWrap, focused && styles.tabIconWrapActive, focused && {
                backgroundColor: palette.colors.primaryAlpha(0.18),
                borderColor: palette.colors.primaryMutedAlpha(0.35),
              }]}>
                <Ionicons name={focused ? filled : outline} size={20} color={color} />
              </View>
            );
          },
        })}
      >
        <Tab.Screen name="聊天" component={ChatScreen} />
        <Tab.Screen name="记忆" component={MemoryScreen} />
        <Tab.Screen name="角色" component={CharacterScreen} />
        <Tab.Screen name="扩展" component={ExtensionScreen} />
        <Tab.Screen name="设置" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const [startupReady, setStartupReady] = useState(false);
  const handleStartupReady = useCallback(() => setStartupReady(true), []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StartupErrorBoundary>
          <ThemeProvider>
            <AppProvider>
              {startupReady ? <AppShell /> : null}
              {startupReady ? <StartupSession /> : null}
              {startupReady ? <DiaryStartup /> : null}
              <StartupFlow onReady={handleStartupReady} />
            </AppProvider>
          </ThemeProvider>
        </StartupErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  crashScreen: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  crashTitle: { color: '#ff9b9b', fontSize: 20, fontWeight: '800', marginBottom: 8 },
  crashHint: { color: '#c9c9e0', fontSize: 13, marginBottom: 12 },
  crashScroll: { flex: 1 },
  crashText: { color: '#e6e6f2', fontSize: 12, lineHeight: 18 },
  header: {
    paddingBottom: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  logoBadge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  brandText: { justifyContent: 'center' },
  title: { fontWeight: '800', letterSpacing: 0.2 },
  subtitle: { marginTop: 3, letterSpacing: 2, fontWeight: '600' },
  tabBar: {
    borderTopWidth: 1,
    paddingTop: 6,
  },
  tabLabel: { fontSize: 11, fontWeight: '600' },
  tabIconWrap: {
    width: 48,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
});
