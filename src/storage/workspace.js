// 工作区设置存储域：模式（ask/read/write）、根位置与命令执行开关持久化在单一键下。
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

// 局部更新：读现值 → 合并补丁 → 归一化写回。
//
// 存在的理由与 patchAppearanceSettings 相同：本键现在同时承载模式、根位置
// 与命令执行开关，而它们由不同界面分别修改。若各自调用 saveWorkspaceSettings
// 且只带自己的字段，归一化会把其余字段打回默认——表现为「改模式把已选文件夹
// 和 bash 开关静默清掉了」。所有写入方都应走这个函数。
export async function patchWorkspaceSettings(patch) {
  const current = await getWorkspaceSettings();
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const normalized = normalizeWorkspaceSettings(merged);
  await AsyncStorage.setItem(WORKSPACE_KEY, JSON.stringify(normalized));
  return normalized;
}
