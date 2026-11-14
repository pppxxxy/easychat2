// 悬浮球头像设置（桌面）：对应手机 screenWatch/AvatarCard.js。
//
// 三档（与手机同一份共享存储 storage/settings/overlayAvatar.js）：
//   default   默认（手机上画 App 图标，桌面用内置助手头像）
//   character 跟随当前角色头像
//   custom    自定义图片
// 选图后复制到 documents/overlay-avatar/ 并登记媒体保护（与聊天图片同一套），
// 悬浮窗下次读设置时自动生效——不需要重启窗口。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  OVERLAY_AVATAR_MODES,
  getOverlayAvatarSettings,
  saveOverlayAvatarSettings,
} from '../../../../src/storage/settings/overlayAvatar.js';
import { markMediaWrite } from '../../../../src/storage/mediaProtection.js';
import { Button, Card } from '../../settings/ui.jsx';
import { Alert } from '../../platform/alert.js';
import { getBridge } from '../../platform/bridge.js';
import { mediaUrl } from '../../platform/mediaUrl.js';

export default function OverlayAvatarCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getOverlayAvatarSettings()
      .then(value => { if (alive) setSettings(value); })
      .catch(() => { if (alive) setSettings({ mode: 'default', customUri: '' }); });
    return () => { alive = false; };
  }, []);

  const persist = useCallback(async patch => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await saveOverlayAvatarSettings({ ...(settings || {}), ...patch });
      setSettings(next);
    } catch (error) {
      Alert.alert(t('common.error.storageOrPermission'));
    } finally {
      setBusy(false);
    }
  }, [busy, settings, t]);

  const pick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const bridge = getBridge();
      const result = await bridge.media.pick('image');
      const item = result && !result.canceled && Array.isArray(result.items) ? result.items[0] : null;
      if (!item) return;
      const dir = `${bridge.app.paths.documentDirectory}overlay-avatar/`;
      const ext = String(item.uri || '').split('.').pop() || 'png';
      const dest = `${dir}avatar-${Date.now()}.${ext}`;
      await bridge.fs.mkdir(dir, true).catch(() => {});
      await bridge.fs.copy(item.uri, dest);
      // 先登记再引用：堵住「落盘与登记之间被回收器误删」的窗口。
      markMediaWrite(dest);
      await persist({ mode: 'custom', customUri: dest });
    } catch (error) {
      Alert.alert(t('screenWatch.avatar.pickFailed.title'), t('screenWatch.avatar.pickFailed.body'));
    } finally {
      setBusy(false);
    }
  }, [busy, persist, t]);

  const mode = settings ? String(settings.mode || 'default') : '';
  const customPreview = settings && settings.customUri ? mediaUrl(settings.customUri) : '';

  return (
    <Card title={t('screenWatch.avatar.title')} hint={t('screenWatch.avatar.hint')} palette={palette} fonts={fonts}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {OVERLAY_AVATAR_MODES.map(value => (
          <Button
            key={value}
            label={t(`screenWatch.avatar.mode.${value}`)}
            onClick={() => persist({ mode: value })}
            palette={palette}
            fonts={fonts}
            primary={mode === value}
            disabled={busy || !settings}
          />
        ))}
        <Button
          label={t('screenWatch.avatar.pick')}
          onClick={pick}
          palette={palette}
          fonts={fonts}
          disabled={busy}
        />
        {mode === 'custom' && customPreview ? (
          <img
            src={customPreview}
            alt=""
            style={{ width: 28, height: 28, borderRadius: 14, objectFit: 'cover' }}
          />
        ) : null}
      </div>
    </Card>
  );
}