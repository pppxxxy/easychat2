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

test('Kotlin 源码大括号平衡（沙箱无法编译，防编辑遗留重复片段）', () => {
  // 曾经因为一次编辑留下重复的 `}` 片段导致 CI 编译失败（Expecting a top level declaration）。
  for (const file of readdirSync(KOTLIN_DIR).filter(f => f.endsWith('.kt'))) {
    const source = readFileSync(path.join(KOTLIN_DIR, file), 'utf8');
    let balance = 0;
    let inString = false;
    let inTriple = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (!inString && !inTriple && source.slice(i, i + 3) === '"""') {
        inTriple = true;
        i += 2;
        continue;
      }
      if (inTriple && source.slice(i, i + 3) === '"""') {
        inTriple = false;
        i += 2;
        continue;
      }
      if (inTriple) continue;
      if (!inString && ch === '"') {
        inString = true;
        continue;
      }
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '{') balance += 1;
      else if (ch === '}') balance -= 1;
      assert.ok(balance >= 0, `${file} 出现多余的 }`);
    }
    assert.equal(balance, 0, `${file} 大括号不平衡`);
  }
});

test('Kotlin 顶层声明不重复定义', () => {
  const source = readAllKotlin();
  for (const keyword of ['enum class MessageType', 'enum class ScheduleMode', 'object FallbackMessages']) {
    const count = source.split(keyword).length - 1;
    assert.equal(count, 1, `${keyword} 应恰好定义一次，实际 ${count}`);
  }
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

test('pendingRoleId/listenerCount 跨线程访问加锁，且启动 intent 有兜底抓取', () => {
  const module = readFileSync(
    path.join(KOTLIN_DIR, 'ProactiveMessageModule.kt'),
    'utf8'
  );
  // UI 线程（onHostResume/onNewIntent）与 NativeModules 队列线程（consumeInitialRole/
  // addListener）都会读写这两个字段；缺锁会出现角色丢失的竞态。
  assert.ok(module.includes('private val lock = Any()'), '缺少同步锁');
  const lockUses = module.match(/synchronized\(lock\)/g) || [];
  assert.ok(lockUses.length >= 4, `synchronized(lock) 使用次数过少：${lockUses.length}`);
  // 冷启动时 currentActivity 可能晚于 onHostResume 就绪：init 与 addListener 都要兜底抓 intent
  assert.ok(module.includes('private fun captureLaunchIntent()'), '缺少启动 intent 兜底抓取');
  const captures = module.match(/captureLaunchIntent\(\)/g) || [];
  assert.ok(captures.length >= 3, `captureLaunchIntent 调用点过少：${captures.length}`);
  assert.ok(module.includes('intent.removeExtra(Notifier.EXTRA_ROLE_ID)'), '抓到后应清 extra 防重复');
});

test('主动消息落库：发送前写待写队列，通知被拒不阻断', () => {
  const source = readAllKotlin();
  // Sender 必须在发通知前 appendPendingMessage（消息存在性不依赖通知权限）
  assert.ok(source.includes('data class PendingMessage'), '缺少 PendingMessage 结构');
  assert.ok(source.includes('fun appendPendingMessage'), '缺少入队方法');
  const appendIndex = source.indexOf('appendPendingMessage(');
  const notifyIndex = source.indexOf('Notifier.sendRoleMessage(');
  assert.ok(appendIndex > 0 && notifyIndex > 0, '缺少入队或发通知调用');
  assert.ok(appendIndex < notifyIndex, '必须先落队再发通知');
  // 队列有界且有超期淘汰
  assert.ok(source.includes('MAX_PENDING'));
  assert.ok(source.includes('MAX_PENDING_AGE_MS'));
  // 幂等 id：slotId + 日期
  assert.ok(source.includes('resolvedSlotId') && source.includes('yyyy-MM-dd'));
});

test('主动消息类型：原生 messageType/customPrompt 与按时段问好', () => {
  const source = readAllKotlin();
  assert.ok(source.includes('enum class MessageType'), '缺少 MessageType 枚举');
  for (const type of ['DEFAULT', 'CARE', 'GREETING', 'CUSTOM']) {
    assert.ok(source.includes(type), `缺少消息类型 ${type}`);
  }
  // 问好按触发时段选早/中/晚
  assert.ok(source.includes('in 5..11') || source.includes('5..11'), '缺少早间时段');
  assert.ok(source.includes('customPrompt'), '缺少自定义提示词字段');
  const module = readFileSync(
    path.join(KOTLIN_DIR, 'ProactiveMessageModule.kt'),
    'utf8'
  );
  assert.ok(module.includes('MessageType.valueOf'), '模块未解析 messageType');
});

test('主动消息优先用 JS 组装的完整请求（requestJson）', () => {
  const source = readAllKotlin();
  // 槽带 requestJson 字段，发送时优先解析它，解析失败回退简版提示词
  assert.ok(source.includes('val requestJson: String'), '缺少 requestJson 字段');
  assert.ok(source.includes('fun parseRequestJson'), '缺少 requestJson 解析');
  const module = readFileSync(
    path.join(KOTLIN_DIR, 'ProactiveMessageModule.kt'),
    'utf8'
  );
  assert.ok(module.includes('requestJson'), '模块未读取 requestJson');
  // 解析失败必须回退（不能直接崩）
  assert.ok(source.includes('?.let { AiApiClient().generateProactiveMessage'), '调用链异常');
});

test('通知：新渠道弹横幅 + 角色头像 + 单色小图标去圈 i', () => {
  const source = readAllKotlin();
  // 新渠道 ID：旧渠道重要性被系统固定，只能新建
  assert.ok(source.includes('"proactive_message_v2"'), '应换新渠道 ID');
  assert.ok(source.includes('CATEGORY_MESSAGE'), '应设消息类别以允许横幅');
  // 角色头像：Person.setIcon + setLargeIcon
  assert.ok(source.includes('setLargeIcon'), '应设大图标（角色头像）');
  assert.ok(source.includes('createWithBitmap'), 'Person 应带头像');
  assert.ok(source.includes('avatarUri'), '槽应带 avatarUri');
  // 单色小图标：用自带 drawable，不再用系统 ic_dialog_info
  assert.ok(source.includes('R.drawable.ic_stat_proactive'), '应用自带小图标');
  assert.ok(!source.includes('android.R.drawable.ic_dialog_info'), '不应再用系统圈 i 图标');
  // 插件注入该 drawable
  const plugin = require('../plugins/withProactiveMessage.js');
  const pluginSrc = readFileSync(
    path.join(HERE, '..', 'plugins', 'withProactiveMessage.js'),
    'utf8'
  );
  assert.ok(pluginSrc.includes('ic_stat_proactive.xml'), '插件应注入单色图标');
  assert.ok(typeof plugin === 'function');
});

test('重新保存槽会清「今天已发」标记，当天可再次触发', () => {
  const source = readAllKotlin();
  assert.ok(source.includes('fun clearSlotSentToday'), '缺少清除标记方法');
  // upsertSchedule 内必须调用它
  const upsert = source.match(/fun upsertSchedule[\s\S]*?\n    \}/);
  assert.ok(upsert, '未找到 upsertSchedule');
  assert.ok(upsert[0].includes('clearSlotSentToday'), 'upsertSchedule 应清除已发标记');
});

test('原生 JS 桥：取出待写队列并提供 ack 删除', () => {
  const module = readFileSync(
    path.join(KOTLIN_DIR, 'ProactiveMessageModule.kt'),
    'utf8'
  );
  assert.ok(module.includes('fun consumePendingMessages(promise: Promise)'));
  assert.ok(module.includes('fun ackPendingMessages('));
  // consume 不清空，落库成功才 ack；否则写失败无法重试
  assert.ok(!/consumePendingMessages[\s\S]{0,800}removePendingMessages/.test(module),
    'consumePendingMessages 不应直接清空队列');
});
