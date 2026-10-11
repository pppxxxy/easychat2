package com.pppxxxy.easychat2.screenoverlay

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
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
        super.invalidate()
    }

    private var resultCode: Int = Activity.RESULT_CANCELED
    private var resultData: Intent? = null
    private var pendingCapturePermission: Promise? = null

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_CAPTURE_PERMISSION) return
        this.resultCode = resultCode
        this.resultData = data
        val granted = resultCode == Activity.RESULT_OK && data != null
        pendingCapturePermission?.resolve(granted)
        pendingCapturePermission = null
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
        // RN 0.81：ReactContextBaseJavaModule.getCurrentActivity() 已改为（过时的）Kotlin
        // 函数，裸 currentActivity 不再合成属性；改用 ReactApplicationContext 的 Java getter。
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.resolve(false)
            return
        }
        try {
            val mpm = reactContext.getSystemService(MediaProjectionManager::class.java)
            if (mpm == null) {
                promise.resolve(false)
                return
            }
            pendingCapturePermission = promise
            activity.startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST_CAPTURE_PERMISSION)
        } catch (e: Exception) {
            pendingCapturePermission = null
            promise.reject("ERR_CAPTURE_PERMISSION", e.message, e)
        }
    }

    @ReactMethod
    fun startOverlay(promise: Promise) {
        try {
            if (!Settings.canDrawOverlays(reactContext)) {
                promise.resolve(false)
                return
            }
            val data = resultData
            if (resultCode != Activity.RESULT_OK || data == null) {
                promise.resolve(false)
                return
            }
            val intent = Intent(reactContext, OverlayService::class.java).apply {
                putExtra(OverlayService.EXTRA_RESULT_CODE, resultCode)
                putExtra(OverlayService.EXTRA_RESULT_DATA, data)
            }
            requestNotificationPermissionIfNeeded()
            ContextCompat.startForegroundService(reactContext, intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_START_OVERLAY", e.message, e)
        }
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
            val enabled = TextUtils.SimpleStringSplitter(':').apply { setString(raw) }
                .asSequence()
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

    companion object {
        private const val REQUEST_CAPTURE_PERMISSION = 0x5C01
        private const val REQUEST_POST_NOTIFICATIONS = 0x5C03
        private const val TAG = "ScreenOverlay"
        @Volatile private var contextRef: WeakReference<ReactApplicationContext>? = null

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
    }
}
