// 应用内公告的启动挂载点（任务书 6）：加载完成后静默拉一次最新 release，
// 命中「有新版本且未被『不再提示』」才弹。
//
// 为什么单独成文件而不是写在 App.js 里：App.js 已从行数基线移出、按 800 硬上限管，
// 富余不多；公告的这份接线（读版本、拉取、挂弹层、开浏览器）与 App 的启动编排无关，
// 放在 announcements 域里既省 App.js 的行，也让这一整套东西能一起被审。
//
// **失败静默**：公告不可用绝不能打扰用户，故这里不把任何错误变成 UI，
// 也不挡住启动流程——即使请求超时，聊天等主功能完全不受影响。
import React from 'react';
import { Linking } from 'react-native';

import { useApp } from '../context/AppContext.js';
import { APP_VERSION } from '../utils/appVersion.js';
import AnnouncementModal from './AnnouncementModal.js';
import useAnnouncement from './useAnnouncement.js';

export default function AnnouncementStartup() {
  const { loaded } = useApp();
  const { release, visible, close, dismissVersion } = useAnnouncement({
    localVersion: APP_VERSION,
    enabled: loaded,
  });
  if (!loaded) return null;
  return (
    <AnnouncementModal
      visible={visible}
      release={release}
      onClose={close}
      onDismissVersion={dismissVersion}
      // 链接只在用户**显式点按钮**时才打开（正文里的链接已文本化、不可点）。
      onOpenRelease={
        release && release.url ? () => { Linking.openURL(release.url).catch(() => {}); } : undefined
      }
    />
  );
}
