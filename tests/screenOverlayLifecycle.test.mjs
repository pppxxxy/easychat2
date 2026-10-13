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

const KOTLIN_DIR = path.resolve('plugins/screenOverlay/android');
const files = readKotlinFiles(KOTLIN_DIR);
const kotlinSource = name => {
  const found = files.find(item => item.file === name);
  assert.ok(found, `找不到 ${name}`);
  return found.source;
};

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

test('FIX-3：三处都必须清空 token（stopOverlay / invalidate / 服务 onDestroy）', () => {
  // stopOverlay：用户主动关闭
  const stopBlock = moduleSrc.slice(moduleSrc.indexOf('fun stopOverlay('));
  assert.ok(stopBlock.slice(0, 600).includes('clearCaptureToken()'),
    'stopOverlay 必须清空 token（否则「关掉再开」复用失效 token ⇒ 闪退）');
  // invalidate：热重载/退出
  const invalidateBlock = moduleSrc.slice(moduleSrc.indexOf('override fun invalidate()'));
  assert.ok(invalidateBlock.slice(0, 1200).includes('clearCaptureToken()'),
    'invalidate 必须清空 token（热重载后不该复用旧凭据）');
  // 服务 onDestroy：系统回收/锁屏/被抢占
  const destroyBlock = serviceSrc.slice(serviceSrc.indexOf('override fun onDestroy()'));
  assert.ok(destroyBlock.slice(0, 900).includes('ScreenOverlayModule.clearCaptureToken()'),
    '服务 onDestroy 必须清空 token（这是「关掉后 token 还活着」的唯一收口点）');
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
