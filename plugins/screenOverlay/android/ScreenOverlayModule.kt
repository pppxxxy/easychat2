package com.pppxxxy.easychat2.screenoverlay

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
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
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.lang.ref.WeakReference
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
        // FIX-SW5 P1-4：尽量早装（本模块随 RN 启动创建），幂等。
        installCrashGuard(reactContext)
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
        // FEAT-AC10 P0-2：**看门狗**——新请求进来时，若上一轮 in-flight 已明显超时，
        // 先把它判死（结算所有等待者），再走正常流程发起新一轮。
        //
        // 为什么只在「有新请求进来时」检查、不额外起计时线程：悬浮窗是常驻的，
        // 为一个可能永不发生的故障养一条常驻计时线程不划算；而用户「再点一次」
        // 正是这个故障唯一的暴露时机（点了永远转圈 ⇒ 用户一定会再点）。
        // 这一步让「点了还有救」，而不是只能杀进程。
        val recovered = recoverStaleCaptureRequestIfNeeded()
        recovered?.forEach { it(false) }

        // 排队/发起的分支判定与打点分开：打点会走到 JS（跨线程），**不能持锁执行**
        //（与 settleCapturePermissionWaiters「锁外结算」同一条纪律）。
        var queued = false
        var queuedEpoch = 0L
        var queuedWaiters = 0
        var epoch = 0L
        synchronized(capturePermissionLock) {
            if (capturePermissionInFlight) {
                // 弹窗进行中：排队复用同一次结果，**绝不叠第二个弹窗**。
                capturePermissionWaiters.add(onResult)
                queued = true
                queuedEpoch = capturePermissionEpoch
                queuedWaiters = capturePermissionWaiters.size
            } else {
                capturePermissionInFlight = true
                // 轮次自增 → 旧 Activity 的迟到结果会因 epoch 不符而被忽略（见 onCapturePermissionResult）。
                capturePermissionEpoch += 1
                epoch = capturePermissionEpoch
                captureRequestStartedAt = System.currentTimeMillis()
                capturePermissionWaiters.add(onResult)
            }
        }
        if (queued) {
            // FEAT-AC10 P0-4：排在队伍里也要留痕——否则「我点了但什么都没发生」
            // 与「点了、正在等授权」在日志上无法分辨。
            recordPermissionTrace(
                "overlay-permission-request",
                "queued=true epoch=$queuedEpoch waiters=$queuedWaiters"
            )
            return
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
                // 把本轮序号交给 Activity：它原样带回给结果入口，用于丢弃迟到结果。
                putExtra(EXTRA_CAPTURE_EPOCH, epoch)
            }
            recordPermissionTrace("overlay-permission-request", "epoch=$epoch")
            reactContext.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "capture permission activity failed to start: ${e.message}")
            // 起不来：把所有排队者按「拒绝」结算，不能让他们永远挂着。
            settleCapturePermissionWaiters(false, "activity-start-failed")
        }
    }

    /**
     * FEAT-AC10 P0-2：把「已明显超时」的 in-flight 轮判死，返回需要按失败结算的回调。
     *
     * 返回 null 表示不需要恢复（没有 in-flight，或还没超时）。
     * **在锁外调用回调**（与 flush 同纪律）：回调链会回到 JS，持锁执行会把
     * 一个跨线程的活压在锁里。
     */
    private fun recoverStaleCaptureRequestIfNeeded(): List<(Boolean) -> Unit>? {
        var recoveredAge = 0L
        var recoveredCount = 0
        val waiters: List<(Boolean) -> Unit>
        synchronized(capturePermissionLock) {
            if (!capturePermissionInFlight) return null
            val startedAt = captureRequestStartedAt
            if (startedAt <= 0) return null
            val age = System.currentTimeMillis() - startedAt
            if (age <= CAPTURE_PERMISSION_WATCHDOG_MS) return null
            // 判死：清 in-flight + 取走等待者。epoch 自增使本轮迟到结果彻底失效
            //（否则系统稍后重投结果时，会把已经结算过的这一批**再结算一次**）。
            capturePermissionEpoch += 1
            capturePermissionInFlight = false
            captureRequestStartedAt = 0
            waiters = capturePermissionWaiters.toList()
            capturePermissionWaiters.clear()
            recoveredAge = age
            recoveredCount = waiters.size
        }
        // 锁外打点：打点走 emit → JS（跨线程），持锁执行会把自己挂在别的线程上。
        recordPermissionTrace("overlay-permission-watchdog", "age=${recoveredAge}ms recovered=$recoveredCount")
        return waiters
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

    /**
     * FEAT-AC4 P0-A：推送一张**窗内确认卡**（JS → 原生）。
     *
     * 与 pushChatMessage 分开的原因：那条只渲染文本；确认卡要原生画「允许/拒绝」
     * 两键，并在点击/超时后经 onConfirmResult 事件回报给 JS 结算挂起的 agent 循环。
     *
     * 为什么不在悬浮窗弹全屏 Alert：会盖住用户正在看的画面（SW3 的原始取舍）。
     * 卡片插在聊天流里，用户不必离开当前应用。
     */
    @ReactMethod
    fun pushConfirmCard(id: String?, summary: String?, timeoutMs: Double, promise: Promise) {
        try {
            val applied = OverlayService.instance?.pushConfirmCard(
                id ?: "",
                summary ?: "",
                timeoutMs.toLong()
            ) ?: false
            promise.resolve(applied)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_CONFIRM", e.message, e)
        }
    }

    /**
     * FEAT-AC4 P0-A：悬浮窗标题行的模式徽标（只读/可改）。
     *
     * 徽标只**显示**当前模式；改模式仍要回 app 面板（不在悬浮窗里直接切——
     * 那是安全相关开关，避免误触）。
     */
    @ReactMethod
    fun setScopeModeLabel(mode: String?, promise: Promise) {
        try {
            OverlayService.instance?.setScopeModeLabel(mode ?: "")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_MODE", e.message, e)
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
     * FEAT-AC3：推送悬浮球头像来源（JS → 原生）。
     *
     * **为什么是双值**（本任务唯一的新设计点）：scope 切换（聊天 ⇄ 工作区）发生在
     * **原生侧**（OverlayService.toggleChatScope，已核实它不回调 JS），所以 JS 一次性
     * 把两个 scope 各自的头像都算好推过来，原生按当前 scope 自选。
     * 这样不必新开「原生 → JS 反向询问」这条本来不存在的通道。
     *
     * 空串 = 「回退 App 图标」（原生侧不做任何解析，只管取值）。
     * setOverlayAvatar 与 setCharacterName 同理：服务不在时 resolve(false) 而不是
     * reject——悬浮窗没开时推头像不是错误（下次 startOverlay 会带上）。
     */
    @ReactMethod
    fun setOverlayAvatar(payload: ReadableMap?, promise: Promise) {
        try {
            val chat = payload?.getString("chatAvatarUri") ?: ""
            val workspace = payload?.getString("workspaceAvatarUri") ?: ""
            val applied = OverlayService.instance?.setAvatarUris(chat, workspace) ?: false
            promise.resolve(applied)
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY_AVATAR", e.message, e)
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

        /**
         * FIX-SW5 P1-4：进程级崩溃取证——**进程死也要留下遗书**。
         *
         * 为什么需要：FIX-SW5 的根因是靠「诊断日志停在 brain-request」反推出来的
         * （三起闪退时间线一致、无 first-byte/done/fail）。推理链成立，但代价是
         * 一轮真机测试 + 一次人工推演。若还有残余死法（不同机型/不同死点），
         * 我们希望**下一轮直接拿到堆栈**，而不是再推一次。
         *
         * 做法：在 RN 默认处理器**之前**挂一层，把堆栈写进 app 私有目录，然后
         * 委托原处理器——保留 RN 原有的崩溃行为（不吞异常、不改 Crashlytics 之类
         * 的既有链路），只是多写一份现场。
         *
         * 为什么 catch Throwable 且全程吞掉：崩溃处理器里再抛异常会让进程以更糟的
         * 方式死掉（甚至死循环）。它是取证代码，绝不能成为新的故障源。
         */
        fun installCrashGuard(context: Context) {
            if (crashGuardInstalled) return
            crashGuardInstalled = true
            try {
                val previous = Thread.getDefaultUncaughtExceptionHandler()
                Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                    try {
                        val dir = File(context.filesDir, "screen-watch").apply { mkdirs() }
                        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
                        File(dir, "crash-$stamp.txt").writeText(
                            "thread=${thread.name}\n" + Log.getStackTraceString(throwable),
                            Charsets.UTF_8
                        )
                        // 只留最近 3 份：取证文件不该在用户手机上无限积累。
                        dir.listFiles { f -> f.name.startsWith("crash-") }
                            ?.sortedByDescending { it.name }
                            ?.drop(3)
                            ?.forEach { it.delete() }
                    } catch (error: Throwable) {
                        // 取证失败绝不改变崩溃行为。
                    }
                    previous?.uncaughtException(thread, throwable)
                }
            } catch (error: Throwable) {
                Log.w(TAG, "install crash guard failed: ${error.message}")
            }
        }

        @Volatile private var crashGuardInstalled = false

        // 授权等待队列与 in-flight 标记：**进程级**（M1.3）。
        // 结果由 OverlayPermissionActivity 投递——它和 Module 是不同对象、不同线程，
        // 队列放在实例上 Activity 就够不着。锁保护「入队 / 结算」两步，避免
        // 「结算途中又有新请求进来」被漏掉或重复弹窗。
        private val capturePermissionLock = Any()
        private val capturePermissionWaiters = mutableListOf<(Boolean) -> Unit>()
        @Volatile private var capturePermissionInFlight = false

        /**
         * FEAT-AC10 P0-2：本轮授权请求的**发起时刻**（ms）。看门狗据此判「超时」。
         * 0 表示没有进行中的轮次。
         */
        @Volatile private var captureRequestStartedAt = 0L

        /**
         * FEAT-AC10 P0-1/P0-2：**轮次序号**。每次发起新一轮自增；结果入口比对序号，
         * 不符即丢弃。
         *
         * 为什么需要它（本轮最重要的一处防错）：看门狗把超时轮判死、用户又发起了新一轮
         * 之后，**旧 Activity 仍可能迟到地投回结果**（系统重投、或它其实没死只是慢）。
         * 没有序号时那条迟到结果会结算掉**新一批**等待者——把用户刚点出来的授权框
         * 当成已拒绝，界面恢复正常却拿不到凭据，变成更难查的错。
         */
        @Volatile private var capturePermissionEpoch = 0L

        /**
         * FEAT-AC10 P0-2：看门狗阈值——in-flight 超过它就被下一次请求判死。
         *
         * 取值理由（拍板值，写进注释以免后人随手改）：上限必须覆盖用户在系统授权框上
         * **合法停留**的思考时间（读文案、犹豫、去确认这是不是自己想要的），
         * 又要短到「点了没反应时用户再点一次」就能救回来。3 分钟远大于正常授权耗时
         *（通常数秒），也远小于用户放弃重试的耐心。
         *
         * ⚠️ 与 JS 侧的 START_CHAIN_TIMEOUT_MS 有**比例关系**：JS 超时必须 > 本值，
         * 否则 JS 会先于 native 看门狗放弃，看门狗永远轮不到生效（见 overlay.js 的说明）。
         */
        const val CAPTURE_PERMISSION_WATCHDOG_MS = 3 * 60 * 1000L

        /** 超时阈值：见 CAPTURE_PERMISSION_WATCHDOG_MS 的说明。 */
        const val EXTRA_CAPTURE_EPOCH = "captureEpoch"

        /**
         * FEAT-AC10 P0-1/P0-2：**唯一的结算出口**（清 in-flight + 唤醒全部等待者）。
         *
         * @param reason 非空时写进打点（watchdog-recovered / activity-destroyed / ...），
         *   便于下次真机一眼看出「这批等待者是被谁结算的」。
         * @param expectEpoch 非 0 时要求与当前轮次一致；不一致说明这是**上一轮的迟到结果**，
         *   必须忽略（否则会误结算新一轮，见 capturePermissionEpoch 的说明）。
         * @return true 表示确实结算了（幂等：重复调用不会重复投递）
         */
        private fun settleCapturePermissionWaiters(
            granted: Boolean,
            reason: String? = null,
            expectEpoch: Long = 0L,
        ): Boolean {
            val waiters: List<(Boolean) -> Unit>
            // 迟到判定的结果带出锁外再打点：打点会走到 JS（跨线程），**不能持锁执行**
            //（与下面「锁外结算」同一条纪律；持锁调 JS 是把自己挂死在别的线程上）。
            var staleEpoch = 0L
            synchronized(capturePermissionLock) {
                if (expectEpoch != 0L && expectEpoch != capturePermissionEpoch) {
                    // 迟到结果：当前轮次已经不是它那一轮了，丢弃。
                    staleEpoch = expectEpoch
                    waiters = emptyList()
                } else {
                    capturePermissionInFlight = false
                    captureRequestStartedAt = 0
                    waiters = capturePermissionWaiters.toList()
                    capturePermissionWaiters.clear()
                }
            }
            if (staleEpoch != 0L) {
                recordPermissionTrace(
                    "overlay-permission-stale-result",
                    "epoch=$staleEpoch current=$capturePermissionEpoch"
                )
                return false
            }
            // 锁外结算：回调会回到 JS，持锁执行等于把一个跨线程的活压在锁里。
            waiters.forEach { it(granted) }
            if (reason != null) {
                recordPermissionTrace("overlay-permission-settled", "granted=$granted reason=$reason waiters=${waiters.size}")
            }
            return true
        }

        /**
         * FEAT-AC10 P0-1：授权 Activity **死亡且从未交付结果**时的兜底结算。
         *
         * 由 [OverlayPermissionActivity.onDestroy] 调用（它已排除配置变更与已交付两种
         * 正常情形）。这是「授权框闪现即逝 → 永久加载」的直接解药：以前这条路径
         * 没有任何结算，等待者悬挂、in-flight 永真，只能杀进程恢复。
         *
         * 判决为**拒绝**而不是放行：问不到用户 = 不执行（本仓既有纪律）。
         */
        @JvmStatic
        fun onPermissionActivityDestroyed(epoch: Long) {
            val settled = settleCapturePermissionWaiters(false, "activity-destroyed-without-result", epoch)
            if (settled) {
                // 麦克风环节同源（该 Activity 兼管两环）：一并复位，否则「说话」会拿旧标记。
                recordPermissionTrace("record-audio", "unknown-activity-destroyed")
            }
        }

        /**
         * FEAT-AC10 P0-4：授权链**专用**打点入口。
         *
         * 为什么不直接复用 recordTrace：那条的事件名是采集链路的（capture-*）。
         * 本轮的教训恰恰是「这条链路一行日志都没有」，若把授权事件混进采集命名空间，
         * 下次读日志仍要猜某条 capture-request 到底是采集还是授权。
         * 统一加 `overlay-permission-` 前缀，一次 grep 就能看完整条授权链。
         */
        @JvmStatic
        fun recordPermissionTrace(stage: String, detail: String) {
            recordTrace(stage, detail)
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
         *
         * @param epoch FEAT-AC10：本轮授权尝试的序号（由 Activity 从 Intent extra 带回）。
         *   与当前轮次不符时说明这是**上一轮的迟到结果**（看门狗已判死并可能有新一轮在跑），
         *   必须忽略，否则会误结算用户刚点出来的那一轮。默认 0 = 不校验（兼容旧调用）。
         */
        @JvmStatic
        fun onCapturePermissionResult(
            resultCode: Int,
            data: Intent?,
            failure: String? = null,
            epoch: Long = 0L,
        ) {
            val granted = failure == null && resultCode == Activity.RESULT_OK && data != null
            // 先判迟到：迟到的成功结果也绝不能覆盖掉新一轮的 in-flight 状态。
            if (epoch != 0L && epoch != capturePermissionEpoch) {
                recordPermissionTrace(
                    "overlay-permission-stale-result",
                    "epoch=$epoch current=$capturePermissionEpoch granted=$granted"
                )
                return
            }
            if (granted) {
                setCaptureToken(resultCode, data)
                recordPermissionTrace("permission-granted", "via OverlayPermissionActivity epoch=$epoch")
            } else {
                clearCaptureToken()
                recordPermissionTrace("permission-denied", "${failure ?: "resultCode=$resultCode"} epoch=$epoch")
            }
            settleCapturePermissionWaiters(granted, null, epoch)
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
         * JS 侧是否**真的能收事件**（FEAT-AC5 P0-D）。
         *
         * 为什么必须有这个判据：悬浮窗的「工作区」scope 要走 JS 的 agent 管线（工具、权限门控、
         * 确认卡全在 JS 侧）。而原生大脑（OverlayBrain）是纯流式直连、**没有任何工具能力**。
         * 于是「有没有配置快照」曾被当成「走原生还是走 JS」的判据——那是错的：
         * 只要用户配过 API，快照就存在，工作区消息会被大脑截走，JS 工具层**永远收不到**，
         * 用户看到的是助手如实说「我没有工具调用能力」（因为它真的没有），
         * 而不是「工具被拒绝了」。这正是用户截图 #257 的现象。
         *
         * 判据换成**JS 是否活着**：RN 实例活跃 ⇒ 事件能送达 ⇒ 工作区 scope 必须走 JS。
         * 大脑只在 JS 不在时兜底（悬浮窗的主场景之一：app 被杀后悬浮窗仍在）。
         *
         * 用 RN 自己的 API（ReactContext.hasActiveReactInstance / isBridgeless），
         * 不自己维护「JS 活着」的标记——那需要与 RN 生命周期逐点对齐，必然漂移。
         */
        @JvmStatic
        fun isJsBridgeAlive(): Boolean {
            val context = contextRef?.get() ?: return false
            return try {
                context.hasActiveReactInstance() || context.isBridgeless()
            } catch (error: Exception) {
                false
            }
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
