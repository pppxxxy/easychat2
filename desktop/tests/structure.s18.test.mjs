// 桌面外壳结构守卫（S18）：看屏幕（screen watch）的桌面实现。
//
// 上一轮把「看屏幕」整体标成不可移植，依据是「需要悬浮窗 + MediaProjection」。
// 但手机自己的 capture.js 顶部就写明：v1 截的是**自己 App**（react-native-view-shot，
// 零权限），跨应用截屏是明确延后的独立能力。桌面有精确对应物 capturePage()，
// 所以「整体不可移植」是同 OCR / 动态 / 主动消息同一类过期判断。
//
// 本守卫钉：能力位、IPC 落盘纪律、适配层契约、页面接线，以及**不可用清单不再包含看屏幕**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');

const CAPS = read('src', 'platform', 'capabilities.js');
const VIEW_SHOT = read('src', 'platform', 'viewShot.js');
const CAPTURE_IPC = read('electron', 'ipc', 'capture.js');
const PRELOAD = read('electron', 'preload.cjs');
const MAIN = read('electron', 'main.js');
const VITE = read('vite.config.mjs');
const ROUTES = read('src', 'extension', 'extensionRoutes.js');
const SCREEN = read('src', 'extension', 'screens', 'ScreenWatchScreen.jsx');
const REASONS = read('src', 'extension', 'unsupportedReasons.js');
const EXT_SCREEN = read('src', 'extension', 'ExtensionScreen.jsx');

test('能力位：看屏幕已开（悬浮窗另记在不可用清单）', () => {
  assert.match(CAPS, /screenWatch: true/, '看屏幕能力位应为 true');
});

test('IPC：capturePage 截本窗口，落 documents/screen-watch 并滚动清扫', () => {
  assert.ok(CAPTURE_IPC.includes('capturePage'), '未使用 webContents.capturePage');
  assert.ok(CAPTURE_IPC.includes("SCREEN_WATCH_DIR_NAME = 'screen-watch'"), '目录名应与手机一致');
  // 扩展名必须与内容一致：capturePage 只产 PNG，写成 .jpg 会让按后缀判 MIME 的消费者读坏图。
  assert.ok(/\.png\$/.test(CAPTURE_IPC), '截图应以 .png 命名（内容就是 PNG）');
  assert.ok(CAPTURE_IPC.includes('"part"') || CAPTURE_IPC.includes('.part'), '缺「先写临时文件再 rename」');
  // 清扫按 mtime：同毫秒连拍时按名字排序会漂移，可能删掉刚拍的那张。
  assert.ok(CAPTURE_IPC.includes('mtimeMs'), '清扫应按 mtime 而非文件名');
  assert.ok(/CAPTURE_NAME/.test(CAPTURE_IPC), '缺截图文件名判据（会误删同目录其他文件）');
});

test('接线：main 注册 IPC、preload 暴露 bridge、vite 映射 view-shot', () => {
  assert.ok(MAIN.includes('registerCaptureIpc'), 'main 未注册 capture IPC');
  assert.ok(PRELOAD.includes('capture:appScreen'), 'preload 未暴露 capture.appScreen');
  assert.match(VITE, /find: \/\^react-native-view-shot\$\/, replacement: platform\('viewShot\.js'\)/,
    '缺 view-shot 别名');
});

test('适配层契约对齐共享层：只支持 tmpfile，releaseCapture 不删文件', () => {
  // 共享层只用 result:'tmpfile'；其余形态明确拒绝好过静默返回错类型。
  assert.ok(VIEW_SHOT.includes('tmpfile'), '缺 tmpfile 形态');
  assert.ok(/throw new Error/.test(VIEW_SHOT), '不支持的形态应抛错');
  // releaseCapture 若真去删文件，会把当次要用的截图删掉（桌面没有临时文件概念）。
  assert.ok(/releaseCapture[\s\S]{0,400}不能|不得|刻意不删/.test(VIEW_SHOT), '应说明 releaseCapture 不删文件');
});

test('页面复用共享 hook，不重写判定', () => {
  assert.ok(SCREEN.includes('useScreenWatchComments'), '未复用共享评论 hook');
  assert.ok(SCREEN.includes('captureAppScreen'), '未复用共享截图入口');
  assert.ok(SCREEN.includes('resolveScreenWatchCapabilities'), '缺视觉门控提示');
  // 截屏与生成必须分两段 try：生成失败不该显示成「截屏失败」。
  assert.ok(/capture\.failed\.title/.test(SCREEN) && /generate\.failed\.title/.test(SCREEN),
    '两段失败文案必须分开');
});

test('看屏幕已从「不可用清单」移入可用分组；只剩悬浮窗记为不可用', () => {
  assert.ok(EXT_SCREEN.includes("id: 'screenWatch'"), '扩展页缺看屏幕入口');
  assert.ok(!/id: 'screenWatch', icon: '👁', labelKey: 'desktop.entry.screenWatch'/.test(EXT_SCREEN),
    '看屏幕仍在「不可用」清单里');
  assert.ok(EXT_SCREEN.includes('ext.home.screen'), '应复用手机词条');
  assert.ok(ROUTES.includes('screenWatch: ScreenWatchScreen'), '路由表缺看屏幕');
  // S39：悬浮窗（置顶窗口 + 整屏截图）已实现，不再出现在不可用清单里。
  // 判据改为「它不在清单，且能力位为 true」——避免把「已可用」写成「不可用」。
  assert.ok(!REASONS.includes('screenOverlay'), '悬浮窗已可用，不应再列为不可用');
  assert.ok(/screenOverlay: true/.test(read('src', 'platform', 'capabilities.js')), '能力位应为 true');
  assert.ok(!/^\s*screenWatch: '/m.test(REASONS), 'screenWatch 不应再整体列为不可用');
});