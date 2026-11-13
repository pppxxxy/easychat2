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
import { registerMediaPickIpc } from './ipc/mediaPick.js';
import { registerBackupFileIpc } from './ipc/backupFiles.js';
import { registerDialogIpc } from './ipc/dialog.js';
import * as smokeFixtures from './smoke-fixtures.js';
import { toFileUrl } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_SCHEME = 'easychat2-media';

// 冒烟模式（npm run smoke）：在真实 Electron 运行时验证 renderer -> preload -> main
// 全链路，并把窗口截图写到 <userData>/smoke.png。仅由环境变量开启，不影响正常启动。
const SMOKE = process.env.EASYCHAT2_DESKTOP_SMOKE === '1';
const SMOKE_PROBE = readFileSync(path.join(__dirname, 'smoke-probe.js'), 'utf8');
// 群聊探针与「更多菜单」探针各是独立模块（smoke-probe-group.js / smoke-probe-surface.js），
// 先注入把函数挂到 globalThis，主探针再调用（两个文件都各自撞到 800 行棘轮）。
const SMOKE_PROBE_GROUP = readFileSync(path.join(__dirname, 'smoke-probe-group.js'), 'utf8');
const SMOKE_PROBE_SURFACE = readFileSync(path.join(__dirname, 'smoke-probe-surface.js'), 'utf8');
const SMOKE_PROBE_SCREENS = readFileSync(path.join(__dirname, 'smoke-probe-screens.js'), 'utf8');
// 冒烟夹具（模型回复正文）单独放文件：它们是测试数据，不是界面文案，且被 i18n 规则豁免。
const {
  SMOKE_REPLY,
  MARKDOWN_SMOKE_REPLY,
  RICH_HTML_SMOKE_REPLY,
  GROUP_SCHEDULER_MARK,
  buildGroupSchedulerReply,
} = smokeFixtures;

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

// 随包资源目录：打包后在 resources/assets，开发时是仓库根 assets/。
function bundledAssetsRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.resolve(__dirname, '..', '..', 'assets');
}

// 内置角色素材：把随包发布的 jpg 复制到 documents/avatars/（仅缺失时）。
// 渲染层读不到安装目录，这一步只能放主进程；与 Android 端「assets -> avatars」同语义。
function ensureDefaultArtwork(documentsRoot) {
  const avatarsDir = path.join(documentsRoot, 'avatars');
  mkdirSync(avatarsDir, { recursive: true });
  const assetRoot = bundledAssetsRoot();
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
      // 只按**最后一条用户消息**选回复：整段 body 包含历史里的标记，用 body.includes
      // 会让第一次渲染测试之后的每一轮都返回富 HTML。
      let lastUserText = '';
      let isScheduler = false;
      try {
        const parsed = JSON.parse(requestBody);
        const messages = Array.isArray(parsed && parsed.messages) ? parsed.messages : [];
        // 群聊调度器：系统提示里带标识，且要求只输出 JSON 名单。
        isScheduler = messages.some(message => message && message.role === 'system'
          && String(message.content || '').includes(GROUP_SCHEDULER_MARK));
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (!message || message.role !== 'user') continue;
          const content = message.content;
          lastUserText = typeof content === 'string'
            ? content
            : (Array.isArray(content)
              ? content.map(part => String((part && part.text) || '')).join(' ')
              : '');
          break;
        }
      } catch (error) {
        lastUserText = '';
      }
      let reply;
      if (isScheduler) {
        // 从 roster 行「- 名字: …」取前两个成员名回给调度器。
        const rosterNames = [];
        try {
          const parsed = JSON.parse(requestBody);
          const nl = String.fromCharCode(10);
          const sys = (parsed.messages || []).map(message => String((message && message.content) || '')).join(nl);
          for (const line of sys.split(nl)) {
            const match = line.match(/^- ([^:]+):/);
            if (match) rosterNames.push(match[1].trim());
          }
        } catch (error) {}
        reply = buildGroupSchedulerReply(rosterNames);
      } else if (lastUserText.includes('富HTML测试')) {
        reply = RICH_HTML_SMOKE_REPLY;
      } else if (lastUserText.includes('渲染测试')) {
        reply = MARKDOWN_SMOKE_REPLY;
      } else {
        reply = SMOKE_REPLY;
      }
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

function seedSmokeApiConfig(kvStore, baseUrl) {  // 存储形状与 src/storage/apiConfigs.js 一致：{ configs, activeId }。
  kvStore.set('@easychat2_api_configs', JSON.stringify({
    configs: [{
      id: 'cfg-smoke',
      name: 'Smoke Mock',
      baseUrl,
      apiKey: 'smoke-key',
      protocol: 'openai',
      models: ['mock-model'],
      activeModel: 'mock-model',
      // 附件冒烟需要识图能力（否则发送前的视觉门控会拦下图）。
      modelCapabilities: { 'mock-model': { supportsVision: true, supportsVideo: true } },
    }].concat(kiloConfigs()),
    activeId: KILO_LIVE ? KILO_CONFIG.id : 'cfg-smoke',
  }));
}

// 实时 Kilo 匿名模式（EASYCHAT2_KILO_LIVE=1）：只放 Kilo 一条配置并设为当前，
// 整个冒烟改判「真实网络链路是否跑通」（见下方评价分支）。普通冒烟完全不碰外网。
const KILO_LIVE = process.env.EASYCHAT2_KILO_LIVE === '1';
const KILO_CONFIG = {
  id: 'cfg-kilo-anon',
  name: 'Kilo Gateway (anonymous)',
  baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
  apiKey: '',
  protocol: 'openai',
  anonymous: true,
  models: ['kilo-auto/free'],
  activeModel: 'kilo-auto/free',
  vendorId: 'kilo-gateway',
};
function kiloConfigs() {
  return KILO_LIVE ? [KILO_CONFIG] : [];
}

// 冒烟用表情包：真实落盘 + 真实存储键（索引 + 单条分键），用于验证面板加载与发送。
function seedSmokeSticker(documentsRoot, kvStore) {
  const directory = path.join(documentsRoot, 'stickers');
  mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, 'sticker-smoke.jpg');
  try {
    copyFileSync(path.join(bundledAssetsRoot(), 'easychat-assistant-avatar.jpg'), destination);
  } catch (error) {
    return;
  }
  const sticker = {
    id: 'sticker-smoke',
    name: 'SmokeSticker',
    uri: toFileUrl(destination),
    mime: 'image/jpeg',
    width: 256,
    height: 256,
    createdAt: Date.now(),
  };
  kvStore.set('@easychat2_sticker_item::sticker-smoke', JSON.stringify(sticker));
  kvStore.set('@easychat2_sticker_index', JSON.stringify(['sticker-smoke']));
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
      // 群聊探针模块先注入（定义函数并挂到 globalThis），主探针随后调用。
      await mainWindow.webContents.executeJavaScript(SMOKE_PROBE_GROUP, true);
      await mainWindow.webContents.executeJavaScript(SMOKE_PROBE_SURFACE, true);
      await mainWindow.webContents.executeJavaScript(SMOKE_PROBE_SCREENS, true);
      // 把模式标记先写进渲染层：探针据此决定是否跳过依赖本地 mock 的段落。
      await mainWindow.webContents.executeJavaScript(
        `globalThis.__easychat2KiloLive = ${KILO_LIVE ? 'true' : 'false'};`,
        true
      );
      const probe = await mainWindow.webContents.executeJavaScript(SMOKE_PROBE, true);
      // 等 React 首帧渲染完成再截图。
      await new Promise(resolve => setTimeout(resolve, 500));
      const image = await mainWindow.webContents.capturePage();
      const screenshot = path.join(app.getPath('userData'), 'smoke.png');
      writeFileSync(screenshot, image.toPNG());
      // 两套判据，按模式二选一：
      //   · 普通冒烟（本地 mock）：整条链路逐项断言（含新界面与分支）；
      //   · Kilo 实时模式：只判「真实网络链路跑通」——mock 模型与依赖它的
      //     渲染/附件/贴纸/分支探针在该模式下必然拿不到预期回复。
      const baseOk = !!(
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
        && probe.firstRun
        && probe.firstRun.attempted
      );
      const mockOk = !!(
        baseOk
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
        && probe.attachment
        && probe.attachment.attempted
        && probe.attachment.chipSeen
        && probe.attachment.replySeen
        && probe.attachment.persisted
        && probe.sticker
        && probe.sticker.attempted
        && probe.sticker.tileSeen
        && probe.sticker.replySeen
        && probe.sticker.persisted
        && probe.backup
        && probe.backup.attempted
        && probe.backup.panelSeen
        && probe.settings
        && probe.settings.attempted
        && probe.settings.loaded
        && probe.settings.sectionsVisited >= 3
        && probe.screens
        && probe.screens.attempted
        && probe.screens.libraryTabOk
        && probe.screens.characterOk
        && probe.screens.worldAddSeen
        && probe.screens.memoryOk
        && probe.screens.memoryBucketsSeen
        && probe.screens.vectorOk
        && probe.screens.summaryOk
        && probe.screens.extensionOk
        && probe.screens.groupsSeen
        && probe.screens.reasonSeen
        && probe.library
        && probe.library.attempted
        && probe.library.gridOk
        && probe.library.searchSeen
        && probe.library.searchFiltered
        && probe.library.searchRestored
        && probe.library.backSeen
        && probe.usage
        && probe.usage.attempted
        && probe.usage.barSeen
        && probe.usage.tokenText
        && probe.branch
        && probe.branch.attempted
        && probe.branch.branchArchived
        && probe.branch.navSeen
        && probe.branch.switchedBack
        && probe.newSession
        && probe.newSession.attempted
        && probe.newSession.created
        // S12：新建会话必须真的能发消息（不带开场白建出来的会话会被共享层静默拦住）。
        && probe.newSession.pickerSeen
        && probe.newSession.greetingSelected
        && probe.newSession.sendable
        && probe.groupChat
        && probe.groupChat.attempted
        && probe.groupChat.opened
        && probe.groupChat.created
        && probe.groupChat.sent
        && probe.groupChat.replySeen
        && probe.groupChat.speakerSeen
        // S12b：手机版有、桌面此前缺的四项能力（搜索 / 统计 / 导出 / 记忆总结）。
        && probe.surface
        && probe.surface.attempted
        && probe.surface.searchOpened
        && probe.surface.searchMatchSeen
        && probe.surface.statsOpened
        && probe.surface.exportOpened
        && probe.surface.moreMenuSeen
        && probe.surface.extensionOpened === probe.surface.extensionTotal
      );
      const kiloOk = !!(
        baseOk
        && probe.kilo
        && probe.kilo.attempted
        && probe.kilo.sendAttempted
        && probe.kilo.replySeen
      );
      const ok = KILO_LIVE ? kiloOk : mockOk;
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
    seedSmokeSticker(paths.documentsRoot, kvStore);
    // Kilo 实时模式不启动本地 mock：请求必须真的出网。
    if (KILO_LIVE) seedSmokeApiConfig(kvStore, '');
    else startSmokeModelServer().then(({ baseUrl }) => {
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
  registerMediaPickIpc(ipcMain, { dialog, documentsRoot: paths.documentsRoot, cacheRoot: paths.cacheRoot });
  registerBackupFileIpc(ipcMain, { dialog, documentsRoot: paths.documentsRoot, cacheRoot: paths.cacheRoot });

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
