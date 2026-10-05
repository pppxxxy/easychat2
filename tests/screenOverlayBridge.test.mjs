import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  OVERLAY_EVENT_CAPTURE,
  OVERLAY_EVENT_REQUEST_CAPTURE,
  OVERLAY_EVENT_STATE,
  parseCaptureEvent,
  parseStateEvent,
} from '../src/screenWatch/overlayEvents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const overlaySrc = read('src/screenWatch/overlay.js');
const screenSrc = read('src/screenWatch/ScreenWatchScreen.js');
const settingsSrc = read('src/SettingsScreen.js');
const hookSrc = read('src/screenWatch/useScreenWatchComments.js');

test('事件名与原生 OverlayService 契约一致', () => {
  assert.equal(OVERLAY_EVENT_CAPTURE, 'ScreenOverlay:onCapture');
  assert.equal(OVERLAY_EVENT_REQUEST_CAPTURE, 'ScreenOverlay:onRequestCapture');
  assert.equal(OVERLAY_EVENT_STATE, 'ScreenOverlay:onState');
});

test('parseCaptureEvent 归一 file:// 路径，空路径视为无效', () => {
  assert.deepEqual(parseCaptureEvent({ path: 'file:///a/b.jpg' }), { path: 'file:///a/b.jpg' });
  assert.equal(parseCaptureEvent({ path: '' }), null);
  assert.equal(parseCaptureEvent(null), null);
});

test('parseStateEvent 缺字段按 false 处理', () => {
  assert.deepEqual(parseStateEvent({ active: true }), { active: true });
  assert.deepEqual(parseStateEvent({}), { active: false });
  assert.deepEqual(parseStateEvent(null), { active: false });
});

test('overlay.js 暴露全部桥方法且惰性读取原生模块', () => {
  for (const name of [
    'isOverlaySupported',
    'canDrawOverlays',
    'requestOverlayPermission',
    'requestCapturePermission',
    'startOverlay',
    'stopOverlay',
    'isOverlayActive',
    'captureOverlayFrame',
    'updateOverlayText',
    'addCaptureListener',
    'addRequestCaptureListener',
    'addStateListener',
  ]) {
    assert.ok(overlaySrc.includes(`export function ${name}`) || overlaySrc.includes(`export async function ${name}`),
      `overlay.js 缺少导出 ${name}`);
  }
  assert.ok(overlaySrc.includes('NativeModules.ScreenOverlay'), '应读取 NativeModules.ScreenOverlay');
  assert.ok(overlaySrc.includes('DeviceEventEmitter'), '应经 DeviceEventEmitter 订阅事件');
  for (const constant of ['OVERLAY_EVENT_CAPTURE', 'OVERLAY_EVENT_REQUEST_CAPTURE', 'OVERLAY_EVENT_STATE']) {
    assert.ok(overlaySrc.includes(constant), `overlay.js 应引用 ${constant}`);
  }
});

test('ScreenWatchScreen 接线：桥方法、能力解析、多帧生成与回写小窗', () => {
  assert.ok(screenSrc.includes("from './overlay.js'"), '应导入 overlay 桥');
  assert.ok(screenSrc.includes('resolveScreenWatchCapabilities'), '应解析视频/识图能力');
  assert.ok(screenSrc.includes('addRequestCaptureListener'), '应订阅小窗截屏请求');
  assert.ok(screenSrc.includes('addCaptureListener'), '应订阅原生截屏结果');
  assert.ok(screenSrc.includes('updateOverlayText'), '应回写小窗文案');
  assert.ok(screenSrc.includes('markMediaWrite'), '截图应登记媒体保护');
  assert.ok(/imageUris/.test(screenSrc), '视频能力应走多帧 imageUris');
});

test('useScreenWatchComments 支持多帧并对外暴露能力解析', () => {
  assert.ok(hookSrc.includes('export async function resolveScreenWatchCapabilities'), '应导出能力解析');
  assert.ok(hookSrc.includes('supportsVideo'), '应读取 supportsVideo');
  assert.ok(hookSrc.includes('imageUris'), 'generate 应接受多帧');
});

test('SettingsScreen 暴露 supportsVideo 能力开关', () => {
  assert.ok(settingsSrc.includes('supportsVideo'), '设置页应含 supportsVideo');
  const count = settingsSrc.match(/supportsVideo/g).length;
  assert.ok(count >= 3, `supportsVideo 接线点过少：${count}`);
});

test('悬浮球图标：取系统登记的 App 图标，并按资源名回退', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('packageManager.getApplicationInfo(packageName, 0)'),
    '优先取系统登记的 App 图标（桌面显示哪个就用哪个）');
  assert.ok(/listOf\("ic_launcher_round", "ic_launcher", "icon"\)/.test(service),
    '按资源名回退：Expo prebuild 生成的是 ic_launcher/ic_launcher_round，'
    + '只试 "icon" 会永远找不到 → 一直回退成「看」字球');
  assert.ok(service.includes('resolveAppIconDrawable'), '图标解析集中在一处');
});

test('跨应用截屏兜底：屏幕静止时用最近帧交付，不空等超时', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('mainHandler.postDelayed(captureFallback, CAPTURE_FALLBACK_DELAY_MS)'),
    '请求后必须有兜底定时器');
  assert.ok(service.includes('private fun deliverFallbackFrame()'), '兜底交付存在');
  assert.ok(/val bitmap = stale \?: bitmapFromCachedFrame\(\)/.test(service),
    '优先请求期间收到的旧帧，其次最近缓存像素');
  assert.ok(service.includes('private fun cacheFrameBytes(image: Image)'), '持续维护「最近一帧」缓存');
  assert.ok(service.includes('cacheFrameBytes(image)'), '每次帧回调都更新缓存（内部节流）');
  assert.ok(service.includes('else if (pendingStaleBitmap == null)'), '请求期间的旧帧保留为兜底候选');
  assert.ok(service.includes('emitCaptureFailed("no-frame")'), '确实没有帧才报错（原因可诊断）');
  assert.ok(service.includes('mainHandler.removeCallbacks(captureFallback)'), '新鲜帧先到要取消兜底');
  const release = service.slice(service.indexOf('private fun releaseCapture()'));
  assert.ok(release.includes('removeCallbacks(captureFallback)'), '释放时取消兜底回调');
  assert.ok(release.includes('pendingStaleBitmap?.recycle()'), '释放时回收兜底位图');
});

test('识图测试：改名 + 失败暴露真实原因（不再一律甩「检查 API 配置」）', () => {
  const zh = read('src/i18n/locales/zh-CN.js');
  const en = read('src/i18n/locales/en.js');
  assert.ok(zh.includes("'screenWatch.capture': '识图测试'"), '按钮改名「识图测试」');
  assert.ok(en.includes("'screenWatch.capture': 'Vision test'"), '英文同步改名');
  assert.ok(!zh.includes('截屏给TA看看'), '旧名移除');

  assert.ok(hookSrc.includes('maskSecrets'), '评论失败要脱敏后带出真实原因');
  assert.ok(hookSrc.includes('lastErrorRef'), '暴露最近错误给悬浮窗小窗回写');
  const hookCatch = hookSrc.slice(hookSrc.indexOf('} catch (caught) {'));
  assert.ok(hookCatch.includes('const detail = maskSecrets('),
    '真实原因取自原始错误消息（含脱敏），不能只显示固定文案');

  assert.ok(screenSrc.includes('overlayErrorText'), '小窗失败回写带原因');
  assert.ok(/const detail = maskSecrets\(String\(\(error && error\.message\) \|\| ''\)\)/.test(screenSrc),
    '截屏失败 Alert 带截屏链路的原始错误');
});
