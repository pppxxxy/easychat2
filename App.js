import 'react-native-gesture-handler';

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import ChatScreen from './src/ChatScreen';
import CharacterScreen from './src/CharacterScreen';
import SettingsScreen from './src/SettingsScreen';
import { AppProvider } from './src/context/AppContext';

const Tab = createBottomTabNavigator();

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
      <Text style={styles.title}>EasyChat2</Text>
      <Text style={styles.subtitle}>AI Chat App</Text>
    </View>
  );
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
            screenOptions={{
              headerShown: false,
              tabBarStyle: { backgroundColor: '#1a1a2e', borderTopColor: '#2d2d44' },
              tabBarActiveTintColor: '#6c63ff',
              tabBarInactiveTintColor: '#aaa'
            }}
          >
            <Tab.Screen name="聊天" component={ChatScreen} />
            <Tab.Screen name="角色" component={CharacterScreen} />
            <Tab.Screen name="设置" component={SettingsScreen} />
          </Tab.Navigator>
          </NavigationContainer>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingBottom: 14,
    paddingHorizontal: 20,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44'
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#aaa', marginTop: 4 }
});
