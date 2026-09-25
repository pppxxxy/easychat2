import './src/polyfills';
import 'react-native-gesture-handler';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Ionicons from '@expo/vector-icons/Ionicons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import ChatScreen from './src/ChatScreen';
import CharacterScreen from './src/CharacterScreen';
import MemoryScreen from './src/MemoryScreen';
import ExtensionScreen from './src/ExtensionScreen';
import SettingsScreen from './src/SettingsScreen';
import DisclaimerModal from './src/disclaimer';
import OnboardingModal from './src/OnboardingModal';
import {
  acknowledgeDisclaimer,
  completeOnboarding,
  isDisclaimerAcknowledged,
  isOnboardingDone,
  migrateLegacyMessages,
} from './src/storage';
import { AppProvider, useApp } from './src/context/AppContext';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { maskSecrets } from './src/secrets';

const Tab = createBottomTabNavigator();

class StartupErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
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

function AppShell() {
  const { theme: palette, tokens } = useTheme();
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
  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style={palette.id === 'light' ? 'dark' : 'light'} />
      <Header />
      <Tab.Navigator
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
