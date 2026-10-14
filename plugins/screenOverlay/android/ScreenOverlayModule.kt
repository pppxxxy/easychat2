package com.pppxxxy.easychat2.screenoverlay

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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
 *
 * ⚠️ M1.3（2026-10-14）起**不再是 ActivityEventListener**：投屏授权改由独立的
 * OverlayPermissionActivity 承接（见该文件顶部说明）。旧实现绑在 RN 主 Activity 上，
 * app 不在前台时走不了；重新授权还会把主 Activity 拉到前台，正是 M1 消灭的 ANR 路径。
 */
class ScreenOverlayModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        contextRef = WeakReference(reactContext)
    }

    override fun getName() = "ScreenOverlay"

    override fun invalidate() {
        // ⚠️ M2 起**不再**在这里 stopService / 清 token——这是本次重设计与旧架构的
        // 直接冲突点，由用户拍板按此改：
        //
        // 旧架构（大脑在 JS）：JS 实例销毁 ⇒ 脑子死了 ⇒ 悬浮窗留着只会空转，
        //   所以「不留孤儿前台服务」是正确的清理。
        // 新架构（大脑在原生 OverlayBrain）：JS 死亡/热重载后悬浮窗必须**继续**工作
        //   ——这正是本次重设计的核心目的（设计文档 §二「完全不依赖 RN JS 存活」）。
        //   在这里停服务 = 把刚搬家的大脑又绑回 RN 生命周期，等于白搬。
        //
        // 停服务只剩两条明确路径（都由用户或系统显式触发）：
        //   · 悬浮窗「关闭」按钮 → stopOverlay() → stopService；
        //   · 投影被系统停止（锁屏/系统回收）→ onStop() → stopSelf() → onDestroy()。
        // clearCaptureToken 同理移除：凭据跟着**服务**走（onDestroy 已清），不跟 JS 实例走
        // ——服务还在跑时投影可能仍然有效，在这里清掉会平白让悬浮窗失去采集能力。
        super.invalidate()
    }

    // 等待授权结果的回调队列：**幂等**——弹窗期间再点按钮只是排队，不会叠出第二个弹窗
    //（叠窗会让用户看到连续两个系统授权框，且第二个的结果会覆盖第一个）。
    //
    // ⚠️ M1.3 起这两个状态搬进 **companion object（进程级）**，与 token 同级：
    // 结果不再由本 Module 的 onActivityResult 投递，而是由 OverlayPermissionActivity
    // 直接调 onCapturePermissionResult。Activity 与 Module 是两个对象、两个线程，
    // 队列放在实例上 Activity 就够不着——那正是旧设计「必须有 RN 实例才能授权」的病根。

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
        if (hasValidCaptureToken()) {
            // 已有有效 token：立即成功，不弹窗（幂等语义的第一条）。
            onResult(true)
            return
        }
        synchronized(capturePermissionLock) {
            if (capturePermissionInFlight) {
                // 弹窗进行中：排队复用同一次结果，**绝不叠第二个弹窗**。
                capturePermissionWaiters.add(onResult)
                return
            }
            capturePermissionInFlight = true
            capturePermissionWaiters.add(onResult)
        }
        // 用**独立 Activity** 承接授权（M1.3）。旧实现是
        // reactContext.currentActivity.startActivityForResult(...)，它要求 RN 主 Activity
        // 在场且可用——app 在后台（悬浮窗的主场景）时直接失败；重新授权还会把主 Activity
        // 拉到前台 → 主线程被 Activity 启动 + RN 恢复堵住 → ANR（M1 消灭的那条路径）。
        //
        // 目标 Activity 在清单里是 exported=false + 独立 taskAffinity + 透明主题，
        // 因此这里既不需要也不使用 currentActivity。FLAG_ACTIVITY_NEW_TASK 是从
        // Application context 起 Activity 的硬性要求。
        try {
            val intent = Intent(reactContext, OverlayPermissionActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "capture permission activity failed to start: ${e.message}")
            // 起不来：把所有排队者按「拒绝」结算，不能让他们永远挂着。
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
     * 写入悬浮窗的配置快照（M2 大脑搬家）。
     *
     * JS 在「保存 API 配置 / 切换模型 / 切换角色 / 看屏幕页打开」时调用，把大脑需要的
     * 全部配置一次性喂给原生。JSON 里**包含** apiKey——但原生会把它抽到
     * EncryptedSharedPreferences，落盘文件里**不会有**明文密钥（与本仓库
     * proactiveMessage/ProactiveCore.kt 的既有安全做法一致）。
     *
     * @param json 设计文档 3.1 的快照结构（endpoint/capabilities/persona/asr/tts/locale）
     */
    @ReactMethod
    fun writeOverlayConfig(json: String?, promise: Promise) {
        try {
            val ok = OverlayBrain.get(reactContext).saveConfig(json ?: "")
            recordTrace("overlay-config", if (ok) "saved" else "parse-failed")
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_CONFIG", e.message, e)
        }
    }

    /** 悬浮窗的大脑是否已有可用配置（JS 据此决定悬浮窗聊天走原生还是回退 JS 管线）。 */
    @ReactMethod
    fun hasOverlayBrainConfig(promise: Promise) {
        try {
            promise.resolve(OverlayBrain.get(reactContext).hasConfig())
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /**
     * M2.5 双写：把 app 内管线产生的一轮也写进悬浮窗的同一份对话日志。
     *
     * 设计文档 3.7 的风险表要求「JS 续聊后把后续轮次也 append 进同一文件」。
     * 由原生代写而不是 JS 自己拼 JSONL：格式与大脑完全一致（含 persona/ms 字段），
     * 两处各写一份必然漂移。大脑每次发送都重读该文件，于是下一轮就能看见这里写的内容。
     */
    @ReactMethod
    fun appendOverlayTurn(role: String?, text: String?, promise: Promise) {
        try {
            OverlayBrain.get(reactContext).appendExternalTurn(role ?: "assistant", text ?: "")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_TURN", e.message, e)
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
        // 注：REQUEST_CAPTURE_PERMISSION 已随 ActivityEventListener 一起删除（M1.3）——
        // 授权结果现在由 OverlayPermissionActivity 用**它自己的** requestCode 接收，
        // 再经 onCapturePermissionResult 投递进来，不再经过 ReactContext 的 Activity 事件。
        private const val REQUEST_POST_NOTIFICATIONS = 0x5C03
        private const val TAG = "ScreenOverlay"
        @Volatile private var contextRef: WeakReference<ReactApplicationContext>? = null

        // 授权等待队列与 in-flight 标记：**进程级**（M1.3）。
        // 结果由 OverlayPermissionActivity 投递——它和 Module 是不同对象、不同线程，
        // 队列放在实例上 Activity 就够不着。锁保护「入队 / 结算」两步，避免
        // 「结算途中又有新请求进来」被漏掉或重复弹窗。
        private val capturePermissionLock = Any()
        private val capturePermissionWaiters = mutableListOf<(Boolean) -> Unit>()
        @Volatile private var capturePermissionInFlight = false

        private fun flushCapturePermissionWaiters(granted: Boolean) {
            val waiters: List<(Boolean) -> Unit>
            synchronized(capturePermissionLock) {
                capturePermissionInFlight = false
                waiters = capturePermissionWaiters.toList()
                capturePermissionWaiters.clear()
            }
            waiters.forEach { it(granted) }
        }

        /**
         * 投屏授权结果入口，供 [OverlayPermissionActivity] 调用。
         *
         * 契约：
         *  - resultCode == RESULT_OK 且 data 非空 → 记下凭据（进程级 token）并唤醒所有等待者；
         *  - 否则视为拒绝/取消 → **清空旧 token**（避免「拒绝后仍拿旧 token 启动」，
         *    那是 Android 14 上 SecurityException / IllegalStateException 连环闪退的起点）；
         *  - failure 非空表示弹窗都没起来（部分 ROM 后台禁止起系统界面），同样按拒绝结算。
         *
         * 为什么必须是静态入口：授权 Activity 不持有 Module 实例（它可能在 RN 未启动时
         * 就存在——这正是本设计的目的）。凭据与队列都放在 companion，两者本就同源。
         */
        @JvmStatic
        fun onCapturePermissionResult(resultCode: Int, data: Intent?, failure: String? = null) {
            val granted = failure == null && resultCode == Activity.RESULT_OK && data != null
            if (granted) {
                setCaptureToken(resultCode, data)
                recordTrace("permission-granted", "via OverlayPermissionActivity")
            } else {
                clearCaptureToken()
                recordTrace("permission-denied", failure ?: "resultCode=$resultCode")
            }
            flushCapturePermissionWaiters(granted)
            // 服务还开着但没有投影（token 失效/被回收后的重授权）：把新凭据直接交给它
            // 重建采集。app 在后台时没有 RN/JS 可用，这条是悬浮窗恢复工作的唯一路径。
            if (granted) OverlayService.instance?.attachProjection(resultCode, data)
        }

        /**
         * 麦克风运行时权限的结果（M3 耳朵），由 [OverlayPermissionActivity] 投递。
         *
         * 与投屏授权不同：麦克风没有「一次性凭据」的概念，系统只回答准/不准。
         * 因此这里只记一个**进程级标记**并留痕——拒绝时「说话」按钮给出
         * 「语音识别不可用，请用文字输入」的如实提示（设计 3.3），不静默失败。
         */
        @JvmStatic
        fun onRecordAudioPermissionResult(granted: Boolean) {
            recordAudioGranted = granted
            recordTrace("record-audio", if (granted) "granted" else "denied")
        }

        /**
         * 当前是否持有麦克风权限（供 OverlayService 决定「说话」按钮走录音还是提示）。
         *
         * **以系统状态为准**，缓存标记只作兜底：权限是持久的，进程重启后缓存会归零，
         * 若只看缓存就会把「用户早就授权过」误判成「没权限」，于是每次开悬浮窗都弹一次框。
         * 拿不到 context（理论上不会）时退回缓存值。
         */
        @JvmStatic
        fun hasRecordAudioPermission(): Boolean {
            val context = contextRef?.get() ?: return recordAudioGranted
            return try {
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
            } catch (error: Exception) {
                recordAudioGranted
            }
        }

        @Volatile private var recordAudioGranted = false

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
