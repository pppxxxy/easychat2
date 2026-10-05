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
    // 重挂载 Surface 会先吐出旧帧，用它丢弃早于请求的帧。
    private var captureRequestedAtNanos = 0L
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
            val iconId = resources.getIdentifier("icon", "mipmap", packageName)
            val source = if (iconId != 0) {
                androidx.core.content.res.ResourcesCompat.getDrawable(resources, iconId, null)
            } else {
                null
            } ?: return null
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
        if (projection == null || imageReader == null) {
            // 投影未建立（授权被拒 / 已被系统回收 / 服务重建）：
            // 以前这里静默丢弃请求，JS 只能等 6s 超时；现在明确回报失败。
            emitCaptureFailed("no-projection")
            return
        }
        captureRequested = true
        captureRequestedAtNanos = System.nanoTime()
        setStatusText("正在看…")
        // 静态画面可能不产生新帧：强制刷新一次 surface 以触发 ImageReader 回调。
        try {
            virtualDisplay?.setSurface(null)
            virtualDisplay?.setSurface(imageReader?.surface)
        } catch (error: Exception) {}
    }

    // 采集失败统一出口：JS 侧据此中止评论并提示，避免「截不到图却一直在评论」。
    private fun emitCaptureFailed(reason: String) {
        captureRequested = false
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
                    if (captureRequested) {
                        // 只接受本次请求之后产生的帧（Image.timestamp 与 System.nanoTime 同源）：
                        // 重挂载 Surface 会先吐出旧帧，采用它会让用户拿到过期画面却以为截到了当前
                        // 屏幕——这正是「App 外一直截不到、角色却一直在评论」的观感来源。
                        // timestamp 不可靠（<= 0）的机型跳过校验，避免误杀导致永久截不到。
                        val fresh = image.timestamp <= 0L
                            || image.timestamp >= captureRequestedAtNanos - FRAME_FRESHNESS_SLACK_NANOS
                        if (fresh) {
                            captureRequested = false
                            val bitmap = imageToBitmap(image)
                            if (bitmap != null) {
                                saveAndEmit(bitmap)
                            } else {
                                emitCaptureFailed("decode-failed")
                            }
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
