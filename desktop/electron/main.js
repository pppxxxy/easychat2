// Electron 主进程（design.md「Architecture」）。
//
// 持有全部系统能力：窗口、键值仓、文件、密钥、流式 HTTP、媒体协议、对话框。
// 渲染进程零 Node：一切能力经 preload 的 contextBridge 白名单进入
// （contextIsolation/sandbox 开启，nodeIntegration 关闭）。
//
// 依赖形状刻意保持「服务工厂 + register*」两段式：ipc/*.js 全部零 Electron 依赖，
// 适配层行为测试在 Node 里直接实例化同一份服务（见 desktop/tests/）。
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, session, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKvStore, registerKvIpc } from './ipc/kv.js';
import { createFsService, registerFsIpc } from './ipc/fs.js';
import { createSecretStore, registerSecretIpc } from './ipc/secret.js';
import { createHttpProxy, registerHttpIpc } from './ipc/http.js';
import { createMediaHandler } from './ipc/media.js';
import { registerDialogIpc } from './ipc/dialog.js';
import { toFileUrl } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_SCHEME = 'easychat2-media';

// 冒烟模式（npm run smoke）：在真实 Electron 运行时验证 renderer -> preload -> main
// 全链路，并把窗口截图写到 <userData>/smoke.png。仅由环境变量开启，不影响正常启动。
const SMOKE = process.env.EASYCHAT2_DESKTOP_SMOKE === '1';
const SMOKE_PROBE = readFileSync(path.join(__dirname, 'smoke-probe.js'), 'utf8');

// 数据目录名固定为 EasyChat2（不随 package.json name 变化）：文档目录是跨版本
// 稳定契约（design.md Requirement 1.4），改名会让老数据“消失”。
app.setName('EasyChat2');

let mainWindow = null;
let fsService = null;
let httpProxy = null;

function userPaths() {
  const userData = app.getPath('userData');
  const documentsRoot = path.join(userData, 'documents');
  const cacheRoot = path.join(userData, 'cache');
  return {
    userData,
    documentsRoot,
    cacheRoot,
    secretsRoot: path.join(userData, 'secrets'),
    documentDirectory: toFileUrl(documentsRoot, { trailingSlash: true }),
    cacheDirectory: toFileUrl(cacheRoot, { trailingSlash: true }),
  };
}

// 内置角色素材：把随包发布的 jpg 复制到 documents/avatars/（仅缺失时）。
// 渲染层读不到安装目录，这一步只能放主进程；与 Android 端「assets -> avatars」同语义。
function ensureDefaultArtwork(documentsRoot) {
  const avatarsDir = path.join(documentsRoot, 'avatars');
  mkdirSync(avatarsDir, { recursive: true });
  const assetRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.resolve(__dirname, '..', '..', 'assets');
  // 源文件名（随包发布）-> 落盘名（与 Android 端 DEFAULT_ARTWORK_FILES 一致）。
  // 桌面与手机共用同一套「默认角色头像文件名」，备份互导后引用不会断。
  const artwork = [
    ['easychat-assistant-avatar.jpg', 'default-assistant-avatar.jpg'],
    ['easychat-assistant-bg.jpg', 'default-assistant-bg.jpg'],
  ];
  for (const [sourceName, destName] of artwork) {
    const dest = path.join(avatarsDir, destName);
    if (existsSync(dest)) continue;
    try {
      copyFileSync(path.join(assetRoot, sourceName), dest);
    } catch (error) {
      // 素材缺失不阻断启动：界面按「图片不可用」回退首字母头像。
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#11131a',
    show: false,
    webPreferences: {
      // preload 必须是 CJS（sandbox 下不支持 ESM preload），故用 .cjs 扩展名。
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  // 渲染层 console 转发到主进程 stdout：冒烟/排查时不用开 DevTools 也能看到首错。
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.log(`[preload-error] ${preloadPath}: ${String((error && error.message) || error)}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.log(`[render-process-gone] ${JSON.stringify(details)}`);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', async () => {
    if (!SMOKE) return;
    try {
      const probe = await mainWindow.webContents.executeJavaScript(SMOKE_PROBE, true);
      // 等 React 首帧渲染完成再截图。
      await new Promise(resolve => setTimeout(resolve, 500));
      const image = await mainWindow.webContents.capturePage();
      const screenshot = path.join(app.getPath('userData'), 'smoke.png');
      writeFileSync(screenshot, image.toPNG());
      const ok = !!(
        probe
        && probe.bridge === true
        && probe.kv === 'ok'
        && probe.fs === 'hello'
        && probe.exists
        && probe.artworkExists
        && probe.s2
        && probe.s2.loaded
        && probe.s2.counts.characters >= 1
        && probe.s2.counts.sessions >= 1
      );
      console.log(`SMOKE_RESULT ${JSON.stringify({ ok, screenshot, probe })}`);
      app.exit(ok ? 0 : 1);
    } catch (error) {
      console.log(`SMOKE_RESULT ${JSON.stringify({ ok: false, error: String((error && error.message) || error) })}`);
      app.exit(1);
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) mainWindow.loadURL(devServerUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function applyCsp() {
  // 生产环境收口：只允许自身资源、媒体协议与内联样式（富 HTML 走 sandbox iframe，另设 CSP）。
  // dev 环境不加：Vite HMR 需要 ws: 与内联脚本。
  if (process.env.VITE_DEV_SERVER_URL) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data: easychat2-media:; media-src 'self' easychat2-media:; "
          + "connect-src 'self'; font-src 'self' data:",
        ],
      },
    });
  });
}

if (SMOKE) app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const paths = userPaths();
  for (const dir of [paths.documentsRoot, paths.cacheRoot, paths.secretsRoot, path.join(paths.userData, 'kv')]) {
    mkdirSync(dir, { recursive: true });
  }

  ensureDefaultArtwork(paths.documentsRoot);
  fsService = createFsService({ documentsRoot: paths.documentsRoot, cacheRoot: paths.cacheRoot });
  const kvStore = createKvStore({ root: path.join(paths.userData, 'kv') });
  const secretStore = createSecretStore({ root: paths.secretsRoot, safeStorage });
  httpProxy = createHttpProxy({
    sendEvent: payload => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('http:event', payload);
    },
  });

  registerKvIpc(ipcMain, kvStore);
  registerFsIpc(ipcMain, fsService);
  registerSecretIpc(ipcMain, secretStore);
  registerHttpIpc(ipcMain, httpProxy);
  registerDialogIpc(ipcMain, { dialog, shell, clipboard, resolver: fsService.resolver });

  // 同步路径（preload 需要在模块加载期拿到，documentDirectory 是同步读取的）。
  ipcMain.on('app:paths', event => {
    event.returnValue = {
      documentDirectory: paths.documentDirectory,
      cacheDirectory: paths.cacheDirectory,
    };
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: 'windows',
    userData: paths.userData,
    documents: paths.documentDirectory,
    cache: paths.cacheDirectory,
  }));

  protocol.handle(MEDIA_SCHEME, createMediaHandler({ documentsRoot: paths.documentsRoot }).handler);
  applyCsp();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 自定义协议必须在 ready 之前登记特权（standard/secure 才能被 fetch 与 <img> 正常使用）。
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (httpProxy) httpProxy.closeAll();
  if (fsService) fsService.closeAll();
});
