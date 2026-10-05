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
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
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
        private const val TAG = "ScreenOverlay"
        private const val NOTIFICATION_ID = 0x5C02
        private const val CHANNEL_ID = "screen_overlay"
        // 帧新鲜度校验的时序余量：请求与首帧落地之间有抖动，留 50ms 避免误杀合法帧。
        private const val FRAME_FRESHNESS_SLACK_NANOS = 50_000_000L
        // 兜底交付等待：屏幕静止时不产生新帧（跨应用看静态画面最常见的失败），
        // 等到这个时长就用请求期间收到的旧帧 / 最近缓存帧交付，而不是让 JS 干等超时。
        private const val CAPTURE_FALLBACK_DELAY_MS = 700L
        // 「最近一帧」缓存节流：屏幕持续变化时最多每 500ms 拷一份像素，
        // 避免看视频时每帧都做一次全屏内存拷贝。
        private const val FRAME_CACHE_INTERVAL_NANOS = 500_000_000L

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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        isRunning = true
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
        try {
            if (::rootView.isInitialized) windowManager.removeView(rootView)
        } catch (error: Exception) {}
        instance = null
        isRunning = false
        ScreenOverlayModule.emitState(false)
        super.onDestroy()
    }

    // ---------- 前台通知 ----------

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
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
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
        rootView.setOnTouchListener(dragListener)
        windowManager.addView(rootView, params)
        showCollapsed()
    }

    private fun showCollapsed() {
        expanded = false
        statusView = null
        titleView = null
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
        val title = TextView(this).apply {
            text = overlayTitle()
            setTextColor(Color.parseColor("#6c63ff"))
            textSize = 13f
            maxWidth = dp(212)
        }
        panel.addView(title)
        titleView = title
        val status = TextView(this).apply {
            text = "点「截屏」让角色看看现在的屏幕"
            setTextColor(Color.WHITE)
            textSize = 12f
            maxWidth = dp(220)
            setPadding(0, dp(6), 0, dp(8))
        }
        panel.addView(status)
        statusView = status

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        actions.addView(button("截屏") { requestCaptureFromButton() })
        actions.addView(button("说话") { openAppForTalk() })
        actions.addView(button("收起") { showCollapsed() })
        actions.addView(button("关闭") { stopSelf() })
        panel.addView(actions)

        rootView.addView(panel, LinearLayout.LayoutParams(dp(236), LinearLayout.LayoutParams.WRAP_CONTENT))
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

    // 「说话」：把 App 带到前台，用户在「看屏幕」面板里对角色说话——截屏前/后都能说，
    // 这些话与评论归入同一场对话（见 JS 侧 screenWatch/threads.js）。
    // 优先 deep link（将来可直达分段），失败退回普通启动，保证按钮始终有反应。
    private fun openAppForTalk() {
        val deepLink = try {
            Intent(Intent.ACTION_VIEW, android.net.Uri.parse("easychat2://screen-watch")).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
        } catch (error: Exception) {
            null
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val target = deepLink ?: launch ?: return
        try {
            startActivity(if (deepLink != null) deepLink else target)
            setStatusText("在 App 里说点什么，角色会记住这场对话")
        } catch (error: Exception) {
            // deep link 无人可处理时退回普通启动。
            try {
                if (launch != null) startActivity(launch)
            } catch (inner: Exception) {}
        }
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
        // 兜底交付：屏幕完全静止（在别的应用里停着不动）时既不产生新帧、重挂载也
        // 可能只吐回旧帧，没有兜底就只能等 JS 侧 6s 超时报失败——用户看到的现象是
        // 「只有 App 内（画面一直在动）能截到，App 外永远失败」。
        mainHandler.removeCallbacks(captureFallback)
        mainHandler.postDelayed(captureFallback, CAPTURE_FALLBACK_DELAY_MS)
        // 静态画面可能不产生新帧：强制刷新一次 surface 以触发 ImageReader 回调。
        try {
            virtualDisplay?.setSurface(null)
            virtualDisplay?.setSurface(imageReader?.surface)
        } catch (error: Exception) {}
    }

    // 兜底交付：优先请求期间收到的旧帧，其次最近缓存的像素（屏幕没变过时两者
    // 都等于当前画面）；都没有才报失败。新鲜帧先到时会取消本回调。
    private fun deliverFallbackFrame() {
        if (!captureRequested) return
        captureRequested = false
        val stale = pendingStaleBitmap
        pendingStaleBitmap = null
        val bitmap = stale ?: bitmapFromCachedFrame()
        if (bitmap != null) {
            saveAndEmit(bitmap)
        } else {
            emitCaptureFailed("no-frame")
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
        pendingStaleBitmap?.recycle()
        pendingStaleBitmap = null
        ScreenOverlayModule.emit(EVENT_CAPTURE_FAILED, Arguments.createMap().apply {
            putString("reason", reason)
        })
    }

    // ---------- 屏幕采集 ----------

    private fun setupProjection(resultCode: Int, data: Intent) {
        val manager = getSystemService(MediaProjectionManager::class.java) ?: run {
            emitCaptureFailed("no-manager")
            return
        }
        val mp = manager.getMediaProjection(resultCode, data) ?: run {
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
            val image = try {
                available.acquireLatestImage()
            } catch (error: Exception) {
                null
            }
            if (image != null) {
                try {
                    // 每次回调都维护「最近一帧」缓存（内部节流）：屏幕静止后不再有新帧，
                    // 这份拷贝就是当前画面，兜底交付时用它。
                    cacheFrameBytes(image)
                    if (captureRequested) {
                        // 优先本次请求之后产生的帧（Image.timestamp 与 System.nanoTime 同源）：
                        // 重挂载 Surface 可能先吐出旧帧，直接采用会拿到过期画面。
                        // timestamp 不可靠（<= 0）的机型跳过校验，避免误杀导致永久截不到。
                        val fresh = image.timestamp <= 0L
                            || image.timestamp >= captureRequestedAtNanos - FRAME_FRESHNESS_SLACK_NANOS
                        if (fresh) {
                            captureRequested = false
                            mainHandler.removeCallbacks(captureFallback)
                            pendingStaleBitmap?.recycle()
                            pendingStaleBitmap = null
                            val bitmap = imageToBitmap(image)
                            if (bitmap != null) {
                                saveAndEmit(bitmap)
                            } else {
                                emitCaptureFailed("decode-failed")
                            }
                        } else if (pendingStaleBitmap == null) {
                            // 旧帧不丢：屏幕没变时它就是当前画面，作为兜底候选留给
                            // deliverFallbackFrame；此后若有新鲜帧到达，它会被作废。
                            pendingStaleBitmap = imageToBitmap(image)
                        }
                    }
                } catch (error: Exception) {
                    Log.w(TAG, "capture frame failed: ${error.message}")
                    emitCaptureFailed("frame-error")
                } finally {
                    image.close()
                }
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

    private fun imageToBitmap(image: Image): Bitmap? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width
        val padded = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888)
        padded.copyPixelsFromBuffer(buffer)
        val cropped = Bitmap.createBitmap(padded, 0, 0, width, height)
        if (cropped !== padded) padded.recycle()
        return cropped
    }

    private fun saveAndEmit(bitmap: Bitmap) {
        try {
            val dir = File(filesDir, "screen-watch")
            if (!dir.exists()) dir.mkdirs()
            val file = File(dir, "sw-${System.currentTimeMillis().toString(36)}.jpg")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
            }
            val map = Arguments.createMap().apply { putString("path", "file://${file.absolutePath}") }
            ScreenOverlayModule.emit(EVENT_CAPTURE, map)
        } catch (error: Exception) {
            Log.w(TAG, "save frame failed: ${error.message}")
            emitCaptureFailed("save-failed")
        } finally {
            bitmap.recycle()
        }
    }

    private fun releaseCapture() {
        captureRequested = false
        mainHandler.removeCallbacks(captureFallback)
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
