// 工作区设置存储域：模式（ask/read/write）持久化在单一键下。
// 从 storage 门面转发；归一化在 src/workspace/settings.js（纯函数）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeWorkspaceSettings } from '../workspace/settings.js';
import { readJson } from './io.js';

export const WORKSPACE_KEY = '@easychat2_workspace';

export async function getWorkspaceSettings() {
  const raw = await readJson(WORKSPACE_KEY, null);
  return normalizeWorkspaceSettings(raw);
}

export async function saveWorkspaceSettings(settings) {
  const normalized = normalizeWorkspaceSettings(settings);
  await AsyncStorage.setItem(WORKSPACE_KEY, JSON.stringify(normalized));
  return normalized;
}