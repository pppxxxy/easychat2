import './src/polyfills';
import 'react-native-gesture-handler';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
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
    console.log('StartupErrorBoundary', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.crashScreen}>
          <Text style={styles.crashTitle}>启动失败</Text>
          <Text style={styles.crashHint}>请把以下内容截图反馈：</Text>
          <ScrollView style={styles.crashScroll}>
            <Text style={styles.crashText} selectable>
              {String(this.state.error && this.state.error.message)}
              {'\n\n'}
              {String(this.state.error && this.state.error.stack)}
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

function StartupFlow() {
  const [stage, setStage] = useState('loading');

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

  const onDisclaimerClose = useCallback(() => {
    acknowledgeDisclaimer().catch(() => {});
    isOnboardingDone()
      .then(done => setStage(done ? 'done' : 'onboarding'))
      .catch(() => setStage('done'));
  }, []);

  const onOnboardingFinish = useCallback(() => {
    completeOnboarding().catch(() => {});
    setStage('done');
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
  const startedRef = useRef(false);

  useEffect(() => {
    if (!loaded || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        await migrateLegacyMessages(characters);
      } catch (error) {}
      try {
        await refreshSessions();
      } catch (error) {}
    })();
  }, [loaded, characters, refreshSessions]);

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
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StartupErrorBoundary>
          <ThemeProvider>
            <AppProvider>
              <AppShell />
              <StartupSession />
              <StartupFlow />
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
