import { createRoot } from 'react-dom/client';

// 顺序敏感：polyfills 必须先于任何共享层模块执行（Buffer / XMLHttpRequest）。
import './polyfills.js';
import './styles/render.css';
import { getBridge } from './platform/bridge.js';
import { installDesktopArtworkLoader } from './platform/artwork.js';
import DesktopApp from './provider/DesktopApp.jsx';
import OverlayApp from './overlay/OverlayApp.jsx';
import { I18nProvider } from '../../src/i18n/I18nContext.js';

// 渲染前注入桌面素材实现（主进程已把打包资源复制到 documents/avatars/）。
installDesktopArtworkLoader(getBridge());

// 同一个 bundle 服务两个窗口：主窗口渲染完整应用，悬浮窗（#overlay）只渲染小窗。
// 用 hash 分流而不是再打一份前端产物——悬浮窗只有 168×200，没必要为它多一次构建。
const isOverlay = String(window.location.hash || '') === '#overlay';

const root = createRoot(document.getElementById('root'));
root.render(
  isOverlay
    ? <I18nProvider><OverlayApp /></I18nProvider>
    : <DesktopApp />
);
