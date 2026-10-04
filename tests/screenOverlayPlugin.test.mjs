import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  checkBraceBalance,
  checkPackageConsistency,
  findUnusedImports,
  readAllKotlin,
  readKotlinFiles,
} from './helpers/kotlinStatic.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KOTLIN_DIR = path.join(HERE, '..', 'plugins', 'screenOverlay', 'android');
const KOTLIN_PACKAGE = 'com.pppxxxy.easychat2.screenoverlay';
const kotlinSource = name => readKotlinFiles(KOTLIN_DIR).find(item => item.file === name).source;

const plugin = require('../plugins/withScreenOverlay.js');
const {
  PERMISSIONS,
  SERVICE_NAME,
  applyPermissions,
  applyComponents,
  applyMainApplicationPatch,
} = plugin.__testables;

function minimalManifest() {
  return { application: [{ $: { 'android:name': '.MainApplication' } }] };
}

test('权限清单覆盖悬浮窗与前台服务（mediaProjection）', () => {
  for (const required of [
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    // Android 13+ 前台服务的常驻通知必须拿到运行时通知权限才可见（Play 政策同样要求）。
    'android.permission.POST_NOTIFICATIONS',
  ]) {
    assert.ok(PERMISSIONS.includes(required), `缺少权限 ${required}`);
  }
});

test('投屏被系统停止（onStop）必须整体收口：stopSelf 走 onDestroy，不能只释放采集', () => {
  const module_ = kotlinSource('OverlayService.kt');
  assert.ok(
    /override fun onStop\(\) \{[\s\S]{0,400}?stopSelf\(\)/.test(module_),
    'MediaProjection.onStop 必须调用 stopSelf()（onDestroy 统一释放采集/悬浮窗/前台服务/状态）',
  );
  const stopBlock = module_.slice(module_.indexOf('override fun onStop()'), module_.indexOf('}, Handler(Looper.getMainLooper())'));
  assert.ok(!/^\s*releaseCapture\(\)\s*$/m.test(stopBlock),
    'onStop 里不得只调 releaseCapture()：那会留下孤儿悬浮窗与前台服务');
});

test('JS 实例销毁（invalidate）必须停掉 OverlayService，不留孤儿前台服务', () => {
  const module_ = kotlinSource('ScreenOverlayModule.kt');
  const invalidate = module_.slice(module_.indexOf('override fun invalidate()'), module_.indexOf('override fun onActivityResult'));
  assert.ok(invalidate.length > 0, '必须能定位到 invalidate()');
  assert.ok(
    invalidate.includes('reactContext.stopService(Intent(reactContext, OverlayService::class.java))'),
    'invalidate() 必须停服务：RN 0.81 只回调 invalidate()、不再回调 onCatalystInstanceDestroy()',
  );
});

test('Android 13+ 启动悬浮窗时必须请求运行时通知权限', () => {
  const module_ = kotlinSource('ScreenOverlayModule.kt');
  assert.ok(module_.includes('Manifest.permission.POST_NOTIFICATIONS'), '模块内要有通知权限请求');
  assert.ok(module_.includes('Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU'), '仅 Android 13+ 需要请求');
  const start = module_.slice(module_.indexOf('fun startOverlay('), module_.indexOf('fun stopOverlay('));
  assert.ok(start.includes('requestNotificationPermissionIfNeeded()'), 'startOverlay 必须先请求通知权限再启前台服务');
});

test('applyPermissions 能注入且幂等', () => {
  const manifest = applyPermissions(minimalManifest());
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length);
  applyPermissions(manifest);
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length);
});

test('组件注册：OverlayService 非导出、前台服务类型 mediaProjection，且幂等', () => {
  const app = applyComponents(minimalManifest()).application[0];
  const service = app.service.find(s => s.$['android:name'] === SERVICE_NAME);
  assert.ok(service, '未注册 OverlayService');
  assert.equal(service.$['android:exported'], 'false');
  assert.equal(service.$['android:foregroundServiceType'], 'mediaProjection');
  const again = applyComponents({ application: [app] }).application[0];
  assert.equal(again.service.length, 1);
});

test('MainApplication 补丁注册 ScreenOverlayPackage（SDK 50 template）且幂等', () => {
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '          override fun getPackages(): List<ReactPackage> {',
    '            return PackageList(this).packages',
    '          }',
  ].join('\n');
  const once = applyMainApplicationPatch(input);
  assert.match(once, /import com\.pppxxxy\.easychat2\.screenoverlay\.ScreenOverlayPackage/);
  assert.match(once, /packages\.add\(ScreenOverlayPackage\(\)\)/);
  assert.equal(applyMainApplicationPatch(once), once);
});

test('MainApplication 补丁注册 ScreenOverlayPackage（SDK 54 apply template）', () => {
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '        override fun getPackages(): List<ReactPackage> =',
    '            PackageList(this).packages.apply {',
    '              // add(MyReactNativePackage())',
    '            }',
  ].join('\n');
  const once = applyMainApplicationPatch(input);
  assert.match(once, /import com\.pppxxxy\.easychat2\.screenoverlay\.ScreenOverlayPackage/);
  assert.equal(/\badd\(ScreenOverlayPackage\(\)\)/.test(once), true);
  assert.equal(applyMainApplicationPatch(once), once);
});

test('MainApplication 模板无法识别时抛错，不静默放行', () => {
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '        override fun getPackages(): List<ReactPackage> = somethingElse()',
  ].join('\n');
  assert.throws(() => applyMainApplicationPatch(input), /补丁未生效/);
});

test('插件本体返回 config 对象', () => {
  assert.equal(typeof plugin({ name: 'x' }), 'object');
});

test('Kotlin 源码大括号平衡（沙箱无法编译，防编辑遗留重复片段）', () => {
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const { balance, errors } = checkBraceBalance(source);
    for (const error of errors) {
      assert.fail(`${file}:${error.line} ${error.message}`);
    }
    assert.equal(balance, 0, `${file} 大括号不平衡`);
  }
});

test('Kotlin 包名一致且无未使用导入', () => {
  for (const error of checkPackageConsistency(KOTLIN_DIR, KOTLIN_PACKAGE)) {
    assert.fail(`${error.file} ${error.message}`);
  }
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const unused = findUnusedImports(source);
    assert.deepEqual(
      unused.map(item => item.name),
      [],
      `${file} 存在未使用导入：${unused.map(item => item.line).join(' / ')}`,
    );
  }
});

test('原生事件名与模块名和 JS 事件常量一致', () => {
  const source = readAllKotlin(KOTLIN_DIR);
  for (const event of [
    'ScreenOverlay:onCapture',
    'ScreenOverlay:onRequestCapture',
    'ScreenOverlay:onState',
  ]) {
    assert.ok(source.includes(event), `原生缺少事件 ${event}`);
  }
  assert.ok(source.includes('override fun getName() = "ScreenOverlay"'), '模块名应为 ScreenOverlay');
});

test('MediaProjection 注册回调必须早于 createVirtualDisplay（Android 14 要求）', () => {
  const service = readKotlinFiles(KOTLIN_DIR)
    .find(item => item.file === 'OverlayService.kt');
  assert.ok(service, '缺少 OverlayService.kt');
  const callbackIndex = service.source.indexOf('registerCallback');
  const virtualIndex = service.source.indexOf('createVirtualDisplay');
  assert.ok(callbackIndex > 0 && virtualIndex > 0, '缺少采集调用');
  assert.ok(callbackIndex < virtualIndex, 'registerCallback 必须在 createVirtualDisplay 之前');
});

test('onDestroy 幂等释放投影/图像读取/悬浮视图', () => {
  const service = readKotlinFiles(KOTLIN_DIR)
    .find(item => item.file === 'OverlayService.kt').source;
  assert.ok(service.includes('override fun onDestroy()'), '缺少 onDestroy');
  assert.ok(service.includes('isRunning = false'), 'onDestroy 应复位运行标记');
  assert.ok(service.includes('virtualDisplay?.release()'), 'onDestroy 应释放 VirtualDisplay');
  assert.ok(service.includes('imageReader?.close()'), 'onDestroy 应关闭 ImageReader');
  assert.ok(service.includes('projection?.stop()'), 'onDestroy 应停止 MediaProjection');
});
