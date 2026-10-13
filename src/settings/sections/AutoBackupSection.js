import React, { useEffect, useState } from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import CollapsibleHint from '../CollapsibleHint.js';
import { TextField } from '../../ui/index.js';
import {
  AUTO_BACKUP_INTERVAL_PRESET_HOURS,
  AUTO_BACKUP_LOCATION_KINDS,
  DAY_MS,
  HOUR_MS,
  matchIntervalPresetHours,
  normalizeAutoBackupSettings,
} from '../../backup/autoBackupPolicy.js';

// 预设档位的显示名：整天用「每天 / 每 N 天」，其余用「每 N 小时」。
function presetLabel(hours, t) {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1
      ? t('settings.autoBackup.interval.day')
      : t('settings.autoBackup.interval.days', { count: days });
  }
  return t('settings.autoBackup.interval.hours', { count: hours });
}

function formatLastBackup(at, t) {
  if (!at) return t('settings.autoBackup.never');
  let time = String(at);
  try { time = new Date(at).toLocaleString(); } catch (error) {}
  return t('settings.autoBackup.last', { time });
}

// 设置页「自动备份」卡：总开关 + 间隔（预设/自定义天数）+ 退出时备份 + 目标文件夹 + 立即备份。
// 状态与保存逻辑在 useAutoBackupSettings（SettingsScreen 持有），本卡只做展示与回调转发。
export default function AutoBackupSection(props) {
  const {
    styles,
    theme,
    t,
    autoBackupSettings,
    autoBackupLoaded,
    autoBackupBusy,
    setAutoBackupEnabled,
    setAutoBackupOnExit,
    setAutoBackupIntervalMs,
    chooseAutoBackupFolder,
    resetAutoBackupFolder,
    runAutoBackupNow,
  } = props;

  const settings = normalizeAutoBackupSettings(autoBackupSettings);
  const activePreset = matchIntervalPresetHours(settings.intervalMs);
  const isCustom = activePreset === null;
  const isSaf = settings.location.kind === AUTO_BACKUP_LOCATION_KINDS.SAF;

  // 自定义天数输入：受 settings 驱动初值，编辑期间用本地草稿，失焦/提交时才落盘。
  const [daysDraft, setDaysDraft] = useState('1');
  useEffect(() => {
    setDaysDraft(String(Math.max(1, Math.round(settings.intervalMs / DAY_MS))));
  }, [settings.intervalMs]);

  const commitDays = () => {
    const n = Math.floor(Number(daysDraft));
    if (!Number.isFinite(n) || n < 1) {
      setDaysDraft(String(Math.max(1, Math.round(settings.intervalMs / DAY_MS))));
      return;
    }
    setAutoBackupIntervalMs(n * DAY_MS);
  };

  return (
    <>
      <View style={styles.capabilityRow}>
        <View style={styles.linkLeft}>
          <Ionicons name="save-outline" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.linkText}>{t('settings.autoBackup.enable')}</Text>
        </View>
        <Switch
          value={settings.enabled}
          onValueChange={setAutoBackupEnabled}
          disabled={!autoBackupLoaded}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      <CollapsibleHint>{t('settings.autoBackup.enableHint')}</CollapsibleHint>

      {settings.enabled ? (
        <>
          <Text style={styles.label}>{t('settings.autoBackup.interval')}</Text>
          <View style={styles.fontRow}>
            {AUTO_BACKUP_INTERVAL_PRESET_HOURS.map(hours => {
              const active = activePreset === hours;
              return (
                <TouchableOpacity
                  key={hours}
                  style={[styles.fontChip, active && styles.fontChipActive]}
                  onPress={() => setAutoBackupIntervalMs(hours * HOUR_MS)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                    {presetLabel(hours, t)}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.fontChip, isCustom && styles.fontChipActive]}
              onPress={() => { if (!isCustom) setAutoBackupIntervalMs(2 * DAY_MS); }}
              activeOpacity={0.8}
            >
              <Text style={[styles.fontChipText, isCustom && styles.fontChipTextActive]}>
                {t('settings.autoBackup.interval.custom')}
              </Text>
            </TouchableOpacity>
          </View>
          {isCustom ? (
            <View style={styles.autoBackupCustomRow}>
              <TextField
                style={styles.autoBackupDaysInput}
                value={daysDraft}
                onChangeText={setDaysDraft}
                onEndEditing={commitDays}
                onSubmitEditing={commitDays}
                keyboardType="number-pad"
                maxLength={3}
                accessibilityLabel={t('settings.autoBackup.interval.customLabel')}
              />
              <Text style={styles.autoBackupUnit}>{t('settings.autoBackup.interval.customUnit')}</Text>
            </View>
          ) : null}

          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="exit-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.autoBackup.onExit')}</Text>
            </View>
            <Switch
              value={settings.onExit}
              onValueChange={setAutoBackupOnExit}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>{t('settings.autoBackup.onExitHint')}</CollapsibleHint>
        </>
      ) : null}

      <Text style={styles.label}>{t('settings.autoBackup.folder')}</Text>
      <View style={styles.capabilityRow}>
        <View style={styles.linkLeft}>
          <Ionicons
            name={isSaf ? 'folder-open-outline' : 'phone-portrait-outline'}
            size={17}
            color={theme.colors.primaryMuted}
          />
          <Text style={styles.linkText} numberOfLines={1}>
            {isSaf ? (settings.location.name || t('settings.autoBackup.folder.saf')) : t('settings.autoBackup.folder.app')}
          </Text>
        </View>
        <View style={styles.linkRight}>
          <TouchableOpacity
            style={styles.smallButton}
            onPress={chooseAutoBackupFolder}
            disabled={autoBackupBusy}
            activeOpacity={0.8}
          >
            <Text style={styles.smallButtonText}>
              {isSaf ? t('settings.autoBackup.folder.change') : t('settings.autoBackup.folder.choose')}
            </Text>
          </TouchableOpacity>
          {isSaf ? (
            <TouchableOpacity style={styles.smallButton} onPress={resetAutoBackupFolder} activeOpacity={0.8}>
              <Text style={styles.smallButtonText}>{t('settings.autoBackup.folder.reset')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
      <CollapsibleHint>{t('settings.autoBackup.folder.hint')}</CollapsibleHint>

      <TouchableOpacity
        style={[styles.detectButton, autoBackupBusy && styles.buttonDisabled]}
        onPress={runAutoBackupNow}
        disabled={autoBackupBusy}
        activeOpacity={0.8}
      >
        <Ionicons name="cloud-upload-outline" size={16} color={theme.colors.accentText} />
        <Text style={styles.detectButtonText}>{t('settings.autoBackup.run')}</Text>
      </TouchableOpacity>
      <Text style={styles.fieldHint}>{formatLastBackup(settings.lastBackupAt, t)}</Text>
    </>
  );
}
