// 应用内公告的界面接线：启动时静默拉一次，命中「有新版本且未被忽略」才弹；
// 并把同一份缓存交给设置页「更新说明」入口随时打开。
//
// 设计要点（任务书 6）：
// - 静默：拉取失败一律不弹、不报错（公告不可用不能打扰用户），断网启动用缓存。
// - 不打扰：只在「远端版本 > 本地版本」且用户没对**这个版本**点过「不再提示」时才弹。
// - 复用：首启弹层与设置页入口共用同一份缓存与同一个 Modal 组件。
// - 只拉一次：设置页入口不重新联网（autoResolve:false 时只读缓存）——避免「进设置页
//   顺手又发一次 GitHub 请求」这种与用户意图无关的流量。
import { useCallback, useEffect, useRef, useState } from 'react';

import { resolveAnnouncement, readCachedRelease, setDismissedVersion } from './index.js';

// localVersion 由调用方从 expo-constants 取（本 hook 不碰 expo，保持 Node 可测）。
// autoResolve=true：挂载即静默拉取（启动路径用）。
// autoResolve=false：不联网，open() 时只读缓存（设置页入口用）。
export default function useAnnouncement({ localVersion = '', enabled = true, autoResolve = true } = {}) {
  const [release, setRelease] = useState(null);
  const [visible, setVisible] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !autoResolve) return undefined;
    // 只跑一次：启动拉取不是轮询。用 ref 而不是 state，避免重渲染重复请求。
    if (resolvedRef.current) return undefined;
    resolvedRef.current = true;
    let alive = true;
    resolveAnnouncement({ localVersion })
      .then(result => {
        if (!alive || !result || !result.release) return;
        setRelease(result.release);
        if (result.shouldShow) setVisible(true);
      })
      .catch(() => {
        // 公告是「锦上添花」：任何失败都静默，绝不弹错误、绝不影响启动。
      });
    return () => { alive = false; };
  }, [enabled, autoResolve, localVersion]);

  // 「不再提示此版本」：记住版本号（不是布尔），所以下次发新版还会再弹。
  const dismissVersion = useCallback(version => {
    setVisible(false);
    setDismissedVersion(version).catch(() => {});
  }, []);

  const close = useCallback(() => setVisible(false), []);

  // 设置页入口：没有 release 时先读缓存（可能已由启动路径写入），拿到就展示。
  const open = useCallback(() => {
    setVisible(true);
    if (release) return;
    readCachedRelease()
      .then(cached => { if (cached) setRelease(cached); })
      .catch(() => {});
  }, [release]);

  return {
    release,
    visible,
    close,
    open,
    dismissVersion,
    hasRelease: !!release,
  };
}
