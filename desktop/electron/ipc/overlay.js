// 悬浮窗（桌面）：把手机「跨应用看屏」搬到桌面。
//
// 手机上这需要 SYSTEM_ALERT_WINDOW（在其他应用之上画自己的界面）+ MediaProjection
// （逐会话授权的跨应用截屏）。桌面上两件事都有对应物，而且更简单：
//   · 置顶自绘窗口 = BrowserWindow({ alwaysOnTop, transparent, frame:false, skipTaskbar });
//   · 整屏截图     = desktopCapturer.getSources({ types:['screen'] })（见 ipc/capture.js）。
// 所以「悬浮窗」不是平台不可移植，而是此前没做（S39 补上）。
//
// 窗口刻意做得很小（头像 + 一个按钮 + 最新一句评论）：它要长时间浮在别的应用上，
// 面积越大越干扰；可能的交互全部收在一个圆形按钮上。
//
// 本模块只管窗口生命周期与 IPC，界面在 src/overlay/OverlayApp.jsx（同一个 bundle，
// 用 URL hash #overlay 区分入口——避免为一个小窗再打一份前端产物）。
import path from 'node:path';

export const OVERLAY_WIDTH = 168;
export const OVERLAY_HEIGHT = 200;

export function registerOverlayIpc(ipcMain, {
  BrowserWindow,
  getDevServerUrl = () => '',
  getDocumentsRoot = () => '',
} = {}) {
  let overlayWindow = null;

  const isAlive = () => !!(overlayWindow && !overlayWindow.isDestroyed());

  function create() {
    if (isAlive()) return { ok: true, alreadyOpen: true };
    const devServerUrl = String(getDevServerUrl() || '');
    overlayWindow = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      // 置顶 + 无边框 + 透明：这三项合起来就是「悬浮球」的桌面形态。
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      hasShadow: false,
      // 不抢焦点：点它的时候不该把用户正在用的应用切走。
      focusable: true,
      show: false,
      webPreferences: {
        preload: path.join(import.meta.dirname || __dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        // 悬浮窗不参与后台节流：它是被用户「一直看着」的窗口，节流会让评论停止更新。
        backgroundThrottling: false,
      },
    });
    // 置顶层级用 screen-saver：普通 floating 会被部分全屏应用盖住。
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    // 出现在所有工作区（Windows 上等价于「总在最前」）。
    if (typeof overlayWindow.setVisibleOnAllWorkspaces === 'function') {
      overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    overlayWindow.once('ready-to-show', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.showInactive();
    });
    if (devServerUrl) {
      overlayWindow.loadURL(`${devServerUrl}#overlay`);
    } else {
      overlayWindow.loadFile(path.join(import.meta.dirname || __dirname, '..', 'dist', 'index.html'), {
        hash: 'overlay',
      });
    }
    overlayWindow.on('closed', () => { overlayWindow = null; });
    const documentsRoot = String(getDocumentsRoot() || '');
    void documentsRoot;
    return { ok: true };
  }

  function destroy() {
    if (!isAlive()) return { ok: true, alreadyClosed: true };
    overlayWindow.destroy();
    overlayWindow = null;
    return { ok: true };
  }

  ipcMain.handle('overlay:start', async () => {
    try {
      return create();
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });
  ipcMain.handle('overlay:stop', async () => destroy());
  ipcMain.handle('overlay:state', async () => ({ ok: true, open: isAlive() }));

  return {
    close: () => destroy(),
    isOpen: isAlive,
  };
}
