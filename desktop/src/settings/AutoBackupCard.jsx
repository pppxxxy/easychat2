// 自动备份（桌面）：与手机 settings/sections/AutoBackupSection 同一套设置与执行器。
//
// 只做「应用私有目录」这一种目标：手机侧另有一条 SAF（系统文件夹选择器）路径，
// 那是 Android 的 content:// 授权模型；桌面已有「导出到文件」的另存为对话框（手动路径），
// 自动备份则固定写进 userData/documents/auto-backups/ —— 这里刻意不给文件夹选择，
// 因为桌面没有可长期持有的目录授权句柄（用户选的路径一旦失效，每次自动备份都会静默失败）。
//
// 执行复用共享层 backup/autoBackupRun.js 的 runAutoBackup：
//   · 到期判定、文件名、旧包淘汰都在 autoBackupPolicy.js（纯函数）；
//   · SAF 那一支完全不触发（location.kind 恒为 app）；
//   · 「退出时备份」在桌面映射为窗口关闭前跑一次（尽力而为，与手机的说明一致）。
import { useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  AUTO_BACKUP_INTERVAL_PRESET_HOURS,
  HOUR_MS,
  isAutoBackupDue,
  normalizeAutoBackupSettings,
} from '../../../src/backup/autoBackupPolicy.js';
import { createAutoBackupDeps, runAutoBackup } from '../../../src/backup/autoBackupRun.js';
import {
  getAutoBackupSettings,
  patchAutoBackupSettings,
  recordAutoBackupAt,
} from '../../../src/storage/autoBackup.js';
import { exportBackup } from '../../../src/storage/backup.js';
import { documentDirectory } from '../platform/fileSystem.js';
import * as FileSystem from '../platform/fileSystem.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { Button, Card, Row, Toggle } from './ui.jsx';

const POLL_MS = 15 * 60 * 1000;

function formatLastRun(at, t) {
  if (!at) return t('settings.autoBackup.never');
  try {
    return t('settings.autoBackup.last', {
      time: new Date(Number(at)).toLocaleString(),
    });
  } catch (error) {
    return t('settings.autoBackup.never');
  }
}

function formatInterval(intervalMs, t) {
  const hours = Math.round(Number(intervalMs) / HOUR_MS);
  if (!Number.isFinite(hours) || hours <= 0) return t('settings.autoBackup.interval.day');
  if (hours === 24) return t('settings.autoBackup.interval.day');
  if (hours % 24 === 0) return t('settings.autoBackup.interval.days', { count: hours / 24 });
  return t('settings.autoBackup.interval.hours', { count: hours });
}

export default function AutoBackupCard({ palette, fonts, appVersion = '' }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const settingsRef = useRef(null);
  settingsRef.current = settings;
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getAutoBackupSettings()
      .then(value => { if (!cancelled) setSettings(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 共享层的依赖装配：只给 application-private 目录那一支需要的成员。
  const deps = () => {
    const legacyFs = FileSystem;
    return createAutoBackupDeps({
      exportBackup,
      getSettings: getAutoBackupSettings,
      recordLastBackupAt: recordAutoBackupAt,
      fileSystem: legacyFs,
      // 桌面没有 nextFs（FileHandle）与 SAF 适配器：autoBackupRun 在非 SAF 模式下
      // 完全不碰它们，传 null 即可（它的各个分支都有 null 守卫）。
      nextFs: null,
      adapter: null,
    });
  };

  const runNow = async (silent = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const current = settingsRef.current || await getAutoBackupSettings();
      const result = await runAutoBackup({
        settings: { ...current, enabled: true },
        deps: deps(),
        appVersion,
      });
      // 记录时间由 runAutoBackup 内部完成（recordLastBackupAt），这里只刷新界面。
      const refreshed = await getAutoBackupSettings();
      setSettings(refreshed);
      if (typeof globalThis !== 'undefined') globalThis.__easychat2AutoBackupResult = { bytes: result.bytes, uri: result.uri };
      if (!silent) {
        Alert.alert(
          t('settings.autoBackup.run.done.title'),
          t('settings.autoBackup.run.done.body', {
            size: Math.max(1, Math.round(Number(result.bytes || 0) / (1024 * 1024))),
          })
        );
      }
    } catch (error) {
      // 冒烟/排查用：记录最后一次失败原因（不改变产品行为，界面仍只给通用文案）。
      if (typeof globalThis !== 'undefined') {
        globalThis.__easychat2AutoBackupError = String((error && error.message) || error);
      }
      if (!silent) {
        Alert.alert(t('settings.autoBackup.run.fail.title'), t('settings.autoBackup.run.fail.body'));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // 到期轮询：桌面没有 AppState，用 setInterval 就够了（窗口开着才需要备份）。
  useEffect(() => {
    if (!settings || settings.enabled !== true) return undefined;
    const tick = () => {
      const current = settingsRef.current;
      if (!current || current.enabled !== true) return;
      // 到期判定用共享层唯一口径（isAutoBackupDue），不在这里重算。
      if (isAutoBackupDue(current)) runNow(true);
    };
    const timer = setInterval(tick, POLL_MS);
    // 打开设置页时先查一次（冷启动那次已经错过窗口）。
    tick();
    return () => clearInterval(timer);
  }, [settings && settings.enabled, settings && settings.intervalMs]);

  const patch = async value => {
    try {
      const saved = await patchAutoBackupSettings(value);
      setSettings(saved);
    } catch (error) {
      Alert.alert(t('settings.autoBackup.run.fail.title'), t('settings.autoBackup.run.fail.body'));
    }
  };

  const normalized = normalizeAutoBackupSettings(settings);

  return (
    <Card title={t('settings.autoBackup.title')} hint={t('settings.autoBackup.enableHint')} palette={palette} fonts={fonts}>
      {!settings ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : (
        <>
          <Toggle
            checked={normalized.enabled}
            onChange={value => patch({ enabled: value })}
            label={t('settings.autoBackup.enable')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={normalized.onExit === true}
            onChange={value => patch({ onExit: value })}
            label={t('settings.autoBackup.onExit')}
            palette={palette}
            fonts={fonts}
          />
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('desktop.autoBackup.hint')}
          </div>

          <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>
            {t('settings.autoBackup.interval')}: {formatInterval(normalized.intervalMs, t)}
          </div>
          <Row>
            {AUTO_BACKUP_INTERVAL_PRESET_HOURS.map(hours => {
              const active = Math.round(normalized.intervalMs / HOUR_MS) === hours;
              return (
                <Button
                  key={hours}
                  label={formatInterval(hours * HOUR_MS, t)}
                  onClick={() => patch({ intervalMs: hours * HOUR_MS })}
                  palette={palette}
                  fonts={fonts}
                  primary={active}
                />
              );
            })}
          </Row>

          <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
            {t('settings.autoBackup.folder')}: {t('settings.autoBackup.folder.app')}
            {' · '}
            {documentDirectory}auto-backups/
          </div>
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {formatLastRun(normalized.lastBackupAt, t)}
          </div>

          <Row>
            <Button
              label={busy ? t('backup.progress.ratio') : t('settings.autoBackup.run')}
              onClick={() => runNow(false)}
              palette={palette}
              fonts={fonts}
              primary
              disabled={busy}
            />
            <Button
              label={t('settings.autoBackup.folder.choose')}
              onClick={() => {
                // 打开自动备份目录（用户在文件管理器里自己取走包）。
                Promise.resolve(getBridge().dialog.reveal(`${documentDirectory}auto-backups/`)).catch(() => {});
              }}
              palette={palette}
              fonts={fonts}
            />
          </Row>
        </>
      )}
    </Card>
  );
}