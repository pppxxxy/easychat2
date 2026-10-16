// FEAT-AC10：投屏授权链兜底——修「点快后永久加载」。
//
// 来源：用户 14:57–15:00 真机复现 + 诊断日志 + 截图 #427。
// 对码基线 HEAD=e1b8fe8（AC9）。三层死锁（全部对码核实）：
//   BUG-F1【native 根因】授权 Activity 异常死亡时等待者永不结算
//     —— 它此前只有 onActivityResult 一个出口；onCreate 在 savedInstanceState != null 时
//        静默 return 等「系统重投结果」，ROM 若不重投就永远等不到。
//        日志反证：连 permission-denied 都没有 ⇒ deliver 从未运行。
//   BUG-F2【JS 连锁】模块级 in-flight 把重挂载后的重试也吞了
//     —— busy 是组件 state（重挂载归零 ⇒ 按钮能点），但再点拿到的是悬挂的旧 Promise。
//   BUG-F3【观察性】整条授权链零打点 ⇒ 只能靠「日志里什么都没有」反推。
//
// 测试分工（仓库纪律）：能真跑的纯逻辑真跑；native 无编译器（沙箱/CI 都没 Kotlin），
// 靠**源码结构断言**钉住（见 tests/screenOverlayLifecycle.test.mjs 的同款做法）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { readKotlinFiles } from './helpers/kotlinStatic.mjs';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const overlayPath = path.resolve('src/screenWatch/overlay.js');

const KOTLIN_DIR = path.resolve('plugins/screenOverlay/android');
const files = readKotlinFiles(KOTLIN_DIR);
const kotlinSource = name => {
  const found = files.find(item => item.file === name);
  assert.ok(found, `找不到 ${name}`);
  return found.source;
};

// 精确截取一个 Kotlin 函数体：从**定义点**（`declStart` 必须是声明前缀，避免命中调用点）
// 起，到下一个同缩进层级的声明为止。
//
// 为什么必须有这个工具：本仓反复踩过「窗口开宽了划进相邻代码 → 断言假阳性/假阴性」
//（AC10 的注入验证就抓到两处：`recoverStaleCaptureRequestIfNeeded` 的名字在文件里
// 出现两次，从调用点起取窗口会划进函数体）。按定义点定位 + 按声明边界收口才可靠。
function kotlinBody(source, declStart) {
  const start = source.indexOf(declStart);
  assert.ok(start >= 0, `找不到声明 ${declStart}`);
  const rest = source.slice(start);
  // 函数体结束：下一个同缩进（4 空格）的 `private fun` / `override fun` / `fun` / `@JvmStatic`
  const nextDecl = rest.slice(1).search(/\n    (?:@JvmStatic\s*\n\s*)?(?:private |public |internal )?(?:override )?fun /);
  return nextDecl > 0 ? rest.slice(0, nextDecl + 1) : rest;
}

// 用打桩的 NativeModules / DeviceEventEmitter / diagnostics 加载真实 overlay.js（babel → CJS）。
// 与 tests/screenOverlayStartChain.test.mjs 同一套写法（避免第二套 harness 各自漂移），
// 额外把 diagnostics 单独接出来，断言「打点真的落了」。
function loadOverlay({ module, listeners = new Map() } = {}) {
  const nativeModules = module === undefined ? {} : { ScreenOverlay: module };
  const transformed = babel.transformSync(fs.readFileSync(overlayPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: overlayPath,
    presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  const diagnostics = [];
  Module._load = function patched(request, parent, isMain) {
    if (request === 'react-native') {
      return {
        NativeModules: nativeModules,
        DeviceEventEmitter: {
          addListener: (event, handler) => {
            listeners.set(event, handler);
            return { remove: () => listeners.delete(event) };
          },
        },
      };
    }
    if (request.endsWith('/diagnostics.js')) {
      return { recordDiagnostic: (kind, error, context) => diagnostics.push({ kind, error, context }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(overlayPath);
  runtime.filename = overlayPath;
  runtime.paths = Module._nodeModulePaths(path.dirname(overlayPath));
  try {
    runtime._compile(transformed, overlayPath);
  } finally {
    Module._load = originalLoad;
  }
  return { exports: runtime.exports, diagnostics, listeners };
}

// ---------- ① JS 兜底超时（P0-3）——真跑，用 mock timers ----------

// 排空微任务队列（runStartChain 里有 await canDrawOverlays() → startOverlay 两级）。
// mock timers 接管了 setTimeout，所以这里用同步微任务而不是 setImmediate。
async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test('P0-3：启动链超时后**释放 in-flight**，下一次点击必须真正重新发起', async (t) => {
  // 这是 BUG-F2 的直接回归：真机上「切回来能点、点了照样永远加载」正是因为
  // 模块级 in-flight 永不释放，而组件 busy 重挂载即归零。
  const started = [];
  const module = {
    canDrawOverlays: async () => true,
    // 永不 resolve：模拟「原生队列永真，startOverlay 永不返回」
    startOverlay: () => new Promise(() => { started.push('called'); }),
    stopOverlay: async () => true,
    isOverlayActive: async () => false,
  };
  const { exports } = loadOverlay({ module });

  // mock timers：接管 setTimeout，让 5 分钟在测试里瞬间到达。
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = exports.ensurePermissionThenStart();
  // 链路里有 await（先查悬浮窗权限，再调 startOverlay），必须排空微任务后才真正发起。
  await flushMicrotasks();
  assert.equal(started.length, 1, '第一次点击要真的发起');

  // 推进到超时点
  t.mock.timers.tick(exports.START_CHAIN_TIMEOUT_MS + 1);
  const result = await pending;
  assert.equal(result.ok, false, '超时必须按失败结算');
  assert.equal(result.timeout, true, '必须带 timeout 标记（界面据此说「启动超时」）');
  assert.equal(result.reason, exports.OVERLAY_START_RESULT.START_FAILED);
});

test('P0-3：超时后 in-flight 已释放 → 第二次点击真的重新发起（不再拿旧 Promise）', async (t) => {
  let calls = 0;
  const module = {
    canDrawOverlays: async () => true,
    // 第一次永不返回；第二次立刻成功 —— 精确模拟「卡死后重试能成」
    startOverlay: () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return Promise.resolve(true);
    },
    stopOverlay: async () => true,
    isOverlayActive: async () => false,
  };
  const { exports } = loadOverlay({ module });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const first = exports.ensurePermissionThenStart();
  await flushMicrotasks();
  t.mock.timers.tick(exports.START_CHAIN_TIMEOUT_MS + 1);
  const firstResult = await first;
  assert.equal(firstResult.timeout, true, '前置：第一次超时');

  // 关键断言：第二次是**全新一次调用**（calls 递增），而不是复用那份悬挂的旧 Promise。
  const second = exports.ensurePermissionThenStart();
  const secondResult = await second;
  assert.equal(calls, 2, '第二次必须真的重新发起（in-flight 已释放）');
  assert.equal(secondResult.ok, true, '第二次应成功——这正是「超时后重试有效」的用户价值');
});

test('P0-3：并发/连点仍复用同一次链路（超时包装不得破坏既有幂等）', async (t) => {
  let calls = 0;
  const module = {
    canDrawOverlays: async () => true,
    startOverlay: async () => { calls += 1; return true; },
    stopOverlay: async () => true,
    isOverlayActive: async () => false,
  };
  const { exports } = loadOverlay({ module });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const [a, b, c] = await Promise.all([
    exports.ensurePermissionThenStart(),
    exports.ensurePermissionThenStart(),
    exports.ensurePermissionThenStart(),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(calls, 1, '三次并发只该真正发起一次（连点不叠系统弹窗）');
});

test('P0-3：正常成功**不留悬挂计时器**（否则每轮都留一个 5 分钟的表）', async (t) => {
  const module = {
    canDrawOverlays: async () => true,
    startOverlay: async () => true,
    stopOverlay: async () => true,
    isOverlayActive: async () => false,
  };
  const { exports, diagnostics } = loadOverlay({ module });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const result = await exports.ensurePermissionThenStart();
  assert.equal(result.ok, true);
  // 真正要防的是「表一直挂着」：若成功时没撤表，推进 5 分钟后会**多触发一次超时结算**
  //（打点里会出现 overlay-start-chain-timeout）。这里断言它没发生——这才是本条的目的。
  t.mock.timers.tick(exports.START_CHAIN_TIMEOUT_MS + 1);
  assert.equal(
    diagnostics.some(item => item.error.message.includes('overlay-start-chain-timeout')),
    false,
    '成功路径必须撤掉兜底计时器（否则每完成一轮都留一个 5 分钟的表，并可能误报超时）'
  );
  // 链路结束后仍可重新发起（标记已释放）
  const again = await exports.ensurePermissionThenStart();
  assert.equal(again.ok, true, '成功链路结束后必须能再次发起');
});

test('P0-3：超时阈值必须 **> native 看门狗**（比例关系不能倒）', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  const ktMatch = /CAPTURE_PERMISSION_WATCHDOG_MS\s*=\s*([^/\n]+)/.exec(moduleSrc);
  assert.ok(ktMatch, 'native 必须有看门狗阈值常量');
  // 解析 Kotlin 的 `3 * 60 * 1000L` 形式（只含数字与运算符，用 Function 求值是安全的）
  const ktExpr = ktMatch[1].replace(/L/g, '').trim();
  assert.match(ktExpr, /^[\d\s*+]+$/, `阈值表达式应只含数字与运算符，实际 ${ktExpr}`);
  const nativeMs = Function(`return (${ktExpr});`)();
  assert.ok(Number.isFinite(nativeMs) && nativeMs > 0, `native 阈值应可解析，实际 ${ktMatch[1]}`);
  const jsMs = 5 * 60 * 1000;
  assert.ok(jsMs > nativeMs,
    `JS 超时（${jsMs}ms）必须大于 native 看门狗（${nativeMs}ms）：`
    + '否则 JS 先放弃并清掉 in-flight，而原生队列还挂着，用户重试会排队进那个死轮次');
  // overlay.js 里的常量也要与这个数一致
  const js = fs.readFileSync(overlayPath, 'utf8');
  assert.match(js, /START_CHAIN_TIMEOUT_MS = 5 \* 60 \* 1000/, 'JS 超时阈值应为 5 分钟');
});

// ---------- ② JS 侧打点（P0-4）——真跑，断言真的落了诊断 ----------

test('P0-4：JS 侧记录「发起/返回」与「超时」，两侧时间线可对表', async () => {
  const module = {
    canDrawOverlays: async () => true,
    startOverlay: async () => true,
    stopOverlay: async () => true,
    isOverlayActive: async () => false,
  };
  const { exports, diagnostics } = loadOverlay({ module });
  await exports.ensurePermissionThenStart();
  const messages = diagnostics.map(item => `${item.error.message}|${item.context}`);
  assert.ok(messages.some(m => m.includes('overlay-start-chain-native') && m.includes('dispatching')),
    `必须记录「已发起」: ${JSON.stringify(messages)}`);
  assert.ok(messages.some(m => m.includes('overlay-start-chain-native') && m.includes('returned')),
    `必须记录「已返回」: ${JSON.stringify(messages)}`);
  // 例行打点不得带堆栈（AC5 P0-C 的分级纪律：{ message } 对象而非 new Error）
  for (const item of diagnostics) {
    assert.equal(typeof item.error, 'object', '打点必须传对象（{ message }），而不是 new Error');
    assert.equal(item.error.stack, undefined, '例行打点不得带堆栈（否则真错误会被埋）');
  }
});

test('P0-4：超时也要留痕（JS 先于 native 放弃的唯一证据）', async (t) => {
  const module = {
    canDrawOverlays: async () => true,
    startOverlay: () => new Promise(() => {}),
    stopOverlay: async () => true,
    isOverlayActive: async () => false,
  };
  const { exports, diagnostics } = loadOverlay({ module });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = exports.ensurePermissionThenStart();
  await flushMicrotasks();
  t.mock.timers.tick(exports.START_CHAIN_TIMEOUT_MS + 1);
  await pending;
  assert.ok(diagnostics.some(item => item.error.message.includes('overlay-start-chain-timeout')),
    `超时必须留痕: ${JSON.stringify(diagnostics.map(d => d.error.message))}`);
});

test('P0-4：授权链打点用**独立命名空间**，不与采集链的 capture-request 撞名', () => {
  // ⚠️ 核实发现的一处任务书用词问题：任务书要求打点叫 capture-request / capture-settled，
  // 但 `capture-request` **已经存在**（OverlayService.kt 里表示「一帧采集被请求」，
  // 与授权毫无关系）。沿用同名会让日志里两种事件无法区分——恰恰破坏本轮「一眼看出
  // 死在哪一米」的目的。故授权链统一走 `overlay-permission-` 前缀。
  //
  // ⚠️ 断言必须限定在**授权链的函数体内**：文件里别处合法地存在 `capture-settled`
  // 这类字样所在的 stale-result 打点与采集链常量名，按整文件 `includes` 判会因为
  // 别的匹配而通过（注入验证抓到过这个假阳性）。
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  const requestFn = kotlinBody(moduleSrc, 'private fun requestCapturePermissionInternal(');
  const recoverFn = kotlinBody(moduleSrc, 'private fun recoverStaleCaptureRequestIfNeeded(');
  const resultFn = kotlinBody(moduleSrc, 'fun onCapturePermissionResult(');
  const destroyFn = kotlinBody(moduleSrc, 'fun onPermissionActivityDestroyed(');
  // settled 打点在统一结算出口里（唯一出口，见 §④ 的幂等断言）
  const settleFn = kotlinBody(moduleSrc, 'private fun settleCapturePermissionWaiters(');
  const chain = `${requestFn}\n${recoverFn}\n${resultFn}\n${destroyFn}\n${settleFn}`;
  for (const stage of [
    'overlay-permission-request',
    'overlay-permission-settled',
    'overlay-permission-watchdog',
    'overlay-permission-stale-result',
  ]) {
    assert.ok(chain.includes(stage), `授权链缺少打点阶段 ${stage}`);
  }
  // 授权链**不得**直接使用采集链的事件名（那会让两种事件在日志里混成一种）
  assert.equal(/recordTrace\("capture-/.test(chain), false,
    '授权链不得复用采集链的 capture-* 事件名（同名会让日志无法区分）');
  // 采集链的既有打点仍在（不得为了新打点把它改掉）
  const serviceSrc = kotlinSource('OverlayService.kt');
  assert.ok(serviceSrc.includes('recordTrace("capture-request"'), '采集链的 capture-request 必须原样保留');
});

// ---------- ③ native 兜底（P0-1）——源码结构断言（沙箱无 Kotlin 编译器）----------

test('P0-1：授权 Activity 有**死亡兜底**（onDestroy 结算 + 一次性标志 + 排除配置变更）', () => {
  const activitySrc = kotlinSource('OverlayPermissionActivity.kt');
  // 一次性标志：正常路径（onActivityResult → deliver → finish → onDestroy）不得重复投递
  assert.ok(activitySrc.includes('private var delivered = false'), '必须有一次性 delivered 标志');
  // onDestroy 兜底
  assert.match(activitySrc, /override fun onDestroy\(\) \{[\s\S]{0,400}?if \(delivered \|\| isChangingConfigurations\) return/,
    'onDestroy 必须在「已交付」或「配置变更」时提前返回（幂等）');
  // 配置变更必须排除：系统会把结果重投给新实例，此刻结算会把正常流程误判成失败
  assert.match(activitySrc, /override fun onDestroy\(\) \{[\s\S]{0,400}?isChangingConfigurations/,
    'onDestroy 必须排除配置变更（否则正常流程会被误判为失败）');
  // 兜底入口
  assert.match(activitySrc, /onPermissionActivityDestroyed\(permissionEpoch\)/,
    'onDestroy 必须调进程级兜底入口');
  // deliver 必须置标志（否则 onDestroy 会重复结算）
  assert.match(activitySrc, /private fun deliver\([\s\S]{0,300}?delivered = true/,
    'deliver 必须置一次性标志');
  // 兜底自身绝不抛（正在销毁的空壳，抛错会把进程带走）
  assert.match(activitySrc, /onDestroy\(\)[\s\S]{0,900}?catch \(error: Exception\)/,
    'onDestroy 兜底必须 try-catch');
});

test('P0-1：进程级兜底入口存在，且判决为**拒绝**（问不到用户 = 不执行）', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  assert.match(moduleSrc, /fun onPermissionActivityDestroyed\(epoch: Long\)/,
    '必须有进程级兜底入口');
  // 结算为 false（拒绝方向），且带可诊断的原因码
  assert.match(moduleSrc, /onPermissionActivityDestroyed[\s\S]{0,500}?"activity-destroyed-without-result"/,
    '兜底要带原因码（下次真机一眼看出是谁结算的）');
  assert.match(moduleSrc, /onPermissionActivityDestroyed[\s\S]{0,400}?settleCapturePermissionWaiters\(false/,
    '兜底必须按**拒绝**结算（不能静默放行）');
});

test('P0-1：麦克风环节同源（该 Activity 兼管两环，一个兜底覆盖两者）', () => {
  const activitySrc = kotlinSource('OverlayPermissionActivity.kt');
  // 两环共用同一个出口：onRequestPermissionsResult（mic）与 onActivityResult（capture）
  // 都最终经由 finish() → onDestroy；delivered 只在 deliver() 里置位，
  // 所以 mic 环节中死亡时 delivered 仍是 false ⇒ 兜底生效。
  assert.ok(activitySrc.includes('onRequestPermissionsResult'), 'mic 环节仍在同一 Activity');
  assert.ok(activitySrc.includes('startCapturePermissionFlow'), 'capture 环节仍在同一 Activity');
  // onDestroy 兜底不得只在 capture 分支里（必须是实例级，两个环节都覆盖）。
  // ⚠️ 必须精确取到 onDestroy 的**函数体**：窗口取宽了会滑进下一个函数
  //（hasRecordAudioPermission），把无关代码当成违规——那正是我第一版踩的假阳性。
  const start = activitySrc.indexOf('override fun onDestroy()');
  assert.ok(start >= 0, 'onDestroy 应存在');
  const rest = activitySrc.slice(start);
  // 函数体终点：下一个顶层 `private fun` / `override fun`
  const nextDecl = rest.slice(1).search(/\n    (?:private|override|public) fun /);
  const destroyBody = nextDecl > 0 ? rest.slice(0, nextDecl + 1) : rest;
  assert.ok(destroyBody.includes('onPermissionActivityDestroyed'), '前置：确实截到了 onDestroy 函数体');
  assert.equal(/hasRecordAudioPermission|REQUEST_CAPTURE\b/.test(destroyBody), false,
    'onDestroy 兜底不得按环节分支（一个兜底覆盖 mic + capture 两环）');
});

// ---------- ④ native 看门狗（P0-2）——源码结构断言 ----------

test('P0-2：看门狗只在**新请求进来时**惰性检查（不额外起计时线程）', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  assert.match(moduleSrc, /fun recoverStaleCaptureRequestIfNeeded\(\)/,
    '必须有看门狗函数');
  // 在请求入口处调用（而不是起 Timer/HandlerThread 常驻线程）
  assert.match(moduleSrc, /requestCapturePermissionInternal[\s\S]{0,900}?recoverStaleCaptureRequestIfNeeded\(\)/,
    '看门狗必须在 requestCapturePermissionInternal 里被调用');
  // 不得引入常驻计时线程
  assert.equal(/Timer\(|scheduleAtFixedRate|HandlerThread\("permission/.test(moduleSrc), false,
    '看门狗不得额外起常驻计时线程（悬浮窗是常驻的，为一个可能不发生的故障养线程不划算）');
  // 判据是「发起时刻 + 阈值」
  assert.ok(moduleSrc.includes('captureRequestStartedAt'), '必须记录本轮发起时刻');
  assert.match(moduleSrc, /CAPTURE_PERMISSION_WATCHDOG_MS/, '必须有阈值常量');
});

test('P0-2：看门狗回收要**留痕**且原因码可辨（watchdog-recovered）', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  assert.match(moduleSrc, /overlay-permission-watchdog/,
    '看门狗回收必须留痕（否则「为什么突然好了」也无从解释）');
  // 回收的是「上一轮」的等待者：清 in-flight 后由调用方按失败结算
  assert.match(moduleSrc, /recoverStaleCaptureRequestIfNeeded\(\)[\s\S]{0,200}?forEach/,
    '回收出的等待者必须被结算（不能取出来就丢）');
});

test('P0-2：结算出口**只有一个**（幂等，不重复投递）', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  // flushCapturePermissionWaiters 已并入 settleCapturePermissionWaiters（单一出口）
  assert.equal(/fun flushCapturePermissionWaiters/.test(moduleSrc), false,
    '旧的 flush 必须并入统一出口（两个出口必然在某个分支上漂移）');
  assert.match(moduleSrc, /private fun settleCapturePermissionWaiters\(/,
    '必须有统一结算出口');
  // 出口内部：清 in-flight + 取走并清空队列 + 锁外回调
  assert.match(moduleSrc, /settleCapturePermissionWaiters\([\s\S]{0,900}?capturePermissionInFlight = false/,
    '结算必须清 in-flight');
  assert.match(moduleSrc, /settleCapturePermissionWaiters\([\s\S]{0,1400}?waiters\.forEach \{ it\(granted\) \}/,
    '结算必须唤醒全部等待者');
});

// ---------- ⑤ 迟到结果必须失效（epoch 校验）----------
//
// 这一条不在任务书里，是实现 P0-2 时**必须**补的：看门狗把超时轮判死、用户又发起了
// 新一轮之后，旧 Activity 仍可能迟到地投回结果（系统重投、或它其实没死只是慢）。
// 没有 epoch 校验时，那条迟到结果会结算掉**新一批**等待者——用户刚点出来的授权框
// 被当成已拒绝，界面恢复正常却拿不到凭据。这比原故障更难查。

test('epoch：native 侧发放/带回/校验轮次序号', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  const activitySrc = kotlinSource('OverlayPermissionActivity.kt');
  assert.ok(moduleSrc.includes('capturePermissionEpoch'), '必须有序号状态');
  assert.match(moduleSrc, /putExtra\(EXTRA_CAPTURE_EPOCH, epoch\)/, '发起时必须把序号交给 Activity');
  assert.match(activitySrc, /getLongExtra\(ScreenOverlayModule\.EXTRA_CAPTURE_EPOCH/,
    'Activity 必须从 Intent 取序号（配置变更后 extra 仍在）');
  assert.match(activitySrc, /onCapturePermissionResult\(resultCode, data, failure, permissionEpoch\)/,
    'Activity 必须把序号带回结果入口');
  assert.match(moduleSrc, /fun onCapturePermissionResult\([\s\S]{0,200}?epoch: Long = 0L/,
    '结果入口必须接受序号参数');
  // 迟到判定：不符即丢弃 + 留痕
  assert.match(moduleSrc, /epoch != 0L && epoch != capturePermissionEpoch[\s\S]{0,400}?overlay-permission-stale-result/,
    '迟到结果必须被丢弃并留痕');
  // 看门狗判死时也要自增序号，使本轮彻底失效。
  //
  // ⚠️ 必须**精确取函数体**再断言：这个函数的**名字在文件里出现两次**（调用点 + 定义点），
  // 从第一次出现（调用点）起取一个固定窗口会划进函数体、命中函数内那行自增——
  // 于是「把函数体里那行删掉」时断言依旧通过（注入验证抓到过这个假阳性）。
  const fn = kotlinBody(moduleSrc, 'private fun recoverStaleCaptureRequestIfNeeded(');
  assert.ok(fn.includes('capturePermissionEpoch += 1'),
    '看门狗判死时必须自增序号（否则迟到结果会误结算新一轮）');
  assert.ok(fn.includes('capturePermissionWaiters.clear()'), '前置：确实截到了看门狗函数体');
});

test('epoch：兼容旧调用（默认 0 = 不校验），不破坏既有 M1.3 门禁', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  // 默认参数保证既有调用点（若还有）不会因签名变化而编译失败
  assert.match(moduleSrc, /failure: String\? = null,\s*\n\s*epoch: Long = 0L/,
    'epoch 必须有默认值（向后兼容）');
  // M1.3 的既有契约仍在：排队复用、不叠弹窗
  assert.ok(moduleSrc.includes('capturePermissionWaiters'), '排队队列仍在');
  assert.ok(moduleSrc.includes('capturePermissionInFlight'), 'in-flight 标记仍在');
  assert.match(moduleSrc, /if \(capturePermissionInFlight\) \{[\s\S]{0,300}?capturePermissionWaiters\.add/,
    '弹窗进行中仍要排队复用（连点不叠窗的既有行为不得回退）');
});

// ---------- ⑥ 界面文案：超时是独立一档 ----------

test('超时文案：两入口都用独立词条（不与「投屏授权失败」混为一谈）', () => {
  for (const locale of ['zh-CN', 'en']) {
    const dict = fs.readFileSync(path.resolve(`src/i18n/locales/${locale}/workspaceWatch.js`), 'utf8');
    assert.ok(dict.includes("'workspace.watch.startTimeout'"), `${locale} 缺 startTimeout 词条`);
  }
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ScreenWatchPanel.js'), 'utf8');
  assert.match(panel, /result\.timeout === true[\s\S]{0,200}?workspace\.watch\.startTimeout/,
    '面板必须单独处理超时');
  const screen = fs.readFileSync(path.resolve('src/screenWatch/ScreenWatchScreen.js'), 'utf8');
  assert.match(screen, /result\.timeout === true[\s\S]{0,200}?workspace\.watch\.startTimeout/,
    '扩展页必须单独处理超时');
});

// ---------- ⑧ 静态可判定的**编译期**风险（CI 抓到的两类，本地必须提前拦）----------
//
// 这一组是 CI 教训的直接产物：本轮第一次推送 `Kotlin compile (prebuild)` **失败**，
// 而本地 lint/测试/结构门禁全绿。原因是 settleCapturePermissionWaiters 加了第三个参数
// 后，有一处旧调用点仍按两参调用——Kotlin 编译错误，而文本层的大括号/重复函数检查
// 都看不见。沙箱无编译器，所以按**可文本判定**的规则把这两类补成守卫。

test('编译期风险：所有 settleCapturePermissionWaiters 调用都必须满足参数个数', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  // ⚠️ 必须从**签名**算出「必填个数」与「上限个数」，不能写死常量：
  // 本轮 CI 失败的原因正是「签名加了第三个参数（无默认值），而旧调用点仍传两个」。
  // 只封一个 1..3 的区间是抓不到这种错的——必须知道哪几个参数**没有默认值**。
  const signature = /private fun settleCapturePermissionWaiters\(([\s\S]*?)\)\s*:\s*Boolean/.exec(moduleSrc);
  assert.ok(signature, '必须能解析 settleCapturePermissionWaiters 的签名');
  const params = signature[1].split(',').map(s => s.trim()).filter(Boolean)
    .map(param => ({ text: param, hasDefault: /=/.test(param) }));
  const required = params.filter(p => !p.hasDefault).length;
  const max = params.length;
  assert.ok(required >= 1, `签名的必填参数个数异常: ${required}`);

  const calls = [...moduleSrc.matchAll(/settleCapturePermissionWaiters\(([^)]*)\)/g)]
    .filter(m => !m[0].includes('private fun'));
  assert.ok(calls.length >= 3, `应至少有 3 处调用点，实际 ${calls.length}`);
  for (const call of calls) {
    const args = call[1].split(',').map(s => s.trim()).filter(Boolean);
    const line = moduleSrc.slice(0, call.index).split('\n').length;
    assert.ok(args.length >= required && args.length <= max,
      `第 ${line} 行调用传了 ${args.length} 个参数，签名要求 ${required}~${max} 个`
      + `（必填 ${required} 个：${params.filter(p => !p.hasDefault).map(p => p.text).join(' | ')}）: ${call[0]}`);
  }
});

test('编译期风险：参数有默认值的形参必须排在无默认值之后（Kotlin 要求）', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  // 逐个多行参数表检查：一旦出现「有默认值」后面又跟「无默认值」，Kotlin 编译失败。
  const decls = [...moduleSrc.matchAll(/(?:private |public |internal )?fun \w+\(([\s\S]*?)\)\s*[:{]/g)];
  for (const decl of decls) {
    const params = decl[1].split(',').map(s => s.trim()).filter(Boolean)
      // 跳过嵌套注解/泛型里可能的逗号：本项目参数表简单，按顶层逗号切分足够
      .filter(s => !s.startsWith('@'));
    let sawDefault = false;
    for (const param of params) {
      const hasDefault = /=\s*[^=]/.test(param) || /=\s*null/.test(param);
      if (hasDefault) { sawDefault = true; continue; }
      const line = moduleSrc.slice(0, decl.index).split('\n').length;
      assert.equal(sawDefault, false,
        `第 ${line} 行函数参数「${param}」无默认值却排在有默认值的参数之后（Kotlin 会编译失败）`);
    }
  }
});

test('线程纪律：持有 capturePermissionLock 时**不得**调打点（会跳进 JS，跨线程）', () => {
  const moduleSrc = kotlinSource('ScreenOverlayModule.kt');
  // 逐个 synchronized(capturePermissionLock) 块检查块内是否出现 recordTrace / recordPermissionTrace。
  const marker = 'synchronized(capturePermissionLock)';
  let from = 0;
  let checked = 0;
  while (true) {
    const start = moduleSrc.indexOf(marker, from);
    if (start < 0) break;
    const open = moduleSrc.indexOf('{', start);
    // 配对大括号，取出块体
    let depth = 0;
    let end = open;
    for (let i = open; i < moduleSrc.length; i += 1) {
      if (moduleSrc[i] === '{') depth += 1;
      else if (moduleSrc[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    const body = moduleSrc.slice(open, end);
    const line = moduleSrc.slice(0, start).split('\n').length;
    assert.equal(/record(?:Permission)?Trace\(/.test(body), false,
      `第 ${line} 行的 synchronized 块里调了打点：打点走 emit → JS（跨线程），`
      + '持锁执行会把自己挂在别的线程上。必须先出锁再打点。');
    checked += 1;
    from = start + marker.length;
  }
  assert.ok(checked >= 2, `应检查到至少 2 个同步块，实际 ${checked}`);
});

// ---------- ⑨ 行数棘轮 ----------

test('行数：本轮修改文件仍在 800 硬上限内', () => {
  const count = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  for (const file of [
    'src/screenWatch/overlay.js',
    'src/workspace/screen/ScreenWatchPanel.js',
    'src/screenWatch/ScreenWatchScreen.js',
    'src/screenWatch/overlayEvents.js',
  ]) {
    const lines = count(fs.readFileSync(path.resolve(file), 'utf8'));
    assert.ok(lines <= 800, `${file}: ${lines} > 800（棘轮纪律：拆文件，不抬上限）`);
  }
});
