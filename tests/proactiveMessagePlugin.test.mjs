import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KOTLIN_DIR = path.join(HERE, '..', 'plugins', 'proactiveMessage', 'android');

function readAllKotlin() {
  return readdirSync(KOTLIN_DIR)
    .filter(f => f.endsWith('.kt'))
    .map(f => readFileSync(path.join(KOTLIN_DIR, f), 'utf8'))
    .join('\n');
}
const plugin = require('../plugins/withProactiveMessage.js');
const {
  PERMISSIONS,
  BOOT_ACTIONS,
  applyPermissions,
  applyComponents,
  applyGradleDependencies,
  applyMainApplicationPatch,
} = plugin.__testables;

function minimalManifest() {
  return { application: [{ $: { 'android:name': '.MainApplication' } }] };
}

test('权限清单覆盖通知/重启/精确闹钟/前台服务/dataSync 五项', () => {
  for (const required of [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.SCHEDULE_EXACT_ALARM',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  ]) {
    assert.ok(PERMISSIONS.includes(required), `缺少权限 ${required}`);
  }
});

test('applyPermissions 能注入且幂等', () => {
  const manifest = applyPermissions(minimalManifest());
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length);
  applyPermissions(manifest);
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length);
});

test('组件注册：接收器非导出、BootReceiver 监听重启事件、前台服务类型 dataSync', () => {
  const app = applyComponents(minimalManifest()).application[0];

  const alarm = app.receiver.find(r => r.$['android:name'] === '.proactive.AlarmReceiver');
  assert.equal(alarm.$['android:exported'], 'false');

  const boot = app.receiver.find(r => r.$['android:name'] === '.proactive.BootReceiver');
  assert.equal(boot.$['android:exported'], 'false');
  const actions = boot['intent-filter'][0].action.map(a => a.$['android:name']);
  assert.deepEqual(actions, BOOT_ACTIONS);
  assert.ok(actions.includes('android.intent.action.BOOT_COMPLETED'));
  assert.ok(actions.includes('android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED'));

  const service = app.service.find(
    s => s.$['android:name'] === '.proactive.MessageForegroundService'
  );
  assert.equal(service.$['android:exported'], 'false');
  assert.equal(service.$['android:foregroundServiceType'], 'dataSync');

  // 幂等
  const again = applyComponents({ application: [app] }).application[0];
  assert.equal(again.receiver.length, 2);
  assert.equal(again.service.length, 1);
});

test('Gradle 依赖注入幂等且包含 work-runtime-ktx', () => {
  const input = 'android {\n}\n\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n';
  const once = applyGradleDependencies(input);
  assert.match(once, /implementation\("androidx\.work:work-runtime-ktx:2\.9\.1"\)/);
  const twice = applyGradleDependencies(once);
  assert.equal(twice, once);
});

test('MainApplication 补丁注册 ProactiveMessagePackage 且幂等', () => {
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '          override fun getPackages(): List<ReactPackage> {',
    '            return PackageList(this).packages',
    '          }',
  ].join('\n');
  const once = applyMainApplicationPatch(input);
  assert.match(once, /import com\.pppxxxy\.easychat2\.proactive\.ProactiveMessagePackage/);
  assert.match(once, /packages\.add\(ProactiveMessagePackage\(\)\)/);
  assert.equal(applyMainApplicationPatch(once), once);
});

test('插件本体返回 config 对象', () => {
  const config = { name: 'x' };
  assert.equal(typeof plugin(config), 'object');
});

test('Kotlin 源码不使用不存在的系统 action 常量', () => {
  const source = readAllKotlin();
  // 这两个标识符在 Android SDK 中不存在，曾是真实的编译失败原因
  assert.ok(!source.includes('Settings.ACTION_BATTERY_OPTIMIZATION_SETTINGS'));
  assert.ok(!source.includes('Intent.ACTION_TIME_SET'));
  // 对应的正确常量必须存在
  assert.ok(source.includes('Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS'));
  assert.ok(source.includes('Intent.ACTION_TIME_CHANGED'));
});

test('同一角色多时间以 slotId 为唯一标识，不按 roleId 覆盖', () => {
  const source = readAllKotlin();
  // 去重、WorkManager 唯一名、闹钟 requestCode 都必须按槽区分
  assert.ok(source.includes('resolvedSlotId'));
  assert.ok(source.includes('isSlotSentToday'));
  assert.match(source, /uniqueName\(slotId: String\)/);
  assert.ok(source.includes('cancelRole'));
  // roleId 级别去重会让多时间槽只剩第一个能发，禁止出现
  assert.ok(!source.includes('isSentToday(roleId)'));
  assert.ok(!source.includes('markSentToday(roleId)'));
});

test('前台服务 onStartCommand 显式返回 Int', () => {
  const source = readAllKotlin();
  assert.match(source, /onStartCommand\([^)]*\): Int\s*\{/);
  assert.ok(source.includes('START_NOT_STICKY'));
});

test('原生暴露权限状态查询（勾/叉/问号数据源）', () => {
  const module = readAllKotlin();
  assert.ok(module.includes('fun getPermissionStatus(promise: Promise)'));
  assert.ok(module.includes('Notifier.canNotify(reactContext)'));
  // 自启动白名单无公开可读接口 → null（JS 侧显示问号）
  assert.ok(module.includes('result.putNull("autostart")'));
});
