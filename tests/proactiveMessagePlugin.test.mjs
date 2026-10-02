import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  checkBraceBalance,
  checkPackageConsistency,
  checkUniqueDeclarations,
  findUnusedImports,
  readAllKotlin,
  readKotlinFiles,
} from './helpers/kotlinStatic.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KOTLIN_DIR = path.join(HERE, '..', 'plugins', 'proactiveMessage', 'android');
const KOTLIN_PACKAGE = 'com.pppxxxy.easychat2.proactive';

const readAllKotlinSource = () => readAllKotlin(KOTLIN_DIR);
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

test('Gradle 依赖注入幂等且包含 work-runtime-ktx 与 security-crypto', () => {
  const input = 'android {\n}\n\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n';
  const once = applyGradleDependencies(input);
  assert.match(once, /implementation\("androidx\.work:work-runtime-ktx:2\.9\.1"\)/);
  // apiKey 走 EncryptedSharedPreferences，需要 security-crypto
  assert.match(once, /implementation\("androidx\.security:security-crypto:1\.1\.0-alpha06"\)/);
  const twice = applyGradleDependencies(once);
  assert.equal(twice, once);
});

test('Gradle 依赖注入：仅缺一条时只补缺失的那条', () => {
  // 已注入 work-runtime、缺 security-crypto：只补后者，不重复前者
  const partial = 'dependencies {\n    implementation("androidx.work:work-runtime-ktx:2.9.1")\n}\n';
  const out = applyGradleDependencies(partial);
  assert.equal(out.match(/androidx\.work:work-runtime-ktx/g).length, 1);
  assert.equal(out.match(/androidx\.security:security-crypto/g).length, 1);
  // 反向：已有 security-crypto、缺 work-runtime
  const partial2 = 'dependencies {\n    implementation("androidx.security:security-crypto:1.1.0-alpha06")\n}\n';
  const out2 = applyGradleDependencies(partial2);
  assert.equal(out2.match(/androidx\.work:work-runtime-ktx/g).length, 1);
  assert.equal(out2.match(/androidx\.security:security-crypto/g).length, 1);
});

test('MainApplication 补丁注册 ProactiveMessagePackage（SDK 50 模板）且幂等', () => {
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

test('MainApplication 补丁注册 ProactiveMessagePackage（SDK 54 apply 模板）', () => {
  // SDK 53+ 模板是 `PackageList(this).packages.apply { ... }`，没有 return；
  // 旧正则匹配不到会静默只插 import 不注册，必须把 add 放进 apply 块内。
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '        override fun getPackages(): List<ReactPackage> =',
    '            PackageList(this).packages.apply {',
    '              // add(MyReactNativePackage())',
    '            }',
  ].join('\n');
  const once = applyMainApplicationPatch(input);
  assert.match(once, /import com\.pppxxxy\.easychat2\.proactive\.ProactiveMessagePackage/);
  assert.match(once, /add\(ProactiveMessagePackage\(\)\)/);
  // 必须真的在 apply 块内注册，而不是只 import
  assert.equal(/import com\.pppxxxy\.easychat2\.proactive\.ProactiveMessagePackage/.test(once), true);
  assert.equal(/\badd\(ProactiveMessagePackage\(\)\)/.test(once), true);
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
  const config = { name: 'x' };
  assert.equal(typeof plugin(config), 'object');
});

test('Kotlin 源码不使用不存在的系统 action 常量', () => {
  const source = readAllKotlinSource();
  // 这两个标识符在 Android SDK 中不存在，曾是真实的编译失败原因
  assert.ok(!source.includes('Settings.ACTION_BATTERY_OPTIMIZATION_SETTINGS'));
  assert.ok(!source.includes('Intent.ACTION_TIME_SET'));
  // 对应的正确常量必须存在
  assert.ok(source.includes('Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS'));
  assert.ok(source.includes('Intent.ACTION_TIME_CHANGED'));
});

test('Kotlin 源码大括号平衡（沙箱无法编译，防编辑遗留重复片段）', () => {
  // 曾经因为一次编辑留下重复的 `}` 片段导致 CI 编译失败（Expecting a top level declaration）。
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const { balance, errors } = checkBraceBalance(source);
    for (const error of errors) {
      assert.fail(`${file}:${error.line} ${error.message}`);
    }
    assert.equal(balance, 0, `${file} 大括号不平衡`);
  }
});

test('Kotlin 包名一致且无未使用导入（共享静态校验）', () => {
  const packageErrors = checkPackageConsistency(KOTLIN_DIR, KOTLIN_PACKAGE);
  for (const error of packageErrors) {
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

test('Kotlin 顶层声明不重复定义', () => {
  const source = readAllKotlin(KOTLIN_DIR);
  const errors = checkUniqueDeclarations(source, ['enum class MessageType', 'enum class ScheduleMode', 'object FallbackMessages']);
  for (const error of errors) {
    assert.fail(error.message);
  }
});

test('同一角色多时间以 slotId 为唯一标识，不按 roleId 覆盖', () => {
  const source = readAllKotlinSource();
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
  const source = readAllKotlinSource();
  assert.match(source, /onStartCommand\([^)]*\): Int\s*\{/);
  assert.ok(source.includes('START_NOT_STICKY'));
});

test('原生暴露权限状态查询（勾/叉/问号数据源）', () => {
  const module = readAllKotlinSource();
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
  const source = readAllKotlinSource();
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
  const source = readAllKotlinSource();
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
  const source = readAllKotlinSource();
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

test('requestJson 时间占位符在触发时由原生替换（不固化保存时刻）', () => {
  const core = readFileSync(
    path.join(KOTLIN_DIR, 'ProactiveCore.kt'),
    'utf8'
  );
  // JS 快照写 {{proactive_now}}，原生发送前替换成触发时刻
  assert.ok(core.includes('"{{proactive_now}}"'), '缺少时间占位符常量');
  assert.ok(core.includes('fun substituteProactiveTime'), '缺少占位符替换函数');
  assert.ok(core.includes('substituteProactiveTime(messages)'), '发送前必须调用替换');
  assert.ok(core.includes('WEEKDAY_CHARS'), '缺少周字表（与 JS 周日~周六对齐）');
  // 简版回退的问好仍按触发时段选早/中/晚（不受占位符方案影响）
  assert.ok(core.includes('in 5..11'), 'fallback 问好时段逻辑被误删');
});

test('ProactiveCore：apiKey 走 EncryptedSharedPreferences，不再默认明文落盘', () => {
  const core = readFileSync(path.join(KOTLIN_DIR, 'ProactiveCore.kt'), 'utf8');
  assert.ok(core.includes('import androidx.security.crypto.EncryptedSharedPreferences'), '缺 EncryptedSharedPreferences 导入');
  assert.ok(core.includes('import androidx.security.crypto.MasterKey'), '缺 MasterKey 导入');
  assert.ok(core.includes('MasterKey.KeyScheme.AES256_GCM'), '应使用 AES256_GCM 主密钥');
  assert.ok(core.includes('SECRET_PREFS'), '应有独立加密 prefs 文件名');
  // 加密失败/不可用时降级明文，且读写都兜异常，不能因加密异常崩溃
  assert.ok(core.includes('fun writeSecretApiKey'), '缺加密写入 helper');
  assert.ok(core.includes('fun readSecretApiKey'), '缺加密读取 helper');
  assert.ok(core.includes('降级明文'), '应有降级路径');
  // 历史明文迁移：读到旧明文 apiKey 后搬入加密区并删除明文
  assert.ok(core.includes('prefs.edit().remove(KEY_API_KEY)'), '迁移后应删除明文 apiKey');
});

test('通知：新渠道弹横幅 + 角色头像 + 单色小图标去圈 i', () => {
  const source = readAllKotlinSource();
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
  const source = readAllKotlinSource();
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

test('原生 JS 桥改用 JSON 字符串契约（新架构 Interop 下数组编组不可靠）', () => {
  const module = readFileSync(
    path.join(KOTLIN_DIR, 'ProactiveMessageModule.kt'),
    'utf8'
  );
  // consumePendingMessages 返回 JSON 字符串，而非 WritableArray
  assert.ok(module.includes('JSONArray()'), '应构造 JSONArray');
  assert.match(module, /promise\.resolve\(json\)/, '应 resolve 字符串');
  assert.match(module, /promise\.resolve\("\[\]"\)/, '异常兜底应回空数组 JSON');
  assert.ok(!module.includes('Arguments.createArray()'), '不应再回传 WritableArray');
  // ackPendingMessages 入参是字符串（JSON），不是 ReadableArray
  assert.match(module, /fun ackPendingMessages\(idsJson: String, promise: Promise\)/);
  assert.ok(module.includes('JSONArray(idsJson)'), '应解析入参 JSON');
  assert.ok(!module.includes('ReadableArray'), '不应再依赖 ReadableArray');
  // release 可见日志：供 adb logcat 确认 JS 是否调进来、取到几条
  assert.ok(module.includes('Log.i(TAG, "consume pending n='), '缺少 consume 日志');
  assert.ok(module.includes('Log.i(TAG, "ack pending n='), '缺少 ack 日志');
});
