import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
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
  ACCESSIBILITY_SERVICE_NAME,
  ACCESSIBILITY_CONFIG_RES,
  applyPermissions,
  applyComponents,
  applyMainApplicationPatch,
  copyResTree,
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
  // 悬浮窗服务不得带无障碍权限（那是另一个服务的声明，别混在一起）。
  assert.equal(service.$['android:permission'], undefined);
  const again = applyComponents({ application: [app] }).application[0];
  assert.equal(again.service.length, 2, '两个服务：悬浮窗 + 无障碍骨架，且幂等不重复注册');
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

// ---- 无障碍服务骨架（2026-10：用户反馈 App 外截屏一直失败，怀疑需要无障碍权限）----
//
// 纪律：原生代码在沙箱里**无法编译**，所以这里只对「声明式接线 + 文件搬运」做
// 可本地判定的验证；任何涉及 Android API 行为的部分都不在此断言（见各断言注释）。

// 剥掉注释再断言：解释「为什么没接入某 API」的注释里会合法地出现该 API 名，
// 裸词匹配会把注释判成违规（门禁空转的经典成因：规则本该抓真调用，却在抓注释）。
function stripKotlinComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('无障碍服务：清单声明权限/导出/intent-filter/meta-data 齐全且幂等', () => {
  const app = applyComponents(minimalManifest()).application[0];
  const service = app.service.find(s => s.$['android:name'] === ACCESSIBILITY_SERVICE_NAME);
  assert.ok(service, '未注册无障碍服务');
  assert.equal(service.$['android:permission'], 'android.permission.BIND_ACCESSIBILITY_SERVICE',
    '无障碍服务必须由签名级权限 BIND_ACCESSIBILITY_SERVICE 把关');
  assert.equal(service.$['android:exported'], 'true', '系统要能绑定，必须导出');
  assert.equal(service.$['android:foregroundServiceType'], undefined, '无障碍服务不是前台服务');
  const actions = service['intent-filter'][0].action.map(a => a.$['android:name']);
  assert.deepEqual(actions, ['android.accessibilityservice.AccessibilityService']);
  const meta = service['meta-data'][0].$;
  assert.equal(meta['android:name'], 'android.accessibilityservice');
  assert.equal(meta['android:resource'], ACCESSIBILITY_CONFIG_RES);
  const again = applyComponents({ application: [app] }).application[0];
  assert.equal(again.service.filter(s => s.$['android:name'] === ACCESSIBILITY_SERVICE_NAME).length, 1,
    '重复 applyComponents 不得重复注册');
});

test('无障碍配置 XML：不含截屏能力声明（未核实的 API 不写成既成事实）', () => {
  const config = fs.readFileSync(
    path.join(KOTLIN_DIR, 'res', 'xml', 'accessibility_service_config.xml'), 'utf8');
  // canTakeScreenshot 的可用 API level 与无障碍截屏回调形态未能在本地核实。
  // 声明了却不实现 = 在清单里说谎（系统/商店会以为本服务能截屏），故必须**缺席**。
  // 将来接入无障碍截屏时，这条断言要连同真机验证结果一起改。
  //
  // 判据只看**开标签**，不看全文：注释里会（合法地）提到这个属性名来解释为什么
  // 没声明，把注释算进去的断言等于在抓自己写的说明文字。
  const openIndex = config.indexOf('<accessibility-service');
  assert.ok(openIndex >= 0, '缺少 <accessibility-service> 开标签');
  const tag = config.slice(openIndex, config.indexOf('>', openIndex) + 1);
  assert.equal(/canTakeScreenshot/.test(tag), false, '开标签内不得出现 canTakeScreenshot');
  assert.ok(/android:description="@string\/screen_overlay_accessibility_description"/.test(tag),
    '说明文案走字符串资源（android:description 只收资源引用）');
});

test('无障碍说明文案资源：与 XML 引用同名（改名要同步两处）', () => {
  const strings = fs.readFileSync(
    path.join(KOTLIN_DIR, 'res', 'values', 'screen_overlay_strings.xml'), 'utf8');
  assert.ok(strings.includes('name="screen_overlay_accessibility_description"'),
    '资源名必须与 accessibility_service_config.xml 的 @string 引用一致');
  // 只查**字符串值**，不查注释：注释里解释「本服务不接管采集」会合法地提到那些词，
  // 裸词匹配会把解释性注释判成违规（门禁空转的经典成因）。
  const values = [...strings.matchAll(/>([^<>]+)</g)].map(m => m[1]).join('\n');
  assert.equal(/截屏能力|可以截屏|无障碍截屏/.test(values), false,
    '文案不要把未接入的能力说满');
});

test('res 资源搬运：按目录结构落到主模块 res/（不落进 Kotlin 源码目录）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-res-'));
  try {
    const source = path.join(tmp, 'res');
    fs.mkdirSync(path.join(source, 'xml'), { recursive: true });
    fs.mkdirSync(path.join(source, 'values'), { recursive: true });
    fs.writeFileSync(path.join(source, 'xml', 'accessibility_service_config.xml'), '<x/>');
    fs.writeFileSync(path.join(source, 'values', 'screen_overlay_strings.xml'), '<resources/>');
    const dest = path.join(tmp, 'out');
    const copied = copyResTree(source, dest).sort();
    assert.deepEqual(copied, ['values/screen_overlay_strings.xml', 'xml/accessibility_service_config.xml']);
    assert.ok(fs.existsSync(path.join(dest, 'xml', 'accessibility_service_config.xml')));
    assert.ok(fs.existsSync(path.join(dest, 'values', 'screen_overlay_strings.xml')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('无障碍桥：模块暴露状态查询与跳转系统设置，且不接管采集', () => {
  const module_ = kotlinSource('ScreenOverlayModule.kt');
  assert.ok(module_.includes('fun isAccessibilityEnabled(promise: Promise)'), '缺少状态查询桥方法');
  assert.ok(module_.includes('fun openAccessibilitySettings(promise: Promise)'), '缺少跳转系统设置桥方法');
  assert.ok(module_.includes('Settings.ACTION_ACCESSIBILITY_SETTINGS'), '跳转必须走系统无障碍设置页');
  assert.ok(module_.includes('ScreenAccessibilityService::class.java.name'),
    '状态查询要按 ComponentName 精确比对，不能用 contains 裸匹配');
  assert.ok(module_.includes('TextUtils.SimpleStringSplitter'), '按系统格式切分已启用列表');
  // 采集路径不许被无障碍改写：MediaProjection 相关调用必须原样保留。
  assert.ok(module_.includes('mpm.createScreenCaptureIntent()'), 'MediaProjection 授权路径保持原样');
  // 判据用「调用形态」`takeScreenshot(` 且先剥注释：注释里说明「为什么没接入」
  // 会合法地提到这个名字。
  assert.equal(/takeScreenshot\s*\(/.test(stripKotlinComments(module_)), false,
    '模块里不得调用未核实的无障碍截屏 API');
});

test('无障碍服务类：只做状态上报，不消费事件、不截屏', () => {
  const service = kotlinSource('ScreenAccessibilityService.kt');
  assert.ok(/class ScreenAccessibilityService\s*:\s*AccessibilityService\(\)/.test(service),
    '必须是 AccessibilityService 子类');
  assert.ok(service.includes('override fun onServiceConnected()'), '缺少绑定回调');
  assert.ok(service.includes('override fun onAccessibilityEvent'), '必须实现抽象方法');
  assert.ok(service.includes('override fun onInterrupt()'), '必须实现抽象方法');
  assert.ok(service.includes('isConnected = true'), '绑定时要上报状态');
  assert.ok(service.includes('isConnected = false'), '解绑/销毁时要复位状态');
  assert.equal(/takeScreenshot\s*\(/.test(stripKotlinComments(service)), false,
    '骨架里不得调用未核实的截屏 API');
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
