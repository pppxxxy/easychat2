// 自动备份设置的设置页编排（与 useWorkspaceSettings 同一套路）。
// 设置存 @easychat2_auto_backup；目标文件夹选择复用工作区的 SAF 目录选择器。
// 「立即备份」让用户当场验证文件夹与权限是否可用（不必等到期）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { useTranslation } from '../i18n/I18nContext.js';
import { normalizeAutoBackupSettings } from '../backup/autoBackupPolicy.js';
import { runAutoBackup } from '../backup/autoBackupRun.js';
import { getAutoBackupSettings, patchAutoBackupSettings } from '../storage/autoBackup.js';
import { pickDirectory } from '../workspace/picker.js';

export default function useAutoBackupSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(() => normalizeAutoBackupSettings(null));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // 异步操作（选文件夹 / 立即备份）回来时组件可能已卸载，setState 前先查这个 ref。
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    getAutoBackupSettings()
      .then(next => {
        if (!mountedRef.current) return;
        setSettings(next);
        setLoaded(true);
      })
      .catch(() => { if (mountedRef.current) setLoaded(true); });
  }, []);

  const patch = useCallback(async partial => {
    try {
      const saved = await patchAutoBackupSettings(partial);
      if (mountedRef.current) setSettings(saved);
      return saved;
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
      return null;
    }
  }, [t]);

  const setEnabled = useCallback(value => patch({ enabled: value === true }), [patch]);
  const setOnExit = useCallback(value => patch({ onExit: value === true }), [patch]);
  const setIntervalMs = useCallback(value => patch({ intervalMs: value }), [patch]);

  // 选文件夹：系统选择器（SAF）已带 takePersistableUriPermission，Android 重启后仍有效。
  // 取消不是错误，不提示；失败才提示。
  const chooseFolder = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await pickDirectory();
      if (!picked) return;
      await patch({ location: { kind: 'saf', uri: picked.uri, name: picked.name } });
    } catch (error) {
      Alert.alert(
        t('settings.autoBackup.folder.err.title'),
        (error && error.message) || t('settings.autoBackup.folder.err.body')
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, patch, t]);

  const resetFolder = useCallback(() => patch({ location: { kind: 'app', uri: '', name: '' } }), [patch]);

  // 立即备份：忽略总开关与到期判定，强制跑一次（便于当场验证）。跑完回读设置刷新「上次备份」。
  const runNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const current = await getAutoBackupSettings();
      const result = await runAutoBackup({ settings: { ...current, enabled: true }, now: Date.now() });
      if (result && result.ok) {
        Alert.alert(
          t('settings.autoBackup.run.done.title'),
          t('settings.autoBackup.run.done.body', { size: (Number(result.bytes || 0) / 1024 / 1024).toFixed(2) })
        );
      }
      if (mountedRef.current) setSettings(await getAutoBackupSettings());
    } catch (error) {
      Alert.alert(
        t('settings.autoBackup.run.fail.title'),
        (error && error.message) || t('settings.autoBackup.run.fail.body')
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, t]);

  return {
    autoBackupSettings: settings,
    autoBackupLoaded: loaded,
    autoBackupBusy: busy,
    setAutoBackupEnabled: setEnabled,
    setAutoBackupOnExit: setOnExit,
    setAutoBackupIntervalMs: setIntervalMs,
    chooseAutoBackupFolder: chooseFolder,
    resetAutoBackupFolder: resetFolder,
    runAutoBackupNow: runNow,
  };
}
