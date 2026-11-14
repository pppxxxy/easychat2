// 应用级前台调度（桌面）：把「主动消息」与「自动备份」两套到点任务挂到应用根。
//
// 为什么必须挂在根而不是各自的页面里：
//   手机侧两套调度都在 App 启动时装好（App.js 顶层），**与用户当前在哪一页无关**。
//   桌面此前把主动消息的调度写在 ProactiveScreen 内部——只有打开那个页面才会跑，
//   关掉页面就停。那是实打实的功能差距：用户设了「每天 9 点」，却必须当天打开过
//   主动消息页才会收到。这里统一挂到 Shell（应用根），恢复手机的行为。
//
// 分工与手机一致：
//   · 主动消息：proactive/useProactiveForeground（每分钟轮询到期槽）；
//   · 自动备份：settings/useDesktopAutoBackupScheduler（15 分钟轮询 + 隐藏时退出备份）。
// 两者都只在**窗口开着**时生效，界面文案已如实说明。
import { useEffect, useRef, useState } from 'react';

import { getAutoBackupSettings } from '../../../src/storage/autoBackup.js';
import { getProactiveSettings } from '../../../src/storage/moments.js';
import { tActive } from '../../../src/i18n/index.js';
import useProactiveForeground from '../proactive/useProactiveForeground.js';
import useDesktopAutoBackupScheduler from '../settings/useDesktopAutoBackupScheduler.js';
import { createDesktopAutoBackupDeps } from '../settings/desktopAutoBackupDeps.js';
import { getBridge } from '../platform/bridge.js';

export default function useDesktopBackgroundTasks({ ready, charactersRef, appVersion = '' }) {
  const [proactiveEnabled, setProactiveEnabled] = useState(false);
  const [backupEnabled, setBackupEnabled] = useState(false);

  // 读两个开关：只在 ready 之后读一次（首启门禁没过时不该开始轮询）。
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const settings = await getProactiveSettings();
        if (!cancelled) setProactiveEnabled(Boolean(settings && settings.enabled !== false));
      } catch (error) {
        if (!cancelled) setProactiveEnabled(false);
      }
      try {
        const backup = await getAutoBackupSettings();
        if (!cancelled) setBackupEnabled(Boolean(backup && backup.enabled === true));
      } catch (error) {
        if (!cancelled) setBackupEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ready]);

  useProactiveForeground({ enabled: ready && proactiveEnabled, charactersRef });

  const appVersionRef = useRef(appVersion);
  appVersionRef.current = appVersion;
  useDesktopAutoBackupScheduler({
    enabled: ready && backupEnabled,
    deps: createDesktopAutoBackupDeps,
    onResult: result => {
      // 备份完成后通知一次（成功才提醒，不打断正在做的事）。
      // 文案复用设置页的既有词条：tActive 用于非组件语境（与共享层同一入口）。
      const bridge = getBridge();
      if (!bridge || !bridge.notify) return;
      const mb = Math.max(1, Math.round(Number((result && result.bytes) || 0) / (1024 * 1024)));
      bridge.notify.show({
        title: tActive('settings.autoBackup.run.done.title'),
        body: tActive('settings.autoBackup.run.done.body', { size: mb }),
      }).catch(() => {});
    },
  });

  return { proactiveEnabled, backupEnabled };
}