import { createRoot } from 'react-dom/client';

// 顺序敏感：polyfills 必须先于任何共享层模块执行（Buffer / XMLHttpRequest）。
import './polyfills.js';
import './styles/render.css';
import { getBridge } from './platform/bridge.js';
import { installDesktopArtworkLoader } from './platform/artwork.js';
import DesktopApp from './provider/DesktopApp.jsx';

// 渲染前注入桌面素材实现（主进程已把打包资源复制到 documents/avatars/）。
installDesktopArtworkLoader(getBridge());

createRoot(document.getElementById('root')).render(<DesktopApp />);
