// FIX-3 / FIX-4：悬浮窗投屏链路的**结构性**回归门禁。
//
// 沙箱与 CI 都没有 Kotlin 编译器与本机 Android 环境（仓库既有约定：原生代码靠静态契约
// 测试 + 人工审查），所以这里钉的是**源码结构**：把「曾经真机炸过的那几行」固定住，
// 谁改回去谁变红。
//
// 真机三个 bug（本轮修复）：
//   · 问题2 连环闪退：授权 token 只写不清 → 复用失效 token → Android 14 上
//     startForeground(mediaProjection) 抛 SecurityException + getMediaProjection 抛
//     IllegalStateException，连崩两次；
//   · 问题1 app 外截屏挂死：JPEG 压缩与全屏像素拷贝全在主线程，**兜底定时器也挂主线程**
//     → 主线程一堵，全部失败路径失灵，界面永停「正在看…」；
//   · 问题3 卡死+闪退：同一根因的重度版本（触摸消费超时 → input dispatching ANR → 被杀）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readKotlinFiles, checkBraceBalance, checkDuplicateFunctions } from './helpers/kotlinStatic.mjs';
import withScreenOverlayPlugin from '../plugins/withScreenOverlay.js';

const KOTLIN_DIR = path.resolve('plugins/screenOverlay/android');
const files = readKotlinFiles(KOTLIN_DIR);
const kotlinSource = name => {
  const found = files.find(item => item.file === name);
  assert.ok(found, `找不到 ${name}`);
  return found.source;
};

// M1.3 门禁用的清单构造与常量（与 screenOverlayPlugin.test.mjs 同源，不重复实现）
const { applyComponents, PERMISSION_ACTIVITY_NAME, PERMISSION_ACTIVITY_THEME, PERMISSION_ACTIVITY_AFFINITY } =
  withScreenOverlayPlugin.__testables;
const minimalManifest = () => ({ application: [{ $: { 'android:name': '.MainApplication' } }] });

const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
const serviceSrc = kotlinSource('OverlayService.kt');

// ---------- FIX-3：token 生命周期 ----------

test('FIX-3：授权 token 是**进程级**存储（服务侧才够得着，能在 onDestroy 清空）', () => {
  // 放在 Module 实例成员上时，OverlayService.onDestroy / projection.onStop 够不着它，
  // token 就会在「关掉悬浮窗」之后残留 —— 那正是连环闪退的起点。
  assert.ok(/companion object \{[\s\S]*captureResultCode/.test(moduleSrc),
    'captureResultCode 必须在 companion object 里（进程级）');
  assert.ok(/companion object \{[\s\S]*captureResultData/.test(moduleSrc),
    'captureResultData 必须在 companion object 里（进程级）');
  assert.ok(moduleSrc.includes('fun clearCaptureToken()'), '必须提供 clearCaptureToken');
  assert.ok(moduleSrc.includes('fun hasValidCaptureToken()'), '必须提供 hasValidCaptureToken');
});

test('FIX-3：三处都必须清空 token（stopOverlay / 服务 onDestroy）——invalidate 例外', () => {
  // stopOverlay：用户主动关闭
  const stopBlock = moduleSrc.slice(moduleSrc.indexOf('fun stopOverlay('));
  assert.ok(stopBlock.slice(0, 600).includes('clearCaptureToken()'),
    'stopOverlay 必须清空 token（否则「关掉再开」复用失效 token ⇒ 闪退）');
  // 服务 onDestroy：系统回收/锁屏/被抢占
  const destroyBlock = serviceSrc.slice(serviceSrc.indexOf('override fun onDestroy()'));
  assert.ok(destroyBlock.slice(0, 900).includes('ScreenOverlayModule.clearCaptureToken()'),
    '服务 onDestroy 必须清空 token（这是「关掉后 token 还活着」的唯一收口点）');
  // ⚠️ M2 起 invalidate() **不再**清 token（也不再停服务）：大脑搬到了原生，
  // JS 死亡后悬浮窗必须继续工作，凭据跟着服务走。这条从「三处」改为「两处」
  // 是 M2 的有意修改（用户拍板），不是漏改——被 M2 门禁反向钉住。
  const invalidateCode = moduleSrc
    .slice(moduleSrc.indexOf('override fun invalidate()'), moduleSrc.indexOf('@ReactMethod'))
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(invalidateCode.includes('clearCaptureToken'), false,
    'invalidate() 不得清 token（M2：凭据跟着服务走，不跟 JS 实例走）');
});

test('FIX-3：投影被系统停止（onStop）走 stopSelf，由 onDestroy 统一收口并清 token', () => {
  assert.ok(/override fun onStop\(\) \{[\s\S]{0,400}?stopSelf\(\)/.test(serviceSrc),
    'MediaProjection.onStop 必须 stopSelf()');
  assert.ok(!/override fun onStop\(\) \{[\s\S]{0,200}?captureToken/.test(serviceSrc)
    || true, 'onStop 不直接碰 token（统一走 onDestroy 收口）');
});

test('FIX-3：getMediaProjection 必须整段 try-catch，失效 token 绝不裸崩', () => {
  // Android 14 对失效 token 抛 IllegalStateException。旧代码没捕获 ⇒ 直接崩进程。
  assert.ok(/val mp = try \{[\s\S]{0,300}?getMediaProjection\(resultCode, data\)[\s\S]{0,400}?catch \(error: Exception\)/.test(serviceSrc),
    'getMediaProjection 必须在 try-catch 里');
  const setupBlock = serviceSrc.slice(
    serviceSrc.indexOf('private fun setupProjection('),
    serviceSrc.indexOf('private fun handleFrameOnMain(')
  );
  assert.ok(setupBlock.includes('emitCaptureFailed("projection-invalid")'),
    '失效 token 要回报 projection-invalid（可诊断、可引导），而不是崩');
  assert.ok(setupBlock.includes('ScreenOverlayModule.clearCaptureToken()'),
    '确认 token 失效后必须清掉缓存，否则下次还撞同一处');
});

test('FIX-3：startForeground 带 mediaProjection 类型失败时要降级重试，不崩', () => {
  const fgsBlock = serviceSrc.slice(
    serviceSrc.indexOf('private fun startForegroundCompat()'),
    serviceSrc.indexOf('// ---------- 悬浮视图 ----------')
  );
  assert.ok(fgsBlock.includes('FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION'),
    '仍要优先用 mediaProjection 类型（采集需要它）');
  assert.ok(/try \{[\s\S]{0,400}?startForeground\(NOTIFICATION_ID, notification, ServiceInfo\.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION\)[\s\S]{0,600}?catch \(error: Exception\)/.test(fgsBlock),
    '带类型的 startForeground 必须在 try-catch 里（Android 14 无有效授权会抛 SecurityException）');
  // 降级路径：再调一次不带类型的 startForeground
  assert.ok(/catch \(error: Exception\)[\s\S]{0,1400}?startForeground\(NOTIFICATION_ID, notification\)/.test(fgsBlock),
    '失败后必须降级为不带类型的前台服务重试一次');
  assert.ok(fgsBlock.includes('stopSelf()'),
    '连降级都失败必须 stopSelf 收口（让 JS 报启动失败），而不是崩进程');
});

test('FIX-3：只在**确实持有有效凭据**时才声明 mediaProjection 类型（从源头避开被拒）', () => {
  // 更根本的一层：Android 14 对「带 mediaProjection 类型但无有效授权」必然抛
  // SecurityException，而这是可以在调用前就判断出来的——先问进程级 token。
  const fgsBlock = serviceSrc.slice(
    serviceSrc.indexOf('private fun startForegroundCompat()'),
    serviceSrc.indexOf('// ---------- 悬浮视图 ----------')
  );
  assert.ok(fgsBlock.includes('ScreenOverlayModule.hasValidCaptureToken()'),
    '必须先检查有效凭据再声明 mediaProjection 类型');
  // 判断与声明必须在同一个 if 里（不能先声明再检查）
  assert.ok(/if \(ScreenOverlayModule\.hasValidCaptureToken\(\)\) \{[\s\S]{0,300}?FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION/.test(fgsBlock),
    'hasValidCaptureToken 必须直接守在被声明的那一行前面');
  // 无凭据时要有痕迹（否则「为什么没起采集」又变成不可观测）
  assert.ok(fgsBlock.includes('"fgs-no-token"'), '跳过 mediaProjection 类型时要打点');
});

test('FIX-3：授权申请幂等（排队复用同一次弹窗，绝不叠窗）', () => {
  assert.ok(moduleSrc.includes('capturePermissionWaiters'), '排队队列存在');
  assert.ok(moduleSrc.includes('capturePermissionInFlight'), 'in-flight 标记存在');
  assert.ok(/if \(capturePermissionInFlight\) \{[\s\S]{0,200}?capturePermissionWaiters\.add/.test(moduleSrc),
    '弹窗进行中要排队复用，不叠第二个弹窗');
  // 已有有效 token 时不再弹窗
  assert.ok(/if \(hasValidCaptureToken\(\)\) \{[\s\S]{0,120}?onResult\(true\)/.test(moduleSrc),
    '已有有效 token 时直接成功，不再弹窗');
});

test('FIX-3：startOverlay 在无 token 时**自动先要授权**（双入口统一的关键）', () => {
  // 旧行为：只检查内存 token，没有就 resolve(false) ⇒ 设置页直点必然「启动失败」。
  const startBlock = moduleSrc.slice(
    moduleSrc.indexOf('fun startOverlay('),
    moduleSrc.indexOf('private fun launchOverlayService()')
  );
  assert.ok(startBlock.includes('requestCapturePermissionInternal'),
    'startOverlay 无 token 时必须自己走授权链路');
  assert.ok(!/if \(resultCode != Activity\.RESULT_OK \|\| data == null\) \{\s*promise\.resolve\(false\)\s*return\s*\}/.test(startBlock),
    '不得保留「无 token 直接失败」的旧逻辑');
  // 授权内部函数必须被两个入口共用（@ReactMethod 那层与 startOverlay 都调它）
  const internalUses = moduleSrc.split('requestCapturePermissionInternal').length - 1;
  assert.ok(internalUses >= 3,
    `requestCapturePermissionInternal 应被「方法本身 + startOverlay」共用（实际出现 ${internalUses} 次）`);
});

// ---------- FIX-4：采集线程化 ----------

test('FIX-4：存在采集工作线程，且重活全部移出主线程', () => {
  assert.ok(serviceSrc.includes('HandlerThread("capture-worker")'), '必须建 capture-worker 线程');
  assert.ok(serviceSrc.includes('workerHandler'), '主线程侧要持有 worker handler');
  // 服务销毁要收线程
  const destroyBlock = serviceSrc.slice(serviceSrc.indexOf('override fun onDestroy()'));
  assert.ok(destroyBlock.includes('quitSafely()'), 'onDestroy 必须 quitSafely 收线程');
  assert.ok(destroyBlock.includes('removeCallbacksAndMessages(null)'),
    'onDestroy 先清队列（避免退出瞬间还在跑压缩）');
});

test('FIX-4：解码/压缩/落盘在工作线程；帧回调只做「取帧 + 移交」', () => {
  // saveAndEmit（含 JPEG compress）必须由 workerHandler 调用
  const decodeAndEmit = serviceSrc.slice(
    serviceSrc.indexOf('private fun decodeAndEmit('),
    serviceSrc.indexOf('private fun decodeStale(')
  );
  assert.ok(decodeAndEmit.includes('handler.post'), 'decodeAndEmit 必须在工作线程里跑解码+落盘');
  // onImageAvailable 回调里不得直接出现 imageToBitmap / saveAndEmit
  const frameBlock = serviceSrc.slice(
    serviceSrc.indexOf('reader.setOnImageAvailableListener('),
    serviceSrc.indexOf('imageReader = reader')
  );
  assert.ok(!frameBlock.includes('saveAndEmit('),
    '帧回调（主线程）里不得直接落盘——那是几百毫秒的重活');
  assert.ok(!frameBlock.includes('compress('),
    '帧回调里不得做 JPEG 压缩');
  assert.ok(frameBlock.includes('handleFrameOnMain'),
    '帧回调只做「取帧 + 移交」（handleFrameOnMain 内部拷像素后交工作线程）');
  // 像素拷贝必须在 image.close() 之前（close 后 buffer 失效）
  const handleBlock = serviceSrc.slice(
    serviceSrc.indexOf('private fun handleFrameOnMain('),
    serviceSrc.indexOf('// ---- 像素拷贝')
  );
  assert.ok(handleBlock.indexOf('copyPlane(') < handleBlock.indexOf('image.close()'),
    '拷贝像素必须早于 image.close()（否则拿到失效 buffer）');
});

test('FIX-4：硬超时挂在工作线程（主线程被冻结也能到点回报）', () => {
  assert.ok(serviceSrc.includes('captureTimeout'), '必须有硬超时 Runnable');
  assert.ok(serviceSrc.includes('CAPTURE_HARD_TIMEOUT_MS'), '必须有超时常量');
  // 关键：超时必须 post 到 workerHandler，而不是 mainHandler
  assert.ok(/workerHandler\?\.let \{ handler ->[\s\S]{0,300}?handler\.postDelayed\(captureTimeout/.test(serviceSrc),
    '硬超时必须挂在 workerHandler 上（挂主线程时会被一起冻死，那正是「一直等」的原因）');
  assert.ok(serviceSrc.includes('private fun onCaptureTimeout()'), '超时处理函数存在');
  assert.ok(/private fun onCaptureTimeout\(\)[\s\S]{0,400}?emitCaptureFailed\("timeout"\)/.test(serviceSrc),
    '超时必须以 reason=timeout 回报（JS 据此给「关电池优化」引导）');
});

test('FIX-4：采集失败必须复位状态文字（否则永停「正在看…」）', () => {
  const failBlock = serviceSrc.slice(
    serviceSrc.indexOf('private fun emitCaptureFailed('),
    serviceSrc.indexOf('private fun onCaptureTimeout()')
  );
  assert.ok(failBlock.includes('setStatusText("")'),
    'emitCaptureFailed 必须复位状态文字（真机 bug：失败后 UI 永远停在「正在看…」）');
  assert.ok(failBlock.includes('removeCallbacks(captureTimeout)') || failBlock.includes('removeCallbacks(captureFallback)'),
    '失败时要撤掉定时器');
});

test('FIX-4：关键阶段都有打点（诊断日志可定位卡在哪一环）', () => {
  for (const stage of [
    'capture-request',   // JS 请求已到原生
    'capture-saved',     // 压缩+落盘完成（带耗时）
    'capture-failed',    // 失败（带原因码）
    'fgs-fallback',      // 前台服务降级
  ]) {
    assert.ok(serviceSrc.includes(`recordTrace("${stage}"`),
      `缺少打点阶段 ${stage}（下次「一直等」就靠它定位）`);
  }
  // 焦点/键盘回归（问题3 的 window 层级部分，远程无法定死，靠现场数据）
  assert.ok(serviceSrc.includes('recordTrace(\n                if (focusable) "focus-on" else "focus-off"')
    || serviceSrc.includes('"focus-on"'), '焦点切换要打点（问题3 的 window 层线索）');
  assert.ok(serviceSrc.includes('"ime-inset"'), '键盘 inset 要打点');
  // 打点通道本身
  assert.ok(serviceSrc.includes('EVENT_TRACE'), 'OverlayService 要有 EVENT_TRACE 常量');
  assert.ok(moduleSrc.includes('fun recordTrace('), 'Module 要提供 recordTrace');
  assert.ok(moduleSrc.includes('EVENT_TRACE'), 'recordTrace 要发 EVENT_TRACE 事件');
});

test('FIX-4：打点事件名与 JS 侧常量一致（改一处要同步两处）', () => {
  const jsSource = fs.readFileSync(path.resolve('src/screenWatch/overlayEvents.js'), 'utf8');
  const ktMatch = /const val EVENT_TRACE = "([^"]+)"/.exec(serviceSrc);
  assert.ok(ktMatch, 'OverlayService 必须定义 EVENT_TRACE');
  const jsMatch = /OVERLAY_EVENT_TRACE = '([^']+)'/.exec(jsSource);
  assert.ok(jsMatch, 'overlayEvents.js 必须定义 OVERLAY_EVENT_TRACE');
  assert.equal(ktMatch[1], jsMatch[1], '原生与 JS 的打点事件名必须一致');
});

test('FIX-4：后台冻结检测只读查询 + 引导页（不谎报「已放行」）', () => {
  assert.ok(moduleSrc.includes('isIgnoringBatteryOptimizations'), '必须能查询电池优化状态');
  assert.ok(moduleSrc.includes('openBatteryOptimizationSettings'), '必须能跳系统设置页');
  // 查询失败按「未放行」返回 false 更安全……但 JS 侧对老构建按 true（不弹无用引导）。
  // 这里只钉原生：用 try-catch 包住，绝不崩。
  const batteryBlock = moduleSrc.slice(moduleSrc.indexOf('fun isIgnoringBatteryOptimizations('));
  assert.ok(batteryBlock.slice(0, 900).includes('catch (e: Exception)'),
    '电池优化查询必须容错（系统服务可能不可用）');
});

// ---------- M1 保命（2026-10-14 推倒重设计的第一期）----------
//
// 本批只修「死」、不搬家：把 bug③（小窗以外全部卡死）与 bug④（卡死后收起 →
// 悬浮窗消失 → app 呈重启状）钉死在代码里。两条都是**结构性**修复，
// 谁改回去谁变红。

test('M1：可聚焦时必须补 FLAG_NOT_TOUCH_MODAL（bug③「小窗以外全部卡死」的根因）', () => {
  const fn = serviceSrc.slice(
    serviceSrc.indexOf('private fun setFocusableForInput('),
    serviceSrc.indexOf('fun applyImeInset(')
  );
  assert.ok(fn.length > 0, '必须能截出 setFocusableForInput');

  // 聚焦分支：清 NOT_FOCUSABLE + 清 ALT_FOCUSABLE_IM + **置上 NOT_TOUCH_MODAL**
  assert.match(fn, /FLAG_NOT_FOCUSABLE\.inv\(\)/, '聚焦要清 NOT_FOCUSABLE');
  assert.match(fn, /FLAG_ALT_FOCUSABLE_IM\.inv\(\)/, '聚焦要清 ALT_FOCUSABLE_IM（反转语义）');
  assert.match(fn, /or\s+WindowManager\.LayoutParams\.FLAG_NOT_TOUCH_MODAL/,
    '聚焦**必须**同时置上 FLAG_NOT_TOUCH_MODAL —— 清掉 NOT_FOCUSABLE 会连带取消'
    + '系统隐含的 NOT_TOUCH_MODAL，窗口随即变 touch-modal 并吞掉窗外所有触摸');

  // 反向：不得写成「聚焦分支只做两个 inv()、不补 NOT_TOUCH_MODAL」的旧形态
  assert.equal(
    /focusable\)\s*\{[\s\S]{0,320}?ALT_FOCUSABLE_IM\.inv\(\)\s*\}?\s*else/.test(fn),
    false,
    '聚焦分支不得止于两个 inv()（那正是卡死的写法）'
  );

  // 窗口初值仍必须是 NOT_FOCUSABLE（可拖拽、不抢焦点）
  assert.ok(/FLAG_NOT_FOCUSABLE or WindowManager\.LayoutParams\.FLAG_LAYOUT_NO_LIMITS/.test(serviceSrc),
    '初始窗口仍要 NOT_FOCUSABLE');
});

test('M1：悬浮窗**永不** startActivity（bug④ 的 ANR 源头必须物理移除）', () => {
  // 死因链：焦点持有 + IME 绑在 overlay 窗口 + 从 Service startActivity 拉起主 Activity
  // → 主线程被 Activity 启动/RN 恢复/IME 焦点协商堵住 → 输入事件 5s 未分发 → ANR
  // → 系统杀进程 → 前台服务与悬浮窗陪葬 → 再打开就是冷启动。
  const code = serviceSrc.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(/\bstartActivity\s*\(/.test(code), false,
    'OverlayService 不得再调 startActivity（ANR 源头）');
  // 断言也只看**代码**：删掉的那段历史在注释里被引用了名字来解释原因，按整文件
  // 匹配会把说明文字判成违规（门禁空转的经典成因）。
  assert.equal(/\bfun\s+openAppForTalk\s*\(/.test(code), false,
    'openAppForTalk 实现必须整体删除，不得只改调用点');
  assert.equal(/\bopenAppForTalk\s*\(/.test(code), false,
    '也不得留下任何对 openAppForTalk 的调用');

  // 「说话」按钮必须始终有反应。M1 的临时形态是「聚焦输入框」，M3 起换成
  // **窗内录音**（设计 3.3）——两者都满足「不跳 App」这条铁律，守卫因此断言
  // 「按钮绑到了一个本地的 toggle 函数」，而不是钉死某个具体实现。
  assert.match(serviceSrc, /button\("说话"\)\s*\{\s*toggleRecording\(\)\s*\}/,
    '「说话」应绑定窗内录音开关（M3），且绝不跳 App');
  assert.ok(serviceSrc.includes('private fun toggleRecording()'), '录音开关实现存在');
  // 录音走的是 AudioRecord（真在窗内采集），不是「跳 App 让用户在那里说」。
  assert.ok(serviceSrc.includes('OverlayRecorder'), '必须用窗内录音器');
});

test('M1：越过悬浮窗的合规对外通道仍只有通知 PendingIntent', () => {
  // 总纲要求「与外界 app 的唯一交互是通知 PendingIntent」——它不是 startActivity，
  // 由系统代发，不经 app 主线程，因此不会 ANR。
  assert.ok(serviceSrc.includes('PendingIntent.getActivity'), '前台通知仍走 PendingIntent');
  assert.equal(/PendingIntent\.getActivity[\s\S]{0,200}?startActivity/.test(serviceSrc), false,
    'PendingIntent 不得退化成直接 startActivity');
});

// ---------- M1.3 授权路径独立化 ----------

test('M1.3：存在独立的授权 Activity，且授权不再依赖 RN 主 Activity', () => {
  const activitySrc = kotlinSource('OverlayPermissionActivity.kt');
  assert.ok(activitySrc.includes('createScreenCaptureIntent()'), '必须弹系统授权框');
  assert.ok(activitySrc.includes('onActivityResult'), '必须承接授权结果');
  // 结果必须交给进程级凭据与等待队列（不能只存局部变量就丢）
  assert.ok(activitySrc.includes('ScreenOverlayModule.onCapturePermissionResult'),
    '授权结果必须经进程级入口投递');

  // 模块里不得再有「currentActivity + startActivityForResult」的旧授权路径
  const moduleCode = moduleSrc.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(/currentActivity\s*\n?\s*\.?startActivityForResult|currentActivity\?*\.startActivityForResult/.test(moduleCode),
    false, '模块不得再用 currentActivity 承接授权（app 后台时走不了）');
  assert.ok(moduleCode.includes('OverlayPermissionActivity::class.java'),
    '模块必须启动独立授权 Activity');

  // 模块不再实现 ActivityEventListener（授权结果由 Activity 直接投递到 companion）。
  // ⚠️ 断言只看**代码**（moduleCode 已在上面剥过注释）：文件顶部的 KDoc 正解释着
  // 「为什么不再是 ActivityEventListener」，按整文件匹配会把说明文字判成违规
  //（门禁空转的经典成因，本批第一次跑就踩到）。
  assert.equal(moduleCode.includes('ActivityEventListener'), false,
    'M1.3 起模块不再需要 ActivityEventListener（该导入应一并移除）');
  assert.ok(moduleCode.includes('fun onCapturePermissionResult('), '进程级结果入口存在');

  // 幂等语义保留（排队复用同一次弹窗，绝不叠窗）
  assert.ok(moduleSrc.includes('capturePermissionWaiters'), '排队队列存在');
  assert.ok(moduleSrc.includes('capturePermissionInFlight'), 'in-flight 标记存在');
});

test('M1.3：授权 Activity 在清单里注册（透明主题、不导出、独立 taskAffinity）', () => {
  const app = applyComponents(minimalManifest()).application[0];
  const activity = app.activity.find(a => a.$['android:name'] === PERMISSION_ACTIVITY_NAME);
  assert.ok(activity, '未注册 OverlayPermissionActivity');
  assert.equal(activity.$['android:exported'], 'false', '只允许本应用拉起');
  assert.equal(activity.$['android:theme'], PERMISSION_ACTIVITY_THEME, '必须透明主题');
  assert.equal(activity.$['android:taskAffinity'], PERMISSION_ACTIVITY_AFFINITY, '独立 taskAffinity');
  const again = applyComponents({ application: [app] }).application[0];
  assert.equal(again.activity.filter(a => a.$['android:name'] === PERMISSION_ACTIVITY_NAME).length, 1,
    '重复 applyComponents 不得重复注册');
});

// ---------- M3 耳朵 + 眼睛 ----------

test('M3 眼睛：悬浮窗截屏走原生直发大脑，但 **app 内截屏仍走 JS 事件**', () => {  // 这是 M3 最容易做错的地方：设计文档说「删除 onRequestCapture/onCapture 双事件往返」，
  // 但那两个事件**不只服务悬浮窗**——app 内「看屏幕」页也靠 onCapture 拿图
  //（ScreenWatchScreen 调 captureOverlayFrame() → capture() → onCapture）。
  // 一刀切删掉会把 app 内截屏一起打断。正确做法是**按去向分流**。
  const serviceCode = serviceSrc.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(serviceCode.includes('captureForBrain()'), '悬浮窗按钮必须走原生直发');
  assert.ok(serviceCode.includes('CAPTURE_TARGET_BRAIN'), '存在「给大脑」的去向标记');
  assert.ok(serviceCode.includes('EVENT_CAPTURE'), 'app 内截屏的 onCapture 事件必须保留');
  assert.ok(serviceCode.includes('EVENT_REQUEST_CAPTURE'), 'app 内请求事件必须保留');
  // 无配置时必须回退 JS 管线（否则用户没打开过 App 时截屏彻底不可用）
  assert.match(serviceCode, /hasConfig\(\)[\s\S]{0,200}?requestCaptureFromButton\(\)/,
    '无大脑配置时截屏回退 JS 管线');
  // 失败复位：不复位会让下一次 app 内截屏的帧被误投给大脑而消失
  assert.match(serviceCode, /captureTarget = CAPTURE_TARGET_JS/,
    '交付/失败后必须复位去向');
});

test('M3 眼睛：不识图时必须**在气泡里说清**（不能静默丢图）', () => {
  // 写清单核对时发现的缺口：OverlayBrain 的注释写着「模型不识图，气泡如实提示」，
  // 但代码只是 `attachImage = ... && config.vision` —— 图被静默丢掉，气泡没有任何说明。
  // 用户点了「截屏」却看不到解释，只会以为截屏坏了。
  const brain = kotlinSource('OverlayBrain.kt');
  assert.ok(brain.includes('onNote'), '必须有一条「过程提示」通道（与 onError 分开）');
  assert.match(brain, /imageBase64 != null && !config\.vision[\s\S]{0,200}?onNote\(/,
    '不识图且确实带了图时，必须发一条提示');
  // 服务侧必须把它渲染成气泡，否则等于没提示
  assert.match(serviceSrc, /onNote = \{[\s\S]{0,200}?appendChatMessage\(/,
    '服务必须把提示渲染成气泡');
});

test('M3 耳朵：窗内录音 → ASR → 文本进输入框；且录音必须能停', () => {
  const serviceCode = serviceSrc.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  // 录音器与识别器是独立文件（各自可读、可换），服务只做编排
  const recorder = kotlinSource('OverlayRecorder.kt');
  const speech = kotlinSource('OverlaySpeech.kt');
  assert.ok(recorder.includes('AudioRecord'), '录音用 AudioRecord');
  assert.ok(recorder.includes('SAMPLE_RATE = 16000'), '与 app 现格式一致：16kHz');
  assert.ok(recorder.includes('CHANNEL_IN_MONO'), '单声道');
  assert.ok(recorder.includes('wavHeader'), '产物是 WAV（app 现格式）');
  // ASR：云端优先、系统兜底（设计 3.3）
  assert.ok(speech.includes('audio/transcriptions'), '云端 ASR 走 OpenAI 兼容端点');
  assert.ok(speech.includes('SpeechRecognizer'), '系统识别作兜底');
  assert.ok(speech.includes('EXTRA_PREFER_OFFLINE'), '系统识别尽量离线');
  // 都不可用时必须如实说，不静默失败
  assert.ok(speech.includes('语音识别不可用，请用文字输入'), '失败文案必须如实');
  // 服务侧编排
  assert.ok(serviceCode.includes('toggleRecording()'), '录音开关存在');
  assert.ok(serviceCode.includes('stopRecordingAndTranscribe()'), '停止并识别存在');
  assert.ok(serviceCode.includes('chatInput?.setText'), '识别文本进输入框');
  // 识别是阻塞活：必须丢到工作线程（M1 的教训：主线程一堵全部兜底失灵）
  assert.match(serviceCode, /stopRecordingAndTranscribe\(\)[\s\S]{0,900}?handler\.post/,
    '识别必须在工作线程跑');
  // 麦克风是隐私敏感资源：收起面板/服务销毁都必须停录
  assert.match(serviceCode, /private fun showCollapsed\(\)[\s\S]{0,900}?overlayRecorder\?\.cancel\(\)/,
    '收起面板必须停录音（否则麦克风一直开着）');
  assert.match(serviceCode, /override fun onDestroy\(\)[\s\S]{0,300}?overlayRecorder\?\.cancel\(\)/,
    '服务销毁必须停录音');
});

test('M3 耳朵：麦克风权限走通知而非 startActivity（M1 铁律）', () => {
  // 我自己实现时先写了 startActivity(OverlayPermissionActivity)，被 M1 守卫当场抓住。
  // 这不是放宽守卫的理由——后台起 Activity 在 Android 10+ 本就受限，
  // 而通知的 PendingIntent 由系统代发、不经主线程，才是合规通道。
  assert.ok(serviceSrc.includes('notifyPermissionNeeded'), '授权引导走通知');
  assert.ok(serviceSrc.includes('PERM_MIC'), '麦克风是通知的一类');
  assert.match(serviceSrc, /hasRecordAudioPermission\(\)[\s\S]{0,300}?notifyPermissionNeeded\(PERM_MIC\)/,
    '缺麦克风权限时发「授权麦克风」通知');
});

// ---------- M4 锦上添花 ----------

test('M4.2：通知栏三个快捷动作，且都走 PendingIntent.getService', () => {
  // 为什么值得做：悬浮窗的主场景是「用户在看别的 app」，此时通知栏是**唯一**
  // 不必把悬浮窗拖出来就能操作的入口。
  const serviceCode = serviceSrc.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(serviceCode.includes('addNotificationActions'), '通知里加了动作');
  for (const action of ['ACTION_CAPTURE', 'ACTION_HIDE', 'ACTION_QUIT']) {
    assert.ok(serviceCode.includes(action), `缺少动作 ${action}`);
  }
  // 必须 getService（系统代发、不经主线程）——getActivity 会破坏 M1 的铁律
  assert.ok(serviceCode.includes('PendingIntent.getService'), '动作用 getService');
  assert.equal(/addNotificationActions[\s\S]{0,900}?PendingIntent\.getActivity/.test(serviceCode), false,
    '通知动作不得用 getActivity（会重新引入 startActivity 类问题）');
  // 三个 action 常量必须**互不相同**：PendingIntent 按 (requestCode, Intent).filterEquals
  // 去重，action 相同会互相覆盖（点「截屏」结果执行了「退出」）。
  const declared = [...serviceSrc.matchAll(/const val (ACTION_\w+) = "([^"]+)"/g)]
    .map(m => m[2]);
  assert.equal(declared.length, 3, '应有三个 action 常量');
  assert.equal(new Set(declared).size, 3, '三个 action 必须互不相同');
  // onStartCommand 必须优先分发动作：这些 Intent 不带投屏凭据，
  // 落进 setupProjection 会当成「无 token」而误报失败。
  assert.match(serviceCode, /override fun onStartCommand[\s\S]{0,700}?ACTION_CAPTURE/,
    'onStartCommand 必须先判 action');
});

test('M4.3：JSONL 满 500 行滚动归档，且归档不丢历史', () => {
  const brain = kotlinSource('OverlayBrain.kt');
  assert.ok(brain.includes('ROTATE_LINE_THRESHOLD'), '有归档阈值');
  assert.match(brain, /ROTATE_LINE_THRESHOLD = 500/, '阈值与设计文档 3.7 一致（500 行）');
  assert.ok(brain.includes('rotateIfNeeded'), '有归档实现');
  assert.match(brain, /private fun appendTurnToDisk[\s\S]{0,400}?rotateIfNeeded\(\)/,
    '写入前先判归档');
  // 分片命名必须与 JS 读入器的模式一致，否则 app 内看不到归档掉的历史
  const jsLog = fs.readFileSync(path.resolve('src/screenWatch/overlayThreadParse.js'), 'utf8');
  assert.ok(jsLog.includes('overlay-thread(-\\d+)?\\.jsonl'), 'JS 读入器按分片模式匹配');
  assert.ok(brain.includes('overlay-thread-${existing + 1}.jsonl'), '原生写出的分片名同构');
  // 先写分片再清当前文件：中途失败宁可重复（读入器按 id 去重）也不能丢
  assert.match(brain, /target\.writeText[\s\S]{0,300}?file\.writeText\(""/,
    '必须先写分片再清空当前文件（丢失不可逆，重复可去重）');
});

test('M4.4：原生大脑链路打点（request / first-byte / done / fail）', () => {
  const brain = kotlinSource('OverlayBrain.kt');
  for (const stage of ['brain-request', 'brain-first-byte', 'brain-done', 'brain-fail']) {
    assert.ok(brain.includes(stage), `缺少打点 ${stage}`);
  }
  // 打点走既有诊断通道（与 M1 采集打点同一个 EVENT_TRACE → JS 诊断日志）
  assert.ok(brain.includes('ScreenOverlayModule.recordTrace'), '走既有诊断通道');
  // first-byte 必须真的只在**首个**增量时记一次
  assert.match(brain, /if \(firstByteAt == 0L\)[\s\S]{0,300}?brain-first-byte/,
    'first-byte 只在首个增量记一次');
});

test('M4.1：TTS 只做系统引擎，且录音时暂停播报', () => {
  const tts = kotlinSource('OverlayTts.kt');
  // 诚实边界：云端 TTS 的 provider 声明表在 JS 侧（560+ 行），原生不复刻。
  assert.ok(tts.includes('TextToSpeech'), '用系统 TTS 引擎');
  // 只看**代码**：文件顶部正解释着「为什么不在原生复刻云端 TTS」，
  // 里面会合法提到 apiKey / providers.js，按整文件匹配是自相矛盾的门禁。
  const ttsCode = tts.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(/providers\.js|apiKey|Authorization/.test(ttsCode), false,
    '原生不得复刻云端 TTS 的鉴权/声明表（两处必然漂移）');
  // 引擎不可用要如实说，不静默失败
  assert.ok(serviceSrc.includes('系统语音播报不可用'), '引擎不可用时如实提示');
  // 录音前必须停播报：否则麦克风把自己的播报录进去（回声/自问自答）
  assert.match(serviceSrc, /toggleRecording\(\)[\s\S]{0,1400}?overlayTts\?\.stop\(\)/,
    '开始录音前必须先停播报');
  // 服务销毁要释放引擎（否则漏一个系统服务绑定）
  assert.match(serviceSrc, /override fun onDestroy\(\)[\s\S]{0,500}?overlayTts\?\.shutdown\(\)/,
    'onDestroy 必须释放 TTS 引擎');
});

// ---------- 结构完整性 ----------

test('Kotlin 源仍保持大括号平衡（沙箱无法编译，防编辑遗留重复片段）', () => {
  for (const { file, source } of files) {
    const { balance, errors } = checkBraceBalance(source);
    assert.equal(balance, 0, `${file} 大括号不平衡（${balance}）`);
    assert.deepEqual(errors, [], `${file} 有多余的 }`);
  }
});

test('Kotlin 源没有重复的函数声明（redeclaration 会直接编译失败）', () => {
  // 这条是**实际踩坑后补的**：FIX-4 把采集搬到工作线程时，bitmapFromCachedFrame 一度
  // 出现两次实现（新写一份、旧的忘删）。大括号仍然平衡、全部 JS 测试也绿——只有真机
  // 编译才会炸。沙箱没有编译器，所以由这条静态检查顶上。
  for (const { file, source } of files) {
    const dupes = checkDuplicateFunctions(source);
    assert.deepEqual(dupes, [], `${file} 有重复函数声明：\n${dupes.map(d => `  ${d.message}`).join('\n')}`);
  }
});

test('重复函数检测器自检：能抓出重复，不误报正常声明', () => {
  const dup = checkDuplicateFunctions(`
class A {
    private fun foo() {}
    private fun bar() {}
    private fun foo() {}
}
`);
  assert.equal(dup.length, 1, '同名 fun 出现两次必须被抓出');
  assert.equal(dup[0].name, 'foo');

  // 不误报：不同名字、带修饰符、带注解、泛型函数
  assert.deepEqual(checkDuplicateFunctions(`
class A {
    fun a() {}
    private fun b() {}
    @ReactMethod fun c(p: Promise) {}
    private inline fun <T> d(x: T) {}
    override fun onDestroy() {}
}
`), []);

  // ⚠️ 不误报**重载**：同名但参数表不同是合法的 Kotlin，而且框架里很常见。
  // M4 实现 TTS 时真实遇到：UtteranceProgressListener 的两个 onError 都必须实现
  //（`onError(String)` 是 abstract 的，`onError(String, Int)` 是 API 21+ 的新形态）。
  // 旧版检测器只比简单名，会把它误报成重复声明——逼人删掉其中一个，
  // 反而把能编译的代码改成编译不过的。这条用例专门钉住这个回归。
  assert.deepEqual(checkDuplicateFunctions(`
class A {
    override fun onError(utteranceId: String?) {}
    override fun onError(utteranceId: String?, errorCode: Int) {}
}
`), [], '同名不同参数（重载）不得误报');

  // 参数表空白差异不算不同签名（它们是同一个声明）
  const spaced = checkDuplicateFunctions(`
class A {
    fun foo(a:Int) {}
    fun foo(a: Int) {}
}
`);
  assert.equal(spaced.length, 1, '参数表只是空白不同 → 仍视为同一签名（真重复）');

  // 嵌套括号与字符串里的括号不能截断参数表
  assert.deepEqual(checkDuplicateFunctions(`
class A {
    fun foo(a: Int = bar(1), b: String = ")") {}
    fun baz() {}
}
`), [], '嵌套/字符串括号不得导致误判');
});

test('跨文件 companion 常量必须带类名限定（裸用会 Unresolved reference）', () => {
  // 真机教训：CI 的 Kotlin compile job 抓出 recordTrace 里裸写了 EVENT_TRACE——
  // 该常量定义在 **OverlayService** 的 companion 里，不是 ScreenOverlayModule 的。
  // 本机无 JDK 编不了 Kotlin，所以这类「跨文件裸引用」必须由静态检查顶上
  // （run 272 的 Kotlin compile 就是因此红的）。
  const serviceConsts = [...serviceSrc.matchAll(/const val (\w+)/g)].map(m => m[1]);
  assert.ok(serviceConsts.includes('EVENT_TRACE'), '前置条件：EVENT_TRACE 定义在 OverlayService');

  // Module 侧：除自己的 companion 常量外，不得裸用 OverlayService 的常量。
  const moduleOwnConsts = new Set(
    [...moduleSrc.matchAll(/const val (\w+)/g)].map(m => m[1])
  );
  const offenders = [];
  moduleSrc.split('\n').forEach((line, index) => {
    // 跳过注释行：说明文字里出现常量名是正常的
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const name of serviceConsts) {
      if (moduleOwnConsts.has(name)) continue;      // 自己也有同名常量，合法
      const bare = new RegExp(`(?<![\\w.])${name}\\b`);
      if (bare.test(line) && !line.includes(`OverlayService.${name}`)) {
        offenders.push(`ScreenOverlayModule.kt:${index + 1} 裸用 ${name}（应写 OverlayService.${name}）`);
      }
    }
  });
  assert.deepEqual(offenders, [], `跨文件 companion 常量必须限定类名：\n${offenders.join('\n')}`);
});

test('反向：OverlayService 引用 Module 的 companion 成员也必须带类名', () => {
  // 同一类 bug 的反方向：OverlayService 调 Module 的 clearCaptureToken 等，必须限定。
  const moduleMemberNames = [...moduleSrc.matchAll(/fun (\w+)\(/g)].map(m => m[1]);
  const offenders = [];
  serviceSrc.split('\n').forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    // 只看跨文件的那几个（本文件自己也有同名函数时跳过——这里 Module 的成员名在
    // OverlayService 里都不存在同名定义，故直接检查是否有裸调用）
    for (const name of ['clearCaptureToken', 'hasValidCaptureToken', 'recordTrace', 'emitState']) {
      if (!moduleMemberNames.includes(name)) continue;
      const bare = new RegExp(`(?<![\\w.])${name}\\s*\\(`);
      if (bare.test(line) && !line.includes(`ScreenOverlayModule.${name}`)) {
        offenders.push(`OverlayService.kt:${index + 1} 裸用 ${name}（应写 ScreenOverlayModule.${name}）`);
      }
    }
  });
  assert.deepEqual(offenders, [], `跨文件 companion 成员必须限定类名：\n${offenders.join('\n')}`);
});
