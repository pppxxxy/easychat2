// 拓展页导航架构：嵌套 native-stack 替换原 opacity 叠罗汉。
//
// 原 ExtensionScreen 把 8 个重型面板（5500+ 行）全部常驻挂载、靠 opacity:0/zIndex:0
// 手工模拟页面切换——切到「游戏」时图像/制卡/音乐等仍在后台活着。改用真正的
// Stack 后：物理返回键天然工作（native-stack 自带），切页面才挂载，Tab 切走自动
// 卸载省内存，深度跳转直接 navigation.navigate。
//
// 各子面板的 embedded/active props 一并清除：Stack 化后每个面板都是独立页面，
// 不需要「是否嵌入折叠分组」「是否当前可见」的双模式。返回栏由各面板内部渲染
// （Phase 4 统一为 PaneHeader），这里只做导航注册。
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useTheme } from '../theme/ThemeContext.js';

import ExtensionHome from './ExtensionHome.js';
import GamesView from './GamesView.js';
import ImageGenScreen from '../ImageGenScreen.js';
import CardForgeScreen from '../CardForgeScreen.js';
import MomentsView from '../MomentsView.js';
import MusicScreen from '../music/MusicScreen.js';
import BookScreen from '../books/BookScreen.js';
import ScreenWatchScreen from '../screenWatch/ScreenWatchScreen.js';
import ProactivePanel from '../ProactivePanel.js';
import DiaryPanel from '../DiaryPanel.js';
import MapPanel from '../MapPanel.js';

const Stack = createNativeStackNavigator();

export default function ExtensionStack() {
  const { theme } = useTheme();
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="ext-home" component={ExtensionHome} />
      <Stack.Screen name="ext-games" component={GamesView} />
      <Stack.Screen name="ext-image" component={ImageGenScreen} />
      <Stack.Screen name="ext-forge" component={CardForgeScreen} />
      <Stack.Screen name="ext-moments" component={MomentsView} />
      <Stack.Screen name="ext-music" component={MusicScreen} />
      <Stack.Screen name="ext-books" component={BookScreen} />
      <Stack.Screen name="ext-screen" component={ScreenWatchScreen} />
      <Stack.Screen name="ext-proactive" component={ProactivePanel} />
      <Stack.Screen name="ext-diary" component={DiaryPanel} />
      <Stack.Screen name="ext-map" component={MapPanel} />
    </Stack.Navigator>
  );
}
