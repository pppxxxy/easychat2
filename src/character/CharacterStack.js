// 角色 Tab 的原生栈：列表（角色库）与详情（编辑表单）分离。
// 拆之前两者同处一个 ScrollView，靠手写卡片 offset 补丁实现「点卡片 → 滚到下方表单」；
// 拆之后由路由承担这层跳转，两屏各自挂载、各自持有自己的 state。
//
// headerShown: false 与拆前的页内页头保持一致（详情页自带返回入口）。

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import CharacterLibraryScreen from './CharacterLibraryScreen.js';
import CharacterDetailScreen from './CharacterDetailScreen.js';

const Stack = createNativeStackNavigator();

export default function CharacterStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="CharacterLibrary" component={CharacterLibraryScreen} />
      <Stack.Screen name="CharacterDetail" component={CharacterDetailScreen} />
    </Stack.Navigator>
  );
}
