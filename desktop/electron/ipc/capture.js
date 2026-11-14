// 应用内截图（看屏幕 v1 的桌面实现）。
//
// 为什么这是真能力而非「不可移植」：手机端的看屏幕 v1 用的是 react-native-view-shot，
// 截的是**自己 App 的界面**，零权限（src/screenWatch/capture.js 顶部注释写明
// 「跨应用截屏涉及 MediaProjection 动态授权，明确不做」）。桌面有一个精确对应物：
// webContents.capturePage()——冒烟截图本来就是它产出的（electron/main.js:307）。
//
// 与手机同一条纪律：
//   · 落盘到 documents/screen-watch/（与手机同名目录、同样按时间命名）；
//   · 只服务当次评论请求与重试，目录按「保留最新 N 张」滚动清扫；
//   · 失败不留半成品（先写临时文件再 rename）。
//
// 跨应用截屏（手机悬浮窗 + MediaProjection）在桌面确实没有等价物：
// 那需要系统级屏幕录制授权与置顶窗口，Electron 的 desktopCapturer 只能拿到
// 用户经系统选择器授权的单个窗口/屏幕流，且无法在「别的应用之上」渲染自己的 UI。
// 这条差异记在 desktop/src/extension/unsupportedReasons.js 里（只针对悬浮窗）。
import fs from 'node:fs';
import path from 'node:path';

export const SCREEN_WATCH_DIR_NAME = 'screen-watch';
const SWEEP_KEEP = 20;
// 扩展名与**实际内容**一致：Electron 的 capturePage 只产出 PNG/位图（没有 jpg 编码），
// 所以存 .png。手机端用 format:'jpg' 存 .jpg —— 这里刻意不跟随后缀，
// 因为消费者会按后缀判 MIME（mediaProtocol、图片识别都这么干），撒谎会读出坏图。
const CAPTURE_NAME = /^cap-[a-z0-9]+-[a-z0-9]+\.png$/;

/** screen-watch 目录（绝对路径，不含末尾分隔符）。 */
export function screenWatchDir(documentsRoot) {
  return path.join(String(documentsRoot || ''), SCREEN_WATCH_DIR_NAME);
}

/**
 * 纯函数：从 {name, mtimeMs} 清单里挑出该删的旧截图（保留最新 keepNewest 张）。
 *
 * 为什么用 mtime 而不是文件名：名字里的 `Date.now().toString(36)` 在同一毫秒内
 * 会重复（快速连拍时真实发生），此时按名字排序会漂移，可能删掉刚拍的那张。
 * 名字只作 mtime 相同时的稳定次序。
 */
export function pickStaleCaptures(entries, keepNewest = SWEEP_KEEP) {
  const captures = (Array.isArray(entries) ? entries : [])
    .map(entry => (typeof entry === 'string' ? { name: entry, mtimeMs: 0 } : entry))
    .filter(entry => entry && CAPTURE_NAME.test(String(entry.name)))
    .sort((a, b) => {
      const diff = Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0);
      if (diff !== 0) return diff;
      return String(b.name) < String(a.name) ? -1 : 1;
    });
  return captures.slice(Math.max(0, Math.floor(keepNewest))).map(entry => String(entry.name));
}

export function createCaptureService({ documentsRoot } = {}) {
  if (!documentsRoot) throw new Error('createCaptureService: documentsRoot is required');
  const dir = screenWatchDir(documentsRoot);

  function sweep(keepNewest = SWEEP_KEEP) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      return 0; // 从没用过 → 目录还不存在，不是错误
    }
    // 取 mtime：同名毫秒的连拍靠它才不会互相顶掉（见 pickStaleCaptures 注释）。
    const entries = names.map(name => {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
      } catch (error) {
        // 读不到时间就退回名字次序；不该因此中断清扫。
      }
      return { name, mtimeMs };
    });
    const stale = pickStaleCaptures(entries, keepNewest);
    for (const name of stale) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (error) {
        // 单个删除失败不影响其余（可能被别的进程占用）。
      }
    }
    return stale.length;
  }

  /**
   * 把一帧 PNG 落成 screen-watch/cap-*.png，返回绝对路径。
   * 内容与后缀一致（PNG），见 CAPTURE_NAME 的注释。
   */
  function saveFrame(buffer, now = Date.now()) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `cap-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`;
    const dest = path.join(dir, name);
    // 先写临时文件再 rename：中途失败不会留下半张图被当成完整截图。
    const tmp = `${dest}.part`;
    try {
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, dest);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch (cleanupError) {}
      throw error;
    }
    sweep();
    return dest;
  }

  return { dir, saveFrame, sweep };
}

export function registerCaptureIpc(ipcMain, { getWindow, documentsRoot } = {}) {
  const service = createCaptureService({ documentsRoot });
  ipcMain.handle('capture:appScreen', async () => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || (win.isDestroyed && win.isDestroyed())) {
      return { ok: false, reason: 'no-window' };
    }
    try {
      const image = await win.webContents.capturePage();
      const filePath = service.saveFrame(image.toPNG());
      // 返回 file:// URI：渲染层的 expo-file-system 适配层按 URI 消费（与手机一致）。
      return { ok: true, uri: `file://${filePath.replace(/\\/g, '/')}`, path: filePath };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });
  return { service };
}