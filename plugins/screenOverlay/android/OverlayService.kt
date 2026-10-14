package com.pppxxxy.easychat2.screenoverlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.facebook.react.bridge.Arguments
import java.io.File
import java.io.FileOutputStream
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 看屏幕悬浮窗前台服务：
 * - WindowManager（TYPE_APPLICATION_OVERLAY）承载悬浮球 ⇄ 小窗，可拖动；
 * - MediaProjection + ImageReader/VirtualDisplay 采集跨应用画面，JPEG 落
 *   filesDir/screen-watch/（与 expo documentDirectory 同目录），经事件交 JS；
 * - 关闭 / 锁屏 / 系统回收（projection.onStop）时释放全部资源。
 * AI 评论留在 JS：小窗「截屏」按钮只发 onRequestCapture，由 JS 决定单帧/帧序列并调 capture()。
 */
class OverlayService : Service() {

    companion object {
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        const val EVENT_CAPTURE = "ScreenOverlay:onCapture"
        const val EVENT_CAPTURE_FAILED = "ScreenOverlay:onCaptureFailed"
        const val EVENT_REQUEST_CAPTURE = "ScreenOverlay:onRequestCapture"
        const val EVENT_STATE = "ScreenOverlay:onState"
        // FIX-4：采集链路打点（{ stage, detail, at }）→ JS 写诊断日志。
        const val EVENT_TRACE = "ScreenOverlay:onTrace"
        // SW3：悬浮窗 mini 聊天——用户在悬浮窗里发话（原生 → JS）。
        // payload: { text, scope }；scope 决定 JS 侧走聊天管线还是工作区 agent 管线。
        const val EVENT_CHAT_SEND = "ScreenOverlay:onChatSend"
        // SW3：mini 聊天的两个作用域（与 JS 侧 overlayEvents.OVERLAY_CHAT_SCOPES 同值）。
        const val SCOPE_CHAT = "chat"
        const val SCOPE_WORKSPACE = "workspace"
        private const val TAG = "ScreenOverlay"
        private const val NOTIFICATION_ID = 0x5C02
        private const val CHANNEL_ID = "screen_overlay"
        // 帧新鲜度校验的时序余量：请求与首帧落地之间有抖动，留 50ms 避免误杀合法帧。
        private const val FRAME_FRESHNESS_SLACK_NANOS = 50_000_000L
        // 兜底交付等待：屏幕静止时不产生新帧（跨应用看静态画面最常见的失败），
        // 等到这个时长就用请求期间收到的旧帧 / 最近缓存帧交付，而不是让 JS 干等超时。
        private const val CAPTURE_FALLBACK_DELAY_MS = 700L
        // 硬超时上限：无论哪条路径卡死，到点必回报失败并复位状态文字。
        // 比 JS 侧的 6s 略短，让「原生先认输」而不是让界面先超时（原生的原因码更准）。
        private const val CAPTURE_HARD_TIMEOUT_MS = 5000L
        // 「最近一帧」缓存节流：屏幕持续变化时最多每 500ms 拷一份像素，
        // 避免看视频时每帧都做一次全屏内存拷贝。
        private const val FRAME_CACHE_INTERVAL_NANOS = 500_000_000L
        // SW3：mini 聊天消息区上限（超出滚动裁剪，防长会话把悬浮窗撑爆）。
        private const val CHAT_MESSAGE_MAX = 50

        @Volatile var instance: OverlayService? = null
            private set
        @Volatile var isRunning: Boolean = false
            private set
    }

    private lateinit var windowManager: WindowManager
    private lateinit var rootView: LinearLayout
    private lateinit var params: WindowManager.LayoutParams
    private var statusView: TextView? = null
    private var titleView: TextView? = null
    private var characterName: String = ""
    private var expanded = false
    private val mainHandler = Handler(Looper.getMainLooper())

    // ---- SW3：mini 聊天状态 ----
    // scope 决定 JS 侧走哪条管线（聊天角色 / 工作区 agent）；切换只改 scope，不清消息。
    private var chatScope = SCOPE_WORKSPACE
    private var chatMessages: ScrollView? = null
    private var chatInput: EditText? = null
    private var scopeButton: TextView? = null
    // 消息留档：收起/展开会重建视图，内容不能跟着丢（用户要求切种类、收起重开都保留上下文）。
    private val chatHistory = mutableListOf<Pair<String, String>>()
    // 键盘处理：面板被输入法顶住时上移（见 applyImeInset）。
    // baseY = 可空「拖拽落点」（null = 尚未捕获；用 null 而非 0，见 applyImeInset 说明）。
    private var baseY: Int? = null

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var captureRequested = false
    // 本次截屏请求的发起时刻（System.nanoTime 时基，与 Image.timestamp 同源）：
    // 重挂载 Surface 会先吐出旧帧，用它识别早于请求的帧。
    private var captureRequestedAtNanos = 0L
    // 请求期间收到的「不够新」的帧：屏幕静止时它就是当前画面（画面没变），
    // 兜底交付时优先用它；有更新鲜的帧到达就作废。
    private var pendingStaleBitmap: Bitmap? = null
    // 「最近一帧」像素缓存（含行/像素跨度，解码时用）：缓存节流见常量说明。
    private var lastFrameCopy: ByteArray? = null
    private var lastFrameRowStride = 0
    private var lastFramePixelStride = 0
    private var lastFrameCachedAtNanos = 0L
    private val captureFallback = Runnable { deliverFallbackFrame() }
    private var width = 0
    private var height = 0
    private var density = 0

    // ---- 采集工作线程 ----
    //
    // 为什么必须有：JPEG 压缩与全屏 bitmap 拷贝（imageToBitmap / bitmapFromCachedFrame）
    // 原本全在主线程。1080×2400 一张的解码+压缩是几百毫秒起，这段时间主线程被占满：
    //   · 触摸事件消费超时 → input dispatching ANR → 系统杀进程（用户看到「卡死+闪退」）；
    //   · **所有失败兜底也挂在主线程 Handler 上**（captureFallback / 超时复位），主线程一卡
    //     它们全部失灵 ⇒ 界面永远停在「正在看…」——这正是「app 外截屏一直等」的真凶。
    // 所以重活全部搬到这里；主线程只留状态位读写、setStatusText、emit。
    private var workerThread: HandlerThread? = null
    private var workerHandler: Handler? = null
    // 硬超时：跑在**工作线程**上，所以主线程被冻结/卡死时它仍能到点触发（JS 侧的 6s 超时
    // 在 JS 线程，native 冻结时也未必准时）。到点必回报 + 复位状态文字。
    private val captureTimeout = Runnable { onCaptureTimeout() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        isRunning = true
        // 采集工作线程：所有重活（解码/压缩/落盘）都在这里，主线程不再被几百毫秒的
        // JPEG 压缩堵住（那是 ANR 与「兜底全失灵」的根因，见 workerThread 处说明）。
        val thread = HandlerThread("capture-worker")
        thread.start()
        workerThread = thread
        workerHandler = Handler(thread.looper)
        startForegroundCompat()
        windowManager = getSystemService(WindowManager::class.java)
        createOverlayView()
        ScreenOverlayModule.emitState(true)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        if (projection == null && resultData != null) {
            setupProjection(resultCode, resultData)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseCapture()
        // 服务销毁 = 授权凭据已失效：必须同步清掉 Module 侧的缓存，否则「关掉后再开启」
        // 会带着失效 token 启动（Android 14 上 SecurityException / IllegalStateException
        // 连环闪退，见 ScreenOverlayModule 的 token 生命周期说明）。
        ScreenOverlayModule.clearCaptureToken()
        // 工作线程收尾：先清队列（避免退出的瞬间还在跑压缩），再 quitSafely。
        workerHandler?.removeCallbacksAndMessages(null)
        workerThread?.quitSafely()
        workerHandler = null
        workerThread = null
        try {
            if (::rootView.isInitialized) windowManager.removeView(rootView)
        } catch (error: Exception) {}
        instance = null
        isRunning = false
        ScreenOverlayModule.emitState(false)
        super.onDestroy()
    }

    // ---------- 前台通知 ----------

    /**
     * 起前台服务。**绝不裸崩**——这是连环闪退的第一道闸。
     *
     * Android 14（API 34）起，以 FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION 启动前台服务时，
     * 系统要求**当下存在有效的投屏授权**；token 失效/被拒时抛 SecurityException，服务直接崩进程
     * （用户看到「开启悬浮窗 → 闪退」）。
     *
     * 降级策略：带 mediaProjection 类型失败 → 退回**不带类型**的普通前台服务再试一次
     * （悬浮窗本身与通知照常可用，只是采集起不来）；再失败则 stopSelf 收口，
     * 由 JS 侧报「启动失败」，而不是把进程带走。
     */
    private fun startForegroundCompat() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "看屏幕",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.description = "悬浮窗正在获取屏幕画面"
            manager.createNotificationChannel(channel)
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pending = if (launch != null) {
            PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE)
        } else {
            null
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder.setContentTitle("看屏幕")
            .setContentText("悬浮窗已开启，点按悬浮球可截屏给角色看")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
        if (pending != null) builder.setContentIntent(pending)
        val notification = builder.build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 纵深防御：只有**当下确实持有有效授权凭据**时，才以前台服务的 mediaProjection
            // 类型启动。Android 14 对「带该类型但没有有效授权」直接抛 SecurityException，
            // 而这是可以从源头避免的——先问 Module 的进程级 token，没有再退化到普通前台服务。
            // （Module 现在会在 stopOverlay / invalidate / 本服务 onDestroy 三处清空 token，
            //  所以这里的判断是可信的；ON 时仍保留 catch 兜住系统侧的其它拒绝原因。）
            if (ScreenOverlayModule.hasValidCaptureToken()) {
                try {
                    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
                    return
                } catch (error: Exception) {
                    // 授权失效是预期路径（用户关掉又开、锁屏后系统回收），不是异常崩溃点。
                    Log.w(TAG, "startForeground(mediaProjection) failed, falling back: ${error.message}")
                    ScreenOverlayModule.recordTrace("fgs-fallback", error.message ?: "SecurityException")
                }
            } else {
                // 没有有效凭据：不发 mediaProjection 类型（那必然被拒）。采集随后由
                // onStartCommand → setupProjection 单独把关：拿不到投影就 emitCaptureFailed，
                // 由 JS 引导用户重新授权，而不是在起服务这一步崩掉。
                ScreenOverlayModule.recordTrace("fgs-no-token", "skip mediaProjection type")
            }
        }
        try {
            // 降级：不带类型的前台服务。
            //
            // ⚠️ 诚实说明：Android 14 起，不带类型调用时会**回退使用 manifest 声明的类型**
            // （本服务声明的是 mediaProjection），所以这一次大概率会以同样的原因再抛一次。
            // 它的真实价值不是「降级成功」，而是**把异常关在闸里**：下面还有一层 catch，
            // 最终走 stopSelf + JS 报错，而不是让 SecurityException 冒到顶层把进程带走。
            // 原生侧无法自行修好授权（只有 JS 重新弹窗才能拿到新 token），所以这里不假装能救，
            // 只保证「崩」变成「明确失败」。
            startForeground(NOTIFICATION_ID, notification)
        } catch (error: Exception) {
            Log.w(TAG, "startForeground fallback failed: ${error.message}")
            ScreenOverlayModule.recordTrace("fgs-failed", error.message ?: "unknown")
            // 前台服务起不来：收口退出，让 JS 报「启动失败」，绝不崩进程。
            stopSelf()
        }
    }

    // ---------- 悬浮视图 ----------

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

    // 悬浮球要用**本应用的图标**，不是自绘的字球。
    // 优先系统登记的图标资源（packageManager 里存的就是桌面显示的那一个，Expo/RN
    // 模板改名也命中）；找不到再按常见资源名回退（Expo prebuild 生成的是 ic_launcher /
    // ic_launcher_round，写成 `resources.getIdentifier("icon", ...)` 必然找不到 →
    // 一直回退成「看」字球，这正是用户看到「图标没换」的原因）。
    private fun resolveAppIconDrawable(): android.graphics.drawable.Drawable? {
        try {
            val info = packageManager.getApplicationInfo(packageName, 0)
            if (info.icon != 0) {
                androidx.core.content.res.ResourcesCompat.getDrawable(resources, info.icon, null)
                    ?.let { return it }
            }
        } catch (error: Exception) {
            Log.w(TAG, "app icon lookup failed: ${error.message}")
        }
        for (name in listOf("ic_launcher_round", "ic_launcher", "icon")) {
            val iconId = resources.getIdentifier(name, "mipmap", packageName)
            if (iconId == 0) continue
            try {
                androidx.core.content.res.ResourcesCompat.getDrawable(resources, iconId, null)
                    ?.let { return it }
            } catch (error: Exception) {
                Log.w(TAG, "app icon $name unavailable: ${error.message}")
            }
        }
        return null
    }

    private fun createOverlayView() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.TOP or Gravity.START
        params.x = dp(16)
        params.y = dp(160)

        rootView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        // ⚠️ 拖拽监听挂在 rootView 上会**抢走消息区的滚动**（子 View 的 touch 先到父级
        // onTouchListener，ScrollView 拿不到拖动）。所以只给「非滚动区」挂：收起态整颗球、
        // 展开态标题行（见 showCollapsed / showExpanded）。
        windowManager.addView(rootView, params)
        showCollapsed()
    }

    private fun showCollapsed() {
        expanded = false
        statusView = null
        titleView = null
        // SW3：收起态清掉聊天视图引用（面板已从树上摘除，留着就是悬挂引用——
        // pushChatMessage 会往一个不在屏幕上的 ScrollView 里塞内容）。
        // 消息内容本身保留在 chatHistory 里，展开时重建。
        chatMessages = null
        chatInput = null
        scopeButton = null
        rootView.removeAllViews()
        val size = dp(52)
        val icon = circularAppIcon(size)
        val ball = if (icon != null) {
            ImageView(this).apply {
                setImageDrawable(icon)
                scaleType = ImageView.ScaleType.CENTER_CROP
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor("#6c63ff"))
                }
            }
        } else {
            // 取不到 App 图标时回退文字球：悬浮球必须始终可点。
            TextView(this).apply {
                text = "看"
                setTextColor(Color.WHITE)
                textSize = 16f
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor("#6c63ff"))
                }
            }
        }
        rootView.addView(ball, LinearLayout.LayoutParams(size, size))
        // 收起态：整颗球都可拖（也能点开）——球不是滚动区，挂这里不抢任何东西。
        ball.setOnTouchListener(dragListener)
    }

    // 悬浮球头像：App 图标圆裁（用户要求别再显示一个「看」字）。
    // 图标是自适应启动图时可能带背景，直接圆裁即可；任何异常一律回退 null 走文字球。
    private fun circularAppIcon(size: Int): android.graphics.drawable.Drawable? {
        return try {
            val source = resolveAppIconDrawable() ?: return null
            val full = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val fullCanvas = android.graphics.Canvas(full)
            source.setBounds(0, 0, size, size)
            source.draw(fullCanvas)
            val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                shader = android.graphics.BitmapShader(
                    full,
                    android.graphics.Shader.TileMode.CLAMP,
                    android.graphics.Shader.TileMode.CLAMP
                )
            }
            android.graphics.Canvas(output).drawCircle(size / 2f, size / 2f, size / 2f, paint)
            android.graphics.drawable.BitmapDrawable(resources, output)
        } catch (error: Exception) {
            Log.w(TAG, "app icon unavailable: ${error.message}")
            null
        }
    }

    private fun showExpanded() {
        expanded = true
        rootView.removeAllViews()
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(Color.parseColor("#E62d2d44"))
            }
        }
        // 标题行：标题 + scope 切换按钮（SW3⑤：工作区 ⇄ 聊天）。
        // 展开态的拖拽挂在这一行（不是 rootView）——否则会抢走消息区的滚动。
        val titleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setOnTouchListener(dragListener)
        }
        val title = TextView(this).apply {
            text = overlayTitle()
            setTextColor(Color.parseColor("#6c63ff"))
            textSize = 13f
            maxWidth = dp(150)
        }
        titleRow.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        titleView = title
        val scopeBtn = button(scopeLabel()) { toggleChatScope() }
        scopeButton = scopeBtn
        titleRow.addView(scopeBtn)
        panel.addView(titleRow)

        val status = TextView(this).apply {
            text = "点「截屏」让角色看看现在的屏幕"
            setTextColor(Color.WHITE)
            textSize = 12f
            maxWidth = dp(220)
            setPadding(0, dp(6), 0, dp(8))
        }
        panel.addView(status)
        statusView = status

        // SW3：消息区（ScrollView + 动态文本行，上限 CHAT_MESSAGE_MAX 条）。
        val messages = ScrollView(this).apply {
            // 悬浮窗内滚动：容器高度固定，内容超出由 ScrollView 自己滚。
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(140)
            )
        }
        chatMessages = messages
        panel.addView(messages)
        // 收起期间收到的消息在这里补齐（留档见 chatHistory）。
        renderChatHistory()

        // SW3：输入行（EditText + 发送 + 收起）。
        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(6), 0, 0)
        }
        val input = EditText(this).apply {
            hint = "说点什么…"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#8a8aa8"))
            textSize = 12f
            maxLines = 3
            background = GradientDrawable().apply {
                cornerRadius = dp(9).toFloat()
                setColor(Color.parseColor("#3a3a5a"))
            }
            setPadding(dp(8), dp(6), dp(8), dp(6))
        }
        chatInput = input
        // SW3 键盘坑：悬浮窗默认挂 FLAG_NOT_FOCUSABLE（可拖拽、不抢焦点）——点输入框前
        // 必须动态去掉它才能弹输入法，失焦再装回去（不装回去拖拽与后台点击会被输入框吸走）。
        input.setOnFocusChangeListener { _, hasFocus -> setFocusableForInput(hasFocus) }
        inputRow.addView(input, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        inputRow.addView(button("发送") { sendChatFromInput() })
        panel.addView(inputRow)

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        actions.addView(button("截屏") { requestCaptureFromButton() })
        actions.addView(button("说话") { focusInput() })
        actions.addView(button("收起") { showCollapsed() })
        actions.addView(button("关闭") { stopSelf() })
        panel.addView(actions)

        rootView.addView(panel, LinearLayout.LayoutParams(dp(236), LinearLayout.LayoutParams.WRAP_CONTENT))
    }

    // ---- SW3：mini 聊天 ----

    // scope 按钮文案：显示**当前**作用域（点一下切到另一个）。
    private fun scopeLabel(): String =
        if (chatScope == SCOPE_WORKSPACE) "工作区" else "聊天"

    private fun toggleChatScope() {
        chatScope = if (chatScope == SCOPE_WORKSPACE) SCOPE_CHAT else SCOPE_WORKSPACE
        scopeButton?.text = scopeLabel()
        // 切换只改 scope、不清消息（用户要求：切种类不该丢上下文）。
    }

    // 用户在悬浮窗里发了话：交给 JS（LLM/工具/确认全在 JS 侧），原生只做嘴和眼。
    private fun sendChatFromInput() {
        val text = chatInput?.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        chatInput?.setText("")
        appendChatMessage("user", text)
        ScreenOverlayModule.emit(EVENT_CHAT_SEND, Arguments.createMap().apply {
            putString("text", text)
            putString("scope", chatScope)
        })
    }

    // JS 推回一条消息（回复或确认题卡）→ 渲染成气泡/按钮组。
    fun pushChatMessage(role: String?, text: String?) {
        mainHandler.post {
            appendChatMessage(if (role == "user") "user" else "assistant", text.orEmpty())
        }
    }

    private fun appendChatMessage(role: String, text: String) {
        if (text.isBlank()) return
        // 先留档（视图可能不存在：收起态收到推送），再画（视图在就同步渲染）。
        chatHistory.add(role to text)
        while (chatHistory.size > CHAT_MESSAGE_MAX) {
            chatHistory.removeAt(0)
        }
        renderChatMessage(role, text)
    }

    // 把一条消息画进消息区（视图不在时静默——留档已在 appendChatMessage 完成，
    // 展开时 renderChatHistory 会补齐）。
    private fun renderChatMessage(role: String, text: String) {
        val container = chatMessages ?: return
        if (text.isBlank()) return
        val line = TextView(this).apply {
            this.text = (if (role == "user") "我：" else "") + text
            setTextColor(if (role == "user") Color.parseColor("#c9c9e6") else Color.WHITE)
            textSize = 12f
            setPadding(dp(6), dp(4), dp(6), dp(4))
        }
        container.addView(line)
        // 上限裁剪：只留最近 CHAT_MESSAGE_MAX 条（长会话不把悬浮窗撑爆）。
        while (container.childCount > CHAT_MESSAGE_MAX) {
            container.removeViewAt(0)
        }
        container.post { container.fullScroll(View.FOCUS_DOWN) }
    }

    // 展开时把留档的消息重画一遍（收起态收到的推送不丢）。
    private fun renderChatHistory() {
        val container = chatMessages ?: return
        container.removeAllViews()
        for ((role, text) in chatHistory) {
            val line = TextView(this).apply {
                this.text = (if (role == "user") "我：" else "") + text
                setTextColor(if (role == "user") Color.parseColor("#c9c9e6") else Color.WHITE)
                textSize = 12f
                setPadding(dp(6), dp(4), dp(6), dp(4))
            }
            container.addView(line)
        }
        container.post { container.fullScroll(View.FOCUS_DOWN) }
    }

    // 输入焦点切换：点输入框要能弹键盘（去掉 FLAG_NOT_FOCUSABLE），失焦再装回去
    //（不装回去的话拖拽与后台点击会被输入框吸走）。
    //
    // ⚠️ FLAG_ALT_FOCUSABLE_IM 的语义（别用反）：它是**反转**「本窗口是否需要输入法」——
    // 在窗口**可获焦点**（NOT_FOCUSABLE 已清）时置上它，等于宣告「本窗口不需要输入法」，
    // 反而**挡住 IME**；在窗口不可获焦点时置上它，才是「我需要输入法」。
    // 所以这里聚焦时两个 flag 都要**清**（NOT_FOCUSABLE 清掉才能获焦点，ALT_FOCUSABLE_IM
    // 清掉才允许 IME）；失焦时只装回 NOT_FOCUSABLE。
    private fun setFocusableForInput(focusable: Boolean) {
        try {
            params.flags = if (focusable) {
                // ⚠️ 必须**同时补回 FLAG_NOT_TOUCH_MODAL**（bug③「小窗以外全部卡死」的根因）。
                //
                // Android 的窗口规则：置上 FLAG_NOT_FOCUSABLE 会**隐含启用**
                // FLAG_NOT_TOUCH_MODAL（官方文档原文：This flag will also enable
                // FLAG_NOT_TOUCH_MODAL whether or not that is explicitly set）。
                // 于是清掉 NOT_FOCUSABLE 让窗口可获焦点的**同一瞬间**，那个隐含的
                // NOT_TOUCH_MODAL 也一起消失——窗口立刻变成 touch-modal：悬浮窗矩形以外的
                // 所有触摸事件都被本窗口吞掉（窗口自己并不处理它们），下层 app / 桌面
                // 怎么滑都没反应。触发路径就是用户点输入框说话。
                // 所以聚焦分支必须显式把 NOT_TOUCH_MODAL 置回去。
                (params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() and
                    WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM.inv()) or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
            } else {
                // 失焦：装回 NOT_FOCUSABLE（它隐含 NOT_TOUCH_MODAL，无需重复声明）。
                params.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            }
            windowManager.updateViewLayout(rootView, params)
            // FIX-4 第 5 条：键盘/焦点问题（「小窗以外滑不动」「下命令时卡死」里的 window 层级
            // 部分）远程无法定死是哪一行，只能靠现场数据。这里把每次焦点切换后的实际 flags
            // 写进诊断日志——真机复现时能直接看到触屏不可获焦期间 flags 到底是什么值。
            ScreenOverlayModule.recordTrace(
                if (focusable) "focus-on" else "focus-off",
                "flags=0x${Integer.toHexString(params.flags)}"
            )
        } catch (error: Exception) {
            Log.w(TAG, "focus flag update failed: ${error.message}")
            // 失败也要留痕：焦点没切成功会导致键盘弹不出来或点击被吸走，属于同一类现场。
            ScreenOverlayModule.recordTrace("focus-failed", error.message ?: "unknown")
        }
    }

    // 键盘弹起时把面板上移（悬浮窗在屏幕下半部时输入框会被输入法盖住）。
    // baseY 用**可空**而不是 0 哨兵：拖到顶部时 y 的合法值就是 0，用 0 当「未捕获」
    // 会让复位错位；拖拽时清空它（下次 inset 重新捕获当前落点）。
    fun applyImeInset(insetBottom: Int) {
        mainHandler.post {
            try {
                val anchor = baseY ?: params.y.also { baseY = it }
                params.y = if (insetBottom > 0) maxOf(0, anchor - insetBottom) else anchor
                windowManager.updateViewLayout(rootView, params)
                // 键盘开合是 window 层级故障的高发时刻：记下 inset 与落点，便于真机回归定位。
                ScreenOverlayModule.recordTrace("ime-inset", "inset=$insetBottom y=${params.y}")
            } catch (error: Exception) {
                Log.w(TAG, "ime inset failed: ${error.message}")
                ScreenOverlayModule.recordTrace("ime-inset-failed", error.message ?: "unknown")
            }
        }
    }

    private fun button(label: String, onClick: () -> Unit): TextView {
        return TextView(this).apply {
            text = label
            setTextColor(Color.WHITE)
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(6), dp(10), dp(6))
            background = GradientDrawable().apply {
                cornerRadius = dp(9).toFloat()
                setColor(Color.parseColor("#3a3a5a"))
            }
            setOnClickListener { onClick() }
        }
    }

    private val dragListener = View.OnTouchListener { _, event ->
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.rawX
                downY = event.rawY
                startX = params.x
                startY = params.y
                dragged = false
                // 拖拽落点变了：作废键盘 inset 的基准（下次 inset 重新捕获）。
                baseY = null
                true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - downX
                val dy = event.rawY - downY
                if (abs(dx) > touchSlop || abs(dy) > touchSlop) dragged = true
                params.x = startX + dx.roundToInt()
                params.y = startY + dy.roundToInt()
                try {
                    windowManager.updateViewLayout(rootView, params)
                } catch (error: Exception) {}
                true
            }
            MotionEvent.ACTION_UP -> {
                if (!dragged && !expanded) showExpanded()
                true
            }
            else -> false
        }
    }
    private var downX = 0f
    private var downY = 0f
    private var startX = 0
    private var startY = 0
    private var dragged = false
    private val touchSlop: Int by lazy { ViewConfiguration.get(this).scaledTouchSlop }

    // 小窗标题：优先显示当前角色名（用户要求顶部不再固定写「看屏幕」），未设置时回退原题。
    private fun overlayTitle(): String = characterName.ifEmpty { "看屏幕" }

    // 入参用可空类型：Kotlin 的 String 没有「以 String 为参数」的构造函数
    // （Java 的 new String(s) 在这里不存在，写 String(name ?: "") 会直接编译失败），
    // 可空值用 elvis 兜底即可。JS 桥侧也可能传 null，这里一并挡掉。
    fun setCharacterName(name: String?) {
        characterName = (name ?: "").trim()
        mainHandler.post { titleView?.text = overlayTitle() }
    }

    fun setStatusText(text: String) {
        val value = text.trim()
        mainHandler.post {
            statusView?.text = value.ifEmpty { "点「截屏」让角色看看现在的屏幕" }
        }
    }

    private fun requestCaptureFromButton() {
        setStatusText("正在看…")
        ScreenOverlayModule.emit(EVENT_REQUEST_CAPTURE, Arguments.createMap())
    }

    // 「说话」（M1 临时形态）：**只把焦点交给输入框**，不再跳 App。
    //
    // 原实现是 openAppForTalk()：从 Service 里 startActivity 把 RN 主 Activity 拉起来。
    // 那是 bug④（卡死 → 悬浮窗消失 → app 呈重启状）的 ANR 源头：焦点持有 + IME 绑在
    // overlay 窗口 + 主线程被 Activity 启动/RN 恢复/IME 焦点协商一起堵住 → 输入事件
    // 5 秒未分发 → ANR → 系统杀进程 → 前台服务与悬浮窗陪葬 → 再打开就是冷启动。
    // 新架构的总纲是「原生完全体，JS 降级为编辑器」，悬浮窗**永不** startActivity；
    // 与外界 app 的唯一合规交互是通知 PendingIntent（见 startForegroundCompat）。
    //
    // M3 会把这里换成窗内录音（AudioRecord → ASR）；在那之前先聚焦输入框，
    // 保证按钮始终有反应，且不引入任何跨进程/跨 Activity 的隐患。
    private fun focusInput() {
        val input = chatInput
        if (input == null) {
            // 收起态没有输入框：先展开再聚焦，用户点一下就能开始打字。
            showExpanded()
            mainHandler.post { chatInput?.requestFocus() }
            setStatusText("说点什么…")
            return
        }
        input.requestFocus()
        // 键盘的显示交给输入法自己决定（窗口已可获焦点），这里不主动调 InputMethodManager——
        // 从 Service 强制 showSoftInput 在部分 ROM 上需要 token，失败后反而更难查。
        setStatusText("说点什么…")
    }

    fun requestCapture() {
        // RN 桥从 native modules 线程调用；采集状态（captureRequested / 兜底位图）
        // 全在主线程读写——跨线程 recycle 与解码交错会直接崩（recycled bitmap）。
        mainHandler.post { requestCaptureOnMain() }
    }

    private fun requestCaptureOnMain() {
        if (projection == null || imageReader == null) {
            // 投影未建立（授权被拒 / 已被系统回收 / 服务重建）：
            // 以前这里静默丢弃请求，JS 只能等 6s 超时；现在明确回报失败。
            emitCaptureFailed("no-projection")
            return
        }
        captureRequested = true
        captureRequestedAtNanos = System.nanoTime()
        pendingStaleBitmap?.recycle()
        pendingStaleBitmap = null
        setStatusText("正在看…")
        ScreenOverlayModule.recordTrace("capture-request", "start")
        // 兜底交付：屏幕完全静止（在别的应用里停着不动）时既不产生新帧、重挂载也
        // 可能只吐回旧帧，没有兜底就只能等 JS 侧 6s 超时报失败——用户看到的现象是
        // 「只有 App 内（画面一直在动）能截到，App 外永远失败」。
        mainHandler.removeCallbacks(captureFallback)
        mainHandler.postDelayed(captureFallback, CAPTURE_FALLBACK_DELAY_MS)
        // 硬超时挂**工作线程**：主线程被卡住/被 ROM 冻结时，兜底定时器会一起失灵，
        // 这个仍然到点触发（见 onCaptureTimeout）。
        workerHandler?.let { handler ->
            handler.removeCallbacks(captureTimeout)
            handler.postDelayed(captureTimeout, CAPTURE_HARD_TIMEOUT_MS)
        }
        // 静态画面可能不产生新帧：强制刷新一次 surface 以触发 ImageReader 回调。
        try {
            virtualDisplay?.setSurface(null)
            virtualDisplay?.setSurface(imageReader?.surface)
        } catch (error: Exception) {}
    }

    // 兜底交付：优先请求期间收到的旧帧，其次最近缓存的像素（屏幕没变过时两者
    // 都等于当前画面）；都没有才报失败。跑在主线程（只做判定），解码/落盘交给工作线程。
    private fun deliverFallbackFrame() {
        if (!captureRequested) return
        captureRequested = false
        workerHandler?.removeCallbacks(captureTimeout)
        val stale = pendingStaleBitmap
        pendingStaleBitmap = null
        if (stale != null) {
            // 旧帧已经是解码好的位图：直接移交工作线程压缩落盘。
            val handler = workerHandler
            if (handler != null) handler.post { saveAndEmit(stale) } else stale.recycle()
            return
        }
        // 没有解码好的旧帧：用缓存像素在工作线程解码 + 落盘（解码也是重活）。
        val handler = workerHandler
        if (handler == null) {
            emitCaptureFailed("no-frame")
            return
        }
        handler.post {
            val bitmap = bitmapFromCachedFrame()
            if (bitmap != null) {
                saveAndEmit(bitmap)
            } else {
                mainHandler.post { emitCaptureFailed("no-frame") }
            }
        }
    }

    // 维护「最近一帧」缓存（节流）：屏幕静止后不会再有新帧，这份拷贝就是当前画面。
    // 只拷像素不解码，开销是纯内存拷贝；解码推迟到真正要用时。
    private fun cacheFrameBytes(image: Image) {
        val now = System.nanoTime()
        if (now - lastFrameCachedAtNanos < FRAME_CACHE_INTERVAL_NANOS) return
        val plane = image.planes.firstOrNull() ?: return
        val buffer = plane.buffer
        val bytes = ByteArray(buffer.remaining())
        if (bytes.isEmpty()) return
        buffer.duplicate().get(bytes)
        lastFrameCopy = bytes
        lastFrameRowStride = plane.rowStride
        lastFramePixelStride = plane.pixelStride
        lastFrameCachedAtNanos = now
    }

    // 缓存像素 → Bitmap：与 imageToBitmap 同一套行距裁剪逻辑（含 rowPadding）。
    private fun bitmapFromCachedFrame(): Bitmap? {
        val bytes = lastFrameCopy ?: return null
        if (width <= 0 || height <= 0) return null
        val pixelStride = lastFramePixelStride
        val rowStride = lastFrameRowStride
        if (pixelStride <= 0 || rowStride <= 0) return null
        val rowPadding = rowStride - pixelStride * width
        if (rowPadding < 0) return null
        val paddedWidth = width + rowPadding / pixelStride
        // ARGB_8888 每像素 4 字节：拷贝字节数不足就直接放弃（宁可不交帧也不越界崩）。
        if (paddedWidth * height * 4 > bytes.size) return null
        return try {
            val padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
            padded.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(bytes))
            val cropped = Bitmap.createBitmap(padded, 0, 0, width, height)
            if (cropped !== padded) padded.recycle()
            cropped
        } catch (error: Exception) {
            Log.w(TAG, "cached frame decode failed: ${error.message}")
            null
        }
    }

    // 采集失败统一出口：JS 侧据此中止评论并提示，避免「截不到图却一直在评论」。
    private fun emitCaptureFailed(reason: String) {
        captureRequested = false
        mainHandler.removeCallbacks(captureFallback)
        workerHandler?.removeCallbacks(captureTimeout)
        pendingStaleBitmap?.recycle()
        pendingStaleBitmap = null
        // 失败也要复位状态文字：否则小窗永远停在「正在看…」，用户以为卡死（真机 bug）。
        setStatusText("")
        ScreenOverlayModule.recordTrace("capture-failed", reason)
        ScreenOverlayModule.emit(EVENT_CAPTURE_FAILED, Arguments.createMap().apply {
            putString("reason", reason)
        })
    }

    // 硬超时（跑在**工作线程**，主线程被冻结也照样到点）：无论哪条路径卡死，
    // 到点必回报 + 复位状态文字。JS 侧另有 6s 超时，但 native 被冻结时 JS 定时器
    // 同样不准，所以两道都要有。
    private fun onCaptureTimeout() {
        if (!captureRequested) return
        Log.w(TAG, "capture hard timeout")
        mainHandler.post {
            if (captureRequested) emitCaptureFailed("timeout")
        }
    }

    // ---------- 屏幕采集 ----------

    private fun setupProjection(resultCode: Int, data: Intent) {
        val manager = getSystemService(MediaProjectionManager::class.java) ?: run {
            emitCaptureFailed("no-manager")
            return
        }
        // **整段 try-catch**：getMediaProjection 对失效 token（对应的 projection 已被 stop）
        // 在 Android 14 上抛 IllegalStateException。旧代码没有捕获 ⇒ 直接崩进程，
        // 用户看到「关掉再开 → 闪退」。这里一律转成可处置的失败回报，绝不裸崩。
        val mp = try {
            manager.getMediaProjection(resultCode, data)
        } catch (error: Exception) {
            Log.w(TAG, "getMediaProjection failed: ${error.message}")
            // token 已失效：清掉 Module 侧缓存，下次必须重新授权（否则会反复撞同一处）。
            ScreenOverlayModule.clearCaptureToken()
            ScreenOverlayModule.recordTrace("projection-invalid", error.message ?: "IllegalStateException")
            emitCaptureFailed("projection-invalid")
            return
        }
        if (mp == null) {
            ScreenOverlayModule.clearCaptureToken()
            emitCaptureFailed("projection-denied")
            return
        }
        projection = mp
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                // 投屏被系统停止（锁屏、系统弹窗点「停止」、被其他应用抢占）时，
                // 只 releaseCapture() 会留下孤儿悬浮窗 + 前台服务，UI 仍显示「已开启」
                // 而采集已死。stopSelf() 走 onDestroy 统一收口（释放采集、移除悬浮窗、
                // 停前台通知、复位 isRunning 并广播状态）；不能在回调里再 projection.stop()。
                stopSelf()
            }
        }, Handler(Looper.getMainLooper()))

        val metrics = resources.displayMetrics
        width = metrics.widthPixels
        height = metrics.heightPixels
        density = metrics.densityDpi
        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        reader.setOnImageAvailableListener({ available ->
            // ⚠️ 本回调跑在**主线程**（下面的 mainHandler），所以这里只做「取帧 + 移交」，
            // 绝不做解码/压缩/落盘——那三件事几百毫秒起，会把主线程连同全部兜底一起堵死。
            val image = try {
                available.acquireLatestImage()
            } catch (error: Exception) {
                null
            }
            if (image != null) {
                // 像素必须在 image 存活期内拷出来（image.close() 后 buffer 失效），
                // 但拷贝本身很快（纯内存），且解码推迟到工作线程。
                handleFrameOnMain(image)
            }
        }, mainHandler)
        imageReader = reader
        virtualDisplay = mp.createVirtualDisplay(
            "easychat-screenwatch",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            null
        )
    }

    /**
     * 主线程上的帧处理：**只做状态判定 + 把像素移交工作线程**。
     *
     * 关键：`Image` 的 buffer 在 `image.close()` 之后即失效，所以必须在关闭前把像素
     * 拷成 ByteArray（纯内存拷贝，微秒级），再交给工作线程去解码成 Bitmap 并压缩落盘。
     */
    private fun handleFrameOnMain(image: Image) {
        try {
            // 每次回调都维护「最近一帧」缓存（内部节流）：屏幕静止后不再有新帧，
            // 这份拷贝就是当前画面，兜底交付时用它。
            cacheFrameBytes(image)
            if (!captureRequested) return
            // 优先本次请求之后产生的帧（Image.timestamp 与 System.nanoTime 同源）：
            // 重挂载 Surface 可能先吐出旧帧，直接采用会拿到过期画面。
            // timestamp 不可靠（<= 0）的机型跳过校验，避免误杀导致永久截不到。
            val fresh = image.timestamp <= 0L
                || image.timestamp >= captureRequestedAtNanos - FRAME_FRESHNESS_SLACK_NANOS
            if (fresh) {
                // 先抢下这次请求（置 false 并撤掉兜底），后续解码在工作线程完成。
                captureRequested = false
                mainHandler.removeCallbacks(captureFallback)
                workerHandler?.removeCallbacks(captureTimeout)
                pendingStaleBitmap?.recycle()
                pendingStaleBitmap = null
                val copy = copyPlane(image)
                if (copy == null) {
                    emitCaptureFailed("decode-failed")
                } else {
                    decodeAndEmit(copy)
                }
            } else if (pendingStaleBitmap == null) {
                // 旧帧不丢：屏幕没变时它就是当前画面，作为兜底候选留给
                // deliverFallbackFrame；此后若有新鲜帧到达，它会被作废。
                // 旧帧也要解码，同样挪到工作线程。
                val copy = copyPlane(image)
                if (copy != null) decodeStale(copy)
            }
        } catch (error: Exception) {
            Log.w(TAG, "capture frame failed: ${error.message}")
            emitCaptureFailed("frame-error")
        } finally {
            image.close()
        }
    }

    // ---- 像素拷贝（主线程，微秒级）与解码（工作线程，几百毫秒级）----

    // 帧像素快照：必须在 image.close() 之前调用（close 后 buffer 失效）。
    // 只做内存拷贝，不解码——解码是重活，交给工作线程。
    private class PlaneCopy(
        val bytes: ByteArray,
        val pixelStride: Int,
        val rowStride: Int,
        val width: Int,
        val height: Int
    )

    private fun copyPlane(image: Image): PlaneCopy? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val bytes = ByteArray(buffer.remaining())
        if (bytes.isEmpty()) return null
        buffer.duplicate().get(bytes)
        return PlaneCopy(bytes, plane.pixelStride, plane.rowStride, width, height)
    }

    // 拷贝 → Bitmap：与 bitmapFromCachedFrame 同一套行距裁剪逻辑（含 rowPadding）。
    // **纯计算**，可在工作线程调用。
    private fun decodePlane(copy: PlaneCopy): Bitmap? {
        if (copy.width <= 0 || copy.height <= 0) return null
        if (copy.pixelStride <= 0 || copy.rowStride <= 0) return null
        val rowPadding = copy.rowStride - copy.pixelStride * copy.width
        if (rowPadding < 0) return null
        val paddedWidth = copy.width + rowPadding / copy.pixelStride
        // ARGB_8888 每像素 4 字节：拷贝字节数不足就直接放弃（宁可不交帧也不越界崩）。
        if (paddedWidth * copy.height * 4 > copy.bytes.size) return null
        return try {
            val padded = Bitmap.createBitmap(paddedWidth, copy.height, Bitmap.Config.ARGB_8888)
            padded.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(copy.bytes))
            val cropped = Bitmap.createBitmap(padded, 0, 0, copy.width, copy.height)
            if (cropped !== padded) padded.recycle()
            cropped
        } catch (error: Exception) {
            Log.w(TAG, "frame decode failed: ${error.message}")
            null
        }
    }

    // 新鲜帧：在工作线程解码 + 压缩落盘 + 回报。decodeAndEmit 的名字保留「解码并交付」语义。
    private fun decodeAndEmit(copy: PlaneCopy) {
        val handler = workerHandler
        if (handler == null) {
            // 工作线程已退出（服务正在销毁）：直接放弃这一帧，不阻塞主线程。
            return
        }
        handler.post {
            val bitmap = decodePlane(copy)
            if (bitmap != null) {
                saveAndEmit(bitmap)
            } else {
                // 解码失败发生在工作线程：emit 本身是线程安全的（走 RN 事件通道）。
                mainHandler.post { emitCaptureFailed("decode-failed") }
            }
        }
    }

    // 旧帧：在工作线程解码成兜底候选位图（供 deliverFallbackFrame 使用）。
    private fun decodeStale(copy: PlaneCopy) {
        val handler = workerHandler ?: return
        handler.post {
            val bitmap = decodePlane(copy)
            if (bitmap != null) {
                // pendingStaleBitmap 只在主线程读写（与 recycle 竞争会崩），所以回主线程落位。
                mainHandler.post {
                    if (pendingStaleBitmap == null && captureRequested) {
                        pendingStaleBitmap = bitmap
                    } else {
                        // 已经有更新鲜的候选 / 请求已结束：这份多余，就地回收。
                        bitmap.recycle()
                    }
                }
            }
        }
    }

    // 交付一帧：**跑在工作线程**（解码 + JPEG 压缩 + 落盘都是重活，不能占主线程）。
    // emit 走 RN 事件通道，本身线程安全；bitmap 在本函数内回收，不跨线程共享。
    private fun saveAndEmit(bitmap: Bitmap) {
        val startedAt = System.currentTimeMillis()
        try {
            val dir = File(filesDir, "screen-watch")
            if (!dir.exists()) dir.mkdirs()
            val file = File(dir, "sw-${System.currentTimeMillis().toString(36)}.jpg")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
            }
            ScreenOverlayModule.recordTrace("capture-saved", "${System.currentTimeMillis() - startedAt}ms")
            val map = Arguments.createMap().apply { putString("path", "file://${file.absolutePath}") }
            ScreenOverlayModule.emit(EVENT_CAPTURE, map)
        } catch (error: Exception) {
            Log.w(TAG, "save frame failed: ${error.message}")
            mainHandler.post { emitCaptureFailed("save-failed") }
        } finally {
            bitmap.recycle()
        }
    }

    private fun releaseCapture() {
        captureRequested = false
        mainHandler.removeCallbacks(captureFallback)
        workerHandler?.removeCallbacks(captureTimeout)
        pendingStaleBitmap?.recycle()
        pendingStaleBitmap = null
        lastFrameCopy = null
        lastFrameCachedAtNanos = 0L
        try {
            virtualDisplay?.release()
        } catch (error: Exception) {}
        virtualDisplay = null
        try {
            imageReader?.close()
        } catch (error: Exception) {}
        imageReader = null
        try {
            projection?.stop()
        } catch (error: Exception) {}
        projection = null
    }
}
