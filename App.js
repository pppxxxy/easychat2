import './src/polyfills';
import 'react-native-gesture-handler';

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
import {
  acknowledgeDisclaimer,
  isDisclaimerAcknowledged,
  migrateLegacyMessages,
  startNewSession,
} from './src/storage';
import { AppProvider, useApp } from './src/context/AppContext';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';

const Tab = createBottomTabNavigator();

const TAB_ICONS = {
  聊天: ['chatbubble-outline', 'chatbubble'],
  记忆: ['albums-outline', 'albums'],
  角色: ['people-outline', 'people'],
  扩展: ['extension-puzzle-outline', 'extension-puzzle'],
  设置: ['settings-outline', 'settings'],
};

function Header() {
  const insets = useSafeAreaInsets();
  const { theme, fonts } = useTheme();
  return (
    <View style={[styles.header, {
      paddingTop: insets.top + 12,
      backgroundColor: theme.colors.background,
      borderBottomColor: theme.colors.divider,
    }]}>
      <View style={styles.brandRow}>
        <View style={[styles.logoBadge, { backgroundColor: theme.colors.primary }]}>
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

function StartupDisclaimer() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isDisclaimerAcknowledged()
      .then(ack => {
        if (!cancelled && !ack) setVisible(true);
      })
      .catch(() => {
        if (!cancelled) setVisible(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onClose = () => {
    setVisible(false);
    acknowledgeDisclaimer().catch(() => {});
  };

  return <DisclaimerModal visible={visible} onClose={onClose} />;
}

function StartupSession() {
  const { characters, activeId, loaded, refreshSessions } = useApp();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!loaded || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        await migrateLegacyMessages(characters);
      } catch (error) {}
      try {
        await startNewSession(activeId);
      } catch (error) {}
      try {
        await refreshSessions();
      } catch (error) {}
    })();
  }, [loaded, characters, activeId, refreshSessions]);

  return null;
}

function AppShell() {
  const { theme: palette } = useTheme();
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
          }],
          tabBarActiveTintColor: palette.colors.primaryMuted,
          tabBarInactiveTintColor: palette.colors.textFaint,
          tabBarLabelStyle: styles.tabLabel,
          tabBarIcon: ({ color, focused }) => {
            const [outline, filled] = TAB_ICONS[route.name] || ['ellipse-outline', 'ellipse'];
            return (
              <View style={[styles.tabIconWrap, focused && styles.tabIconWrapActive, focused && {
                backgroundColor: `${palette.colors.primary}38`,
                borderColor: `${palette.colors.primaryMuted}59`,
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
        <ThemeProvider>
          <AppProvider>
            <AppShell />
            <StartupSession />
            <StartupDisclaimer />
          </AppProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  brandText: { justifyContent: 'center' },
  title: { fontWeight: '800', letterSpacing: 0.2 },
  subtitle: { marginTop: 3, letterSpacing: 2, fontWeight: '600' },
  tabBar: {
    borderTopWidth: 1,
    paddingTop: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 12,
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
