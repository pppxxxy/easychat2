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
import SettingsScreen from './src/SettingsScreen';
import DisclaimerModal from './src/disclaimer';
import {
  acknowledgeDisclaimer,
  isDisclaimerAcknowledged,
  migrateLegacyMessages,
  startNewSession,
} from './src/storage';
import { AppProvider, useApp } from './src/context/AppContext';

const Tab = createBottomTabNavigator();

const TAB_ICONS = {
  聊天: ['chatbubble-outline', 'chatbubble'],
  记忆: ['albums-outline', 'albums'],
  角色: ['people-outline', 'people'],
  设置: ['settings-outline', 'settings'],
};

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#1a1a2e',
    card: '#1a1a2e',
    text: '#ffffff',
    border: '#2d2d44',
    primary: '#6c63ff'
  }
};

function Header() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      <View style={styles.brandRow}>
        <View style={styles.logoBadge}>
          <Ionicons name="chatbubbles" size={20} color="#ffffff" />
        </View>
        <View style={styles.brandText}>
          <Text style={styles.title}>EasyChat2</Text>
          <Text style={styles.subtitle}>AI CHAT APP</Text>
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

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <NavigationContainer theme={theme}>
          <StatusBar style="light" />
          <Header />
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerShown: false,
              tabBarStyle: styles.tabBar,
              tabBarActiveTintColor: '#8b85ff',
              tabBarInactiveTintColor: '#7d7d99',
              tabBarLabelStyle: styles.tabLabel,
              tabBarIcon: ({ color, focused }) => {
                const [outline, filled] = TAB_ICONS[route.name] || ['ellipse-outline', 'ellipse'];
                return (
                  <View style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}>
                    <Ionicons name={focused ? filled : outline} size={20} color={color} />
                  </View>
                );
              },
            })}
          >
            <Tab.Screen name="聊天" component={ChatScreen} />
            <Tab.Screen name="记忆" component={MemoryScreen} />
            <Tab.Screen name="角色" component={CharacterScreen} />
            <Tab.Screen name="设置" component={SettingsScreen} />
          </Tab.Navigator>
          </NavigationContainer>
          <StartupSession />
          <StartupDisclaimer />
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingBottom: 16,
    paddingHorizontal: 20,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#35354f',
  },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  logoBadge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    borderWidth: 1,
    borderColor: 'rgba(139,133,255,0.45)',
    shadowColor: '#6c63ff',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  brandText: { justifyContent: 'center' },
  title: { color: '#ffffff', fontSize: 22, fontWeight: '800', letterSpacing: 0.2 },
  subtitle: { color: '#8a8aa3', fontSize: 11, marginTop: 3, letterSpacing: 2, fontWeight: '600' },
  tabBar: {
    backgroundColor: '#20203a',
    borderTopWidth: 1,
    borderTopColor: '#35354f',
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
  tabIconWrapActive: {
    backgroundColor: 'rgba(108,99,255,0.22)',
    borderColor: 'rgba(139,133,255,0.35)',
  },
});
