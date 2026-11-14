// 悬浮窗界面（桌面）：只渲染在 168×200 的置顶小窗里（main.jsx 按 URL hash 分流）。
//
// 对应手机悬浮球：一个能浮在别的应用之上的角色头像。点它 → 截当前整屏 →
// 让角色对着屏幕说一句 → 评论显示在头像下面。
//
// 与「看屏幕」页共用同一套判定（src/screenWatch/useScreenWatchComments.js）：
// 视觉门控、OCR/直看来源、提示词、落库、重试全在那里；本文件只做小窗 UI。
// 这也是为什么这个组件能这么薄——没有一行重复的业务逻辑。
//
// 窗口特性（见 electron/ipc/overlay.js）：无边框、透明、置顶、不进任务栏。
// 拖动靠 CSS 的 -webkit-app-region: drag（Electron 的窗口拖动约定）。
import { useCallback, useEffect, useState } from 'react';

import { getActiveCharacterId, getCharacterLibrary } from '../../../src/storage/characters.js';
import { getOverlayAvatarSettings } from '../../../src/storage/settings/overlayAvatar.js';
import { useScreenWatchComments } from '../../../src/screenWatch/useScreenWatchComments.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { getBridge } from '../platform/bridge.js';
import { mediaUrl } from '../platform/mediaUrl.js';

export default function OverlayApp() {
  const { t } = useTranslation();
  const [characters, setCharacters] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState('');
  const [failed, setFailed] = useState('');
  // 悬浮球头像三档（与手机同一份存储）：默认图标 / 跟随当前角色 / 自定义图片。
  const [avatarSettings, setAvatarSettings] = useState({ mode: 'default', customUri: '' });

  const comments = useScreenWatchComments({ characters, defaultCharacterId: activeId });

  useEffect(() => {
    let alive = true;
    Promise.all([
      getCharacterLibrary().catch(() => []),
      getActiveCharacterId().catch(() => ''),
      getOverlayAvatarSettings().catch(() => null),
    ]).then(([list, id, avatar]) => {
      if (!alive) return;
      setCharacters(Array.isArray(list) ? list : []);
      setActiveId(String(id || ''));
      if (avatar) setAvatarSettings(avatar);
    });
    return () => { alive = false; };
  }, []);

  const character = characters.find(item => item.id === activeId) || characters[0] || null;

  // 点一下头像：截整屏 → 生成评论 → 显示最新一句。
  const capture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailed('');
    try {
      const bridge = getBridge();
      const shot = await bridge.capture.screen();
      if (!shot || shot.ok !== true || !shot.uri) {
        setFailed(t('desktop.overlay.captureFailed'));
        return;
      }
      const result = await comments.generate({ imageUri: shot.uri });
      // generate 返回落库的评论对象（失败时抛错或返回 null，取决于共享层实现）。
      const text = result && typeof result === 'object' ? String(result.text || '') : '';
      if (text) setLatest(text);
      else if (comments.lastErrorRef && comments.lastErrorRef.current) {
        setFailed(String(comments.lastErrorRef.current));
      }
    } catch (error) {
      setFailed(String((error && error.message) || t('desktop.overlay.captureFailed')));
    } finally {
      setBusy(false);
    }
  }, [busy, comments, t]);

  const close = useCallback(() => {
    getBridge().overlay.stop().catch(() => {});
  }, []);

  // 三档头像（共享存储 overlayAvatar）：
  //   default   → 内置助手头像（手机上是 App 图标，桌面没有图标文件，用助手头像代替）
  //   character → 当前角色头像
  //   custom    → 用户选的图
  const avatar = avatarSettings.mode === 'character'
    ? (character && character.avatarUri ? mediaUrl(character.avatarUri) : '')
    : (avatarSettings.mode === 'custom'
      ? mediaUrl(avatarSettings.customUri)
      : mediaUrl(`${getBridge().app.paths.documentDirectory}avatars/default-assistant-avatar.jpg`));
  const initial = String((character && character.name) || '?').slice(0, 1);

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6,
      padding: 8,
      boxSizing: 'border-box',
      background: 'rgba(17,19,26,0.86)',
      borderRadius: 16,
      color: '#e8e8f0',
      fontFamily: 'system-ui, sans-serif',
      // 整个窗口可拖动；按钮单独声明 no-drag（否则点不动）。
      WebkitAppRegion: 'drag',
      userSelect: 'none',
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 4 }}>
        <span style={{ fontSize: 10, color: '#8a8fa8', flex: 1 }}>
          {String((character && character.name) || '')}
        </span>
        <button
          type="button"
          onClick={close}
          aria-label={t('common.close')}
          style={{
            width: 16, height: 16, lineHeight: '14px', padding: 0,
            border: 'none', borderRadius: 8, cursor: 'pointer',
            background: 'rgba(255,255,255,0.12)', color: '#c8c8d8', fontSize: 11,
            WebkitAppRegion: 'no-drag',
          }}
        >
          ×
        </button>
      </div>

      <button
        type="button"
        onClick={capture}
        disabled={busy || !character}
        aria-label={t('desktop.overlay.capture')}
        style={{
          width: 72, height: 72, padding: 0, borderRadius: 36, overflow: 'hidden',
          border: '2px solid rgba(150,150,255,0.55)', cursor: busy ? 'default' : 'pointer',
          background: '#2d2d44', color: '#e8e8f0', fontSize: 26,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          WebkitAppRegion: 'no-drag',
        }}
      >
        {avatar
          ? <img src={avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : initial}
      </button>

      <div style={{
        fontSize: 10,
        lineHeight: 1.5,
        color: busy ? '#9aa0c0' : (failed ? '#ff8a8a' : '#b8bcd4'),
        textAlign: 'center',
        maxHeight: 58,
        overflow: 'hidden',
        width: '100%',
      }}
      >
        {busy ? t('desktop.overlay.busy') : (failed || latest || t('desktop.overlay.hint'))}
      </div>
    </div>
  );
}