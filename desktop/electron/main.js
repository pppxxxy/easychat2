// Electron 主进程（design.md「Architecture」）。
//
// 持有全部系统能力：窗口、键值仓、文件、密钥、流式 HTTP、媒体协议、对话框。
// 渲染进程零 Node：一切能力经 preload 的 contextBridge 白名单进入
// （contextIsolation/sandbox 开启，nodeIntegration 关闭）。
//
// 依赖形状刻意保持「服务工厂 + register*」两段式：ipc/*.js 全部零 Electron 依赖，
// 适配层行为测试在 Node 里直接实例化同一份服务（见 desktop/tests/）。
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, session, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
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
// 探针按这个常量在界面/存储里找回复（与 electron/smoke-probe.js 保持一致）。
const SMOKE_REPLY = '桌面流式回复 OK';
// S4 渲染验收用的两种回复：用户消息里带标记时切换（同类容错，不影响其它场景）。
const MARKDOWN_SMOKE_REPLY = [
  '**加粗OK**',
  '',
  '- 列表甲',
  '- 列表乙',
  '',
  '```js',
  'const smoke = 1;',
  '```',
].join(String.fromCharCode(10));
const RICH_HTML_SMOKE_REPLY = [
  '<style>.smoke-card{background:#123456;color:#ffffff;padding:12px;border-radius:8px;}</style>',
  '<div class="smoke-card" id="smoke-card"><strong>富 HTML OK</strong></div>',
  '<details id="smoke-details"><summary>展开</summary><p>折叠内容</p></details>',
  '<button id="smoke-button" onclick="triggerSlash(\'/send 卡片命令\')">卡片命令按钮</button>',
  '<script>window.__smokePwned = true;</script>',
].join(String.fromCharCode(10));
const SMOKE_PROBE = readFileSync(path.join(__dirname, 'smoke-probe.js'), 'utf8');

// 允许交给系统打开的外部 URL scheme（与共享层 classifyRichHtmlLink 的口径一致）。
const EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// 数据目录名固定为 EasyChat2（不随 package.json name 变化）：文档目录是跨版本
// 稳定契约（design.md Requirement 1.4），改名会让老数据“消失”。
app.setName('EasyChat2');

// 冒烟使用**独立 profile**：不碰真实用户数据，且每次从干净状态开始（可复现）。
if (SMOKE) {
  const smokeRoot = path.join(app.getPath('userData'), 'smoke-profile');
  rmSync(smokeRoot, { recursive: true, force: true });
  mkdirSync(smokeRoot, { recursive: true });
  app.setPath('userData', smokeRoot);
}

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

// 冒烟用的本地 OpenAI 兼容 SSE 服务：固定回复 SMOKE_REPLY。
// 端口随机（127.0.0.1:0），只监听本机，进程随冒烟退出。
function startSmokeModelServer() {
  const server = http.createServer((request, response) => {
    console.log(`[smoke-model] ${request.method} ${request.url}`);
    let requestBody = '';
    request.on('data', chunk => {
      requestBody += chunk;
    });
    request.on('error', error => console.log(`[smoke-model] request error: ${error.message}`));
    request.on('end', () => {
      const reply = requestBody.includes('富HTML测试')
        ? RICH_HTML_SMOKE_REPLY
        : (requestBody.includes('渲染测试') ? MARKDOWN_SMOKE_REPLY : SMOKE_REPLY);
      // SSE 块以两个换行结尾；用 fromCharCode 构造，避免转义层级（源码可读、零歧义）。
      const separator = String.fromCharCode(10) + String.fromCharCode(10);
      const event = payload => 'data: ' + JSON.stringify(payload) + separator;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(event({ choices: [{ delta: { content: reply } }] }));
      response.write(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      response.write('data: [DONE]' + separator);
      response.end();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' });
    });
  });
}

function seedSmokeApiConfig(kvStore, baseUrl) {
  // 存储形状与 src/storage/apiConfigs.js 一致：{ configs, activeId }。
  kvStore.set('@easychat2_api_configs', JSON.stringify({
    configs: [{
      id: 'cfg-smoke',
      name: 'Smoke Mock',
      baseUrl,
      apiKey: 'smoke-key',
      protocol: 'openai',
      models: ['mock-model'],
      activeModel: 'mock-model',
    }],
    activeId: 'cfg-smoke',
  }));
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
  // 渲染进程不允许自己开新窗口或整页跳走：外链交给系统浏览器，其余一律拦下。
  // 富 HTML 卡片在 sandbox iframe 内，本来就没有脚本与顶层导航能力，这是第二道兜底。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_URL_SCHEMES.has((() => {
      try {
        return new URL(String(url)).protocol;
      } catch (error) {
        return '';
      }
    })())) {
      shell.openExternal(String(url)).catch(() => {});
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
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
        && probe.chat
        && probe.chat.attempted
        && probe.chat.replySeen
        && probe.chat.userMessagePersisted
        && probe.chat.replyPersisted
        && probe.render
        && probe.render.attempted
        && probe.render.markdownSeen
        && probe.render.richHtmlSeen
        && probe.render.cardStyled
        && probe.render.detailsSeen
        && probe.render.scriptBlocked
        && probe.render.frameHeight >= 40
        && probe.render.commandBridged
        && probe.render.richHtmlPersisted
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
          + "img-src 'self' data: blob: https: easychat2-media:; "
          + "media-src 'self' https: easychat2-media:; "
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
  if (SMOKE) {
    startSmokeModelServer().then(({ baseUrl }) => {
      seedSmokeApiConfig(kvStore, baseUrl);
    });
  }
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

  // 卡片/消息里的外链交给系统浏览器或邮件客户端；只放行明确的外部 scheme，
  // 其余（file:/javascript:/data: 等）一律拒绝——渲染层已用 classifyRichHtmlLink
  // 做过一次判定，这里是主进程侧的最后一道口子。
  ipcMain.handle('app:openExternal', async (event, rawUrl) => {
    const value = String(rawUrl || '').trim();
    let parsed = null;
    try {
      parsed = new URL(value);
    } catch (error) {
      parsed = null;
    }
    if (!parsed || !EXTERNAL_URL_SCHEMES.has(parsed.protocol)) {
      const error = new Error('Unsupported URL scheme');
      error.code = 'UNSUPPORTED_SCHEME';
      throw error;
    }
    await shell.openExternal(parsed.href);
    return true;
  });

  // 视频等本地媒体交给系统默认程序：路径必须先过 documents/cache 边界校验。
  ipcMain.handle('app:openPath', async (event, uri) => {
    const systemPath = fsService.resolver.resolve(String(uri || ''));
    const failure = await shell.openPath(systemPath);
    if (failure) {
      const error = new Error('Unable to open file');
      error.code = 'OPEN_FAILED';
      throw error;
    }
    return true;
  });

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
