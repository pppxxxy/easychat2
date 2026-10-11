// 自动备份设置的存储域：总开关、间隔、切后台备份开关、目标文件夹、上次备份时间。
// 与工作区设置同一套路（单键 + 局部 patch），归一化在 backup/autoBackupPolicy.js（纯函数）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeAutoBackupSettings } from '../backup/autoBackupPolicy.js';
import { readJson } from './io.js';

export const AUTO_BACKUP_KEY = '@easychat2_auto_backup';

export async function getAutoBackupSettings() {
  const raw = await readJson(AUTO_BACKUP_KEY, null);
  return normalizeAutoBackupSettings(raw);
}

export async function saveAutoBackupSettings(settings) {
  const normalized = normalizeAutoBackupSettings({
    ...(settings && typeof settings === 'object' ? settings : {}),
    updatedAt: Date.now(),
  });
  await AsyncStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(normalized));
  return normalized;
}

// 局部更新：读现值 → 合并补丁 → 归一化写回。理由同 patchWorkspaceSettings——
// 本键同时承载开关/间隔/文件夹/上次时间，由不同界面分别修改；若各自整体 save，
// 归一化会把其余字段打回默认（表现为「改一下间隔，选好的文件夹就没了」）。
export async function patchAutoBackupSettings(patch) {
  const current = await getAutoBackupSettings();
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const normalized = normalizeAutoBackupSettings({ ...merged, updatedAt: Date.now() });
  await AsyncStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(normalized));
  return normalized;
}

// 记录一次成功备份的时间（到期判定的依据）。失败不阻断调用方——下次到期判定会再试。
export function recordAutoBackupAt(at = Date.now()) {
  return patchAutoBackupSettings({ lastBackupAt: Math.floor(Number(at)) || Date.now() });
}
