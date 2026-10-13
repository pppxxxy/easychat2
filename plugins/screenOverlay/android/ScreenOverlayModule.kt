package com.pppxxxy.easychat2.screenoverlay

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/**
 * 看屏幕悬浮窗的 RN 桥：
 * - 权限：悬浮窗（SYSTEM_ALERT_WINDOW）与屏幕捕获（MediaProjection，逐会话授权）
 * - 启停 OverlayService（前台服务 + WindowManager 覆盖窗）
 * - 把服务的采集/状态事件转给 JS（DeviceEventEmitter）
 * 事件名见 OverlayService.companion。
 */
class ScreenOverlayModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    init {
        reactContext.addActivityEventListener(this)
        contextRef = WeakReference(reactContext)
    }

    override fun getName() = "ScreenOverlay"

    override fun invalidate() {
        try {
            reactContext.removeActivityEventListener(this)
        } catch (error: Exception) {}
        if (contextRef?.get() === reactContext) contextRef = null
        // JS 实例销毁（热重载/退出）时不能留下孤儿前台服务 + 悬浮窗。
        // RN 0.81 只回调 invalidate()、不再回调 onCatalystInstanceDestroy()（与
        // ShellExecutorModule 同一个坑）。stopService 走 OverlayService.onDestroy
        // 统一释放采集、悬浮窗与前台通知；服务未在运行时是安全空操作。
        try {
            reactContext.stopService(Intent(reactContext, OverlayService::class.java))
        } catch (error: Exception) {}
        // 授权凭据随 JS 实例一起作废：热重载后新的 Module 实例不该复用一个可能已失效的 token。
        clearCaptureToken()
        super.invalidate()
    }

    // 等待授权结果的回调队列：**幂等**——弹窗期间再点按钮只是排队，不会叠出第二个弹窗
    //（叠窗会让用户看到连续两个系统授权框，且第二个的结果会覆盖第一个）。
    private val capturePermissionWaiters = mutableListOf<(Boolean) -> Unit>()
    private var capturePermissionInFlight = false

    private fun flushCapturePermissionWaiters(granted: Boolean) {
        capturePermissionInFlight = false
        val waiters = capturePermissionWaiters.toList()
        capturePermissionWaiters.clear()
        waiters.forEach { it(granted) }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_CAPTURE_PERMISSION) return
        val granted = resultCode == Activity.RESULT_OK && data != null
        if (granted) {
            setCaptureToken(resultCode, data)
        } else {
            // 用户拒绝/取消：清掉可能存在的旧 token，避免「拒绝后仍用旧 token 启动」。
            clearCaptureToken()
        }
        flushCapturePermissionWaiters(granted)
    }

    override fun onNewIntent(intent: Intent) {}

    @ReactMethod
    fun canDrawOverlays(promise: Promise) {
        try {
            promise.resolve(Settings.canDrawOverlays(reactContext))
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun requestOverlayPermission(promise: Promise) {
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${reactContext.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_SETTINGS", e.message, e)
        }
    }

    @ReactMethod
    fun requestCapturePermission(promise: Promise) {
        requestCapturePermissionInternal { granted -> promise.resolve(granted) }
    }

    /**
     * 申请屏幕捕获授权（幂等）。**不直接用 Promise 是为了让 startOverlay 能复用同一条链路**
     * ——双入口统一的关键就在这个内部函数上。
     *
     * 幂等语义（任务书要求「防重复授权」）：
     *   - 已有有效 token：立即回调 true，不弹窗；
     *   - 弹窗进行中：把回调排进队列，复用同一次授权结果，**绝不叠第二个弹窗**。
     */
    private fun requestCapturePermissionInternal(onResult: (Boolean) -> Unit) {
        // RN 0.81：ReactContextBaseJavaModule.getCurrentActivity() 已改为（过时的）Kotlin
        // 函数，裸 currentActivity 不再合成属性；改用 ReactApplicationContext 的 Java getter。
        val activity = reactContext.currentActivity
        if (activity == null) {
            onResult(false)
            return
        }
        if (hasValidCaptureToken()) {
            onResult(true)
            return
        }
        if (capturePermissionInFlight) {
            capturePermissionWaiters.add(onResult)
            return
        }
        val mpm = try {
            reactContext.getSystemService(MediaProjectionManager::class.java)
        } catch (e: Exception) {
            null
        }
        if (mpm == null) {
            onResult(false)
            return
        }
        capturePermissionInFlight = true
        capturePermissionWaiters.add(onResult)
        try {
            activity.startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST_CAPTURE_PERMISSION)
        } catch (e: Exception) {
            Log.w(TAG, "capture permission dialog failed: ${e.message}")
            // 弹窗都没起来：把所有排队者按「拒绝」结算，不能让他们永远挂着。
            flushCapturePermissionWaiters(false)
        }
    }

    /**
     * 启动悬浮窗。**无授权时自动先要授权**——这是双入口统一的关键。
     *
     * 历史缺陷：设置页（工作区面板）直接调 startOverlay，而它只检查内存里的 token；
     * 该入口从未走过授权流程 ⇒ 必然 resolve(false) ⇒ 界面显示「启动失败」（用户眼里的
     * 「点了没反应 / 失败」）。现在无 token 时自动弹系统授权，用户确认后继续启动。
     */
    @ReactMethod
    fun startOverlay(promise: Promise) {
        try {
            if (!Settings.canDrawOverlays(reactContext)) {
                promise.resolve(false)
                return
            }
            if (hasValidCaptureToken()) {
                promise.resolve(launchOverlayService())
                return
            }
            // 无有效授权：走同一条授权链路，拿到结果后再启动。
            requestCapturePermissionInternal { granted ->
                promise.resolve(if (granted && hasValidCaptureToken()) launchOverlayService() else false)
            }
        } catch (e: Exception) {
            promise.reject("ERR_START_OVERLAY", e.message, e)
        }
    }

    // 真正拉起服务。token 由 startOverlay 保证有效；服务侧还会再校验一次（双保险）。
    private fun launchOverlayService(): Boolean {
        val data = currentCaptureResultData()
        val code = currentCaptureResultCode()
        if (code != Activity.RESULT_OK || data == null) return false
        val intent = Intent(reactContext, OverlayService::class.java).apply {
            putExtra(OverlayService.EXTRA_RESULT_CODE, code)
            putExtra(OverlayService.EXTRA_RESULT_DATA, data)
        }
        requestNotificationPermissionIfNeeded()
        ContextCompat.startForegroundService(reactContext, intent)
        return true
    }

    // Android 13+ 的通知权限需要运行时请求；不请求的话前台服务的常驻通知不显示
    // （服务本身仍运行）。请求是异步的：不阻塞启动，用户拒绝也只是通知被抑制，
    // 悬浮窗与截屏功能不受影响。
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val activity = reactContext.currentActivity ?: return
        val granted = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.POST_NOTIFICATIONS)
        if (granted == PackageManager.PERMISSION_GRANTED) return
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQUEST_POST_NOTIFICATIONS
        )
    }

    @ReactMethod
    fun stopOverlay(promise: Promise) {
        try {
            reactContext.stopService(Intent(reactContext, OverlayService::class.java))
            // 关掉服务 = 对应的 projection 即将 stop ⇒ 这个 token 永久失效，必须清掉。
            // 不清的话「关掉后再从设置页开启」会带着失效 token 启动服务 → Android 14
            // 抛 SecurityException / IllegalStateException 连环闪退（本轮修复的核心）。
            clearCaptureToken()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_STOP_OVERLAY", e.message, e)
        }
    }

    @ReactMethod
    fun isOverlayActive(promise: Promise) {
        promise.resolve(OverlayService.isRunning)
    }

    @ReactMethod
    fun capture(promise: Promise) {
        try {
            val service = OverlayService.instance
            if (service == null) {
                promise.resolve(false)
                return
            }
            service.requestCapture()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_CAPTURE", e.message, e)
        }
    }

    @ReactMethod
    fun updateOverlayText(text: String, promise: Promise) {
        try {
            OverlayService.instance?.setStatusText(text)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_TEXT", e.message, e)
        }
    }

    @ReactMethod
    fun setCharacterName(name: String?, promise: Promise) {
        try {
            OverlayService.instance?.setCharacterName(name)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_NAME", e.message, e)
        }
    }

    /**
     * SW3：把一条消息推给悬浮窗渲染（JS → 原生）。
     *
     * 架构定死：**原生只做嘴和眼**——LLM 调用、工具执行、确认流全在 JS 后台跑，
     * 这里只负责把结果画出来。role: 'user' | 'assistant'；text 为空时静默忽略
     *（不画空气泡）。
     */
    @ReactMethod
    fun pushChatMessage(role: String?, text: String?, promise: Promise) {
        try {
            OverlayService.instance?.pushChatMessage(role, text)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_CHAT", e.message, e)
        }
    }

    /**
     * SW3：输入法遮挡时上移面板（insetBottom = 键盘高度，0 = 收起）。
     * 部分 ROM 对 overlay 窗口的输入法行为不一致，调用失败静默（面板位置不致命）。
     */
    @ReactMethod
    fun setImeInset(insetBottom: Double, promise: Promise) {
        try {
            OverlayService.instance?.applyImeInset(insetBottom.toInt())
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_IME", e.message, e)
        }
    }

    /**
     * 无障碍服务是否已开启。只读查询，不申请任何权限、不产生副作用。
     *
     * 两条判据取**或**：
     *  1. 进程内绑定标记（ScreenAccessibilityService.isConnected）——服务确实活着，
     *     但进程刚重启、服务尚未绑定时会漏报；
     *  2. 系统设置里的已启用列表（Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES）——
     *     用户开启过就有记录，冷启动也能立刻答对。
     * 所以冷启动首帧靠 (2)，运行中靠 (1)(2) 任一。用 ComponentName.flattenToString
     * 拼出与系统同一格式的字符串再做**精确**比对（列表以 `:` 分隔）：不能用 contains
     * 裸匹配，否则 `com.foo` 会命中 `com.foobar`（历史上有过这类误判）。
     *
     * ⚠️ 未在本地核实：沙箱无 Android SDK / Java，本方法无法编译或运行验证。
     * Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES 的取值格式、以及
     * AccessibilityManager.getEnabledAccessibilityServiceList 在各 API level 的
     * 行为差异，都需要真机/打包验证。
     */
    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        try {
            if (ScreenAccessibilityService.isConnected) {
                promise.resolve(true)
                return
            }
            val expected = ComponentName(
                reactContext.packageName,
                ScreenAccessibilityService::class.java.name
            ).flattenToString()
            val raw = Settings.Secure.getString(
                reactContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )
            if (raw.isNullOrEmpty()) {
                promise.resolve(false)
                return
            }
            // 不能写 .asSequence()：TextUtils.SimpleStringSplitter 同时实现 Iterable<String>
            // 与 Iterator<String>，而 Kotlin 对这两种接收者都有 asSequence() 重载 →
            // 「Overload resolution ambiguity」（CI 里 :app:compileReleaseKotlin 直接失败），
            // 后面的 map/any 因接收者类型未定，连 lambda 参数 it 也变成 Unresolved reference。
            // toList() 只定义在 Iterable 上，没有二义；后续 map/any 的接收者是 List，同样唯一。
            val enabled = TextUtils.SimpleStringSplitter(':').apply { setString(raw) }
                .toList()
                .map { it.trim() }
                .any { it.equals(expected, ignoreCase = true) }
            promise.resolve(enabled)
        } catch (e: Exception) {
            // 查询失败按「未开启」处理：界面给的是引导（去系统设置开启），
            // 报错只会让用户卡在一个他无法处置的错误上。
            Log.w(TAG, "accessibility query failed: ${e.message}")
            promise.resolve(false)
        }
    }

    /**
     * 打开系统「无障碍」设置页。**无法直达本应用那一项**——系统没有这样的
     * Intent extra（未在本地核实是否存在厂商扩展），所以这里只打开总列表，
     * 界面文案必须如实说「在列表里找到本应用」，不要把话说满。
     */
    @ReactMethod
    fun openAccessibilitySettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_ACCESSIBILITY_SETTINGS", e.message, e)
        }
    }

    /**
     * 本应用是否已被排除在电池优化之外（即允许后台运行）。
     *
     * 为什么需要它（FIX-4 第 4 条）：国产 ROM（荣耀/华为等）对后台进程的冻结非常激进。
     * 前台服务被冻结时**整个主线程暂停**，采集的兜底定时器与超时复位全部失灵——用户看到的
     * 正是「悬浮窗还在、点了没反应、一直等」。线程化能消掉主线程重活，但 ROM 冻结是系统行为、
     * 代码改不掉，只能检测出来并引导用户去「启动管理/电池优化」里放行。
     *
     * 只读查询，无副作用。查询失败按「未排除」返回 false：引导用户去看一眼是安全的，
     * 反过来说「已放行」而实际被冻结会让他继续白等。
     */
    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                // M 以下没有电池优化机制：视为「无此问题」，不引导。
                promise.resolve(true)
                return
            }
            val pm = reactContext.getSystemService(PowerManager::class.java)
            if (pm == null) {
                promise.resolve(true)
                return
            }
            promise.resolve(pm.isIgnoringBatteryOptimizations(reactContext.packageName))
        } catch (e: Exception) {
            Log.w(TAG, "battery optimization query failed: ${e.message}")
            promise.resolve(false)
        }
    }

    /**
     * 打开系统的「电池优化」设置页。**不直达本应用**（各 ROM 的入口差异极大，
     * ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 在国产 ROM 上常被限制且需额外权限），
     * 所以只打开总列表，文案必须说「找到本应用并选择不优化」。
     */
    @ReactMethod
    fun openBatteryOptimizationSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_BATTERY_SETTINGS", e.message, e)
        }
    }

    companion object {
        private const val REQUEST_CAPTURE_PERMISSION = 0x5C01
        private const val REQUEST_POST_NOTIFICATIONS = 0x5C03
        private const val TAG = "ScreenOverlay"
        @Volatile private var contextRef: WeakReference<ReactApplicationContext>? = null

        // ---- 投屏授权凭据：**进程级**，不是 Module 实例级 ----
        //
        // resultCode/resultData 是 MediaProjection 的**一次性授权凭据**：它对应的 projection
        // 一旦被 stop（用户关闭悬浮窗、锁屏、系统回收、被其他应用抢占），token 就永久失效，
        // **不能再用**。
        //
        // 为什么必须是进程级（而不是 Module 的成员变量）：清理它的有三个地方，其中两个在
        // Module 之外——OverlayService.onDestroy（系统回收/锁屏/被抢占）与 projection.onStop。
        // 放在实例上时它们够不着，token 就会残留。
        //
        // 历史缺陷（真机连环闪退的根因）：token 只写不清。于是「扩展页开启 → 关闭 → 回设置页
        // 再点」时内存里还留着旧 token，startOverlay 的检查放行 → 服务带着失效 token 启动：
        //   1) onCreate 以 mediaProjection 类型 startForeground：Android 14 要求该类型必须有
        //      **正在进行的有效授权**，否则抛 SecurityException（第一次闪退）；
        //   2) setupProjection 的 getMediaProjection 对失效 token 抛 IllegalStateException
        //      （第二次闪退）。
        @Volatile private var captureResultCode: Int = Activity.RESULT_CANCELED
        @Volatile private var captureResultData: Intent? = null

        fun hasValidCaptureToken(): Boolean =
            captureResultCode == Activity.RESULT_OK && captureResultData != null

        fun currentCaptureResultCode(): Int = captureResultCode

        fun currentCaptureResultData(): Intent? = captureResultData

        fun setCaptureToken(code: Int, data: Intent?) {
            captureResultCode = code
            captureResultData = data
        }

        /** 作废授权凭据。**三处调用**：Module.stopOverlay / Module.invalidate / 服务 onDestroy。 */
        fun clearCaptureToken() {
            captureResultCode = Activity.RESULT_CANCELED
            captureResultData = null
        }

        /** 由 OverlayService 调用，把原生事件发给 JS（ReactContext 已销毁时静默丢弃）。 */
        fun emit(event: String, params: WritableMap?) {
            val context = contextRef?.get() ?: return
            try {
                context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(event, params)
            } catch (error: Exception) {
                Log.w(TAG, "emit $event failed: ${error.message}")
            }
        }

        fun emitState(active: Boolean) {
            emit(OverlayService.EVENT_STATE, Arguments.createMap().apply { putBoolean("active", active) })
        }

        /**
         * 采集链路打点（任务书 FIX-4 第 3 条）：把各阶段时间戳/原因码发给 JS，由 JS 写入
         * 诊断日志（DiagnosticsModal 可见）。
         *
         * 为什么必须打点：真机上「一直等」这类故障此前完全不可观测——不知道卡在
         * 请求 / 帧到达 / 压缩 / 落盘 / emit / JS 接收的哪一环，只能靠猜。
         * 有了它，荣耀等 ROM 的后台冻结若仍导致偶发挂死，日志会直接指出断点。
         *
         * 走独立事件，不与 capture/captureFailed 混用（那两条是业务语义，这条是诊断）。
         */
        fun recordTrace(stage: String, detail: String) {
            // ⚠️ 必须写 OverlayService.EVENT_TRACE：该常量定义在 **OverlayService** 的
            // companion 里，不是本类的。裸写 EVENT_TRACE 会编译失败（Unresolved reference）
            // ——这正是 CI 的 Kotlin compile job 抓出来的（本机无 JDK，只有 CI 能编）。
            emit(OverlayService.EVENT_TRACE, Arguments.createMap().apply {
                putString("stage", stage)
                putString("detail", detail)
                putDouble("at", System.currentTimeMillis().toDouble())
            })
        }
    }
}
