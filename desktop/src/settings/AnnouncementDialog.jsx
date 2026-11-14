// 应用内公告 / 更新说明（桌面）：对应手机 announcements/AnnouncementModal.js +
// useAnnouncement.js。
//
// 全部判定与网络都在共享层，桌面只做 DOM 呈现：
//   · resolveAnnouncement()  拉最新 release（失败回落缓存）→ 与本地版本比对 →
//                            看用户是否对这个版本点过「不再提示」；任何一环失败都
//                            返回 shouldShow:false 而不抛错（公告不可用不能打扰用户）。
//   · readCachedRelease()    设置页入口只读缓存，**不联网**——避免「进设置页顺手
//                            又发一次 GitHub 请求」这种与用户意图无关的流量。
//   · setDismissedVersion()  记住「这个版本不再提示」。
//
// 手机那版靠 expo-constants 取本地版本；桌面由主进程 app.getVersion() 传进来。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  readCachedRelease,
  resolveAnnouncement,
  setDismissedVersion,
} from '../../../src/announcements/index.js';
import { markdownToPlainText } from '../../../src/announcements/release.js';
import { Alert } from '../platform/alert.js';
import { Button } from './ui.jsx';

// 启动路径：挂载即静默拉一次；命中才弹。与手机 useAnnouncement(autoResolve:true) 同语义。
export function useStartupAnnouncement({ localVersion = '' } = {}) {
  const [release, setRelease] = useState(null);
  const [visible, setVisible] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    // localVersion 为空时不做判断：没有版本号就无法比「远端 > 本地」，
    // 此时弹出来只会是误报（例如开发环境）。
    if (!localVersion || resolvedRef.current) return undefined;
    resolvedRef.current = true;
    let alive = true;
    resolveAnnouncement({ localVersion })
      .then(result => {
        if (!alive || !result || !result.release) return;
        setRelease(result.release);
        if (result.shouldShow) setVisible(true);
      })
      .catch(() => {
        // 公告拉不到是常态（断网/限流），不打扰用户。
      });
    return () => { alive = false; };
  }, [localVersion]);

  return { release, visible, close: () => setVisible(false) };
}

// 设置页入口：只读缓存，不联网。
export function useCachedAnnouncement() {
  const [release, setRelease] = useState(null);
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    readCachedRelease()
      .then(value => setRelease(value || null))
      .catch(() => {});
  }, []);
  return release;
}

export default function AnnouncementDialog({
  release,
  open,
  onClose,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  const dismiss = useCallback(async () => {
    const version = release && release.version ? String(release.version) : '';
    if (version) {
      // 忽略失败不阻断关闭：用户点了「不再提示」，界面就该关。
      await setDismissedVersion(version).catch(() => {});
    }
    onClose();
  }, [release, onClose]);

  if (!open || !release) return null;

  // body 是外部输入（GitHub release 的 markdown）：走共享 markdownToPlainText 去符号，
  // 不做富渲染——与手机同一口径，也避免把远端 HTML 直接塞进 DOM。
  const body = markdownToPlainText(String(release.body || ''));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('announcement.title')}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 60,
      }}
    >
      <div style={{
        width: 'min(560px, 100%)',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        background: palette.surface,
        color: palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 14,
        padding: 18,
        gap: 10,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: fonts.scaled(14) }}>{t('announcement.title')}</strong>
          {release.version ? (
            <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
              {String(release.version)}
            </span>
          ) : null}
        </div>
        <div style={{
          flex: 1,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          fontSize: fonts.scaled(12),
          lineHeight: 1.7,
          color: palette.textMuted,
        }}
        >
          {body || t('announcement.emptyBody')}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {release.url ? (
            <Button
              label={t('announcement.openRelease')}
              onClick={() => {
                // 外链交系统浏览器打开；失败给一句提示，不静默。
                const bridge = globalThis.easychat2;
                if (bridge && bridge.app && typeof bridge.app.openExternal === 'function') {
                  bridge.app.openExternal(String(release.url)).catch(() => {
                    Alert.alert(t('common.error.retryLater'));
                  });
                }
              }}
              palette={palette}
              fonts={fonts}
            />
          ) : null}
          <Button
            label={t('announcement.doNotShowAgain')}
            onClick={dismiss}
            palette={palette}
            fonts={fonts}
          />
          <Button
            label={t('common.confirm')}
            onClick={onClose}
            palette={palette}
            fonts={fonts}
          />
        </div>
      </div>
    </div>
  );
}
