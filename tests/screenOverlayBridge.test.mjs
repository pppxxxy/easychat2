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
