package com.pppxxxy.easychat2.proactive

import android.content.Intent
import android.provider.Settings
import android.os.Build
import android.os.PowerManager
import android.net.Uri
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class ProactiveMessagePackage : com.facebook.react.ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext) =
        listOf(ProactiveMessageModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext) =
        emptyList<com.facebook.react.uimanager.ViewManager<*, *>>()
}

/**
 * RN 桥接模块：
 * - schedule/cancel/setApiSettings 供 JS 排定任务
 * - 通知点击通过 onNewIntent / 冷启动 intent 转成 onOpenRole 事件发给 JS
 */
class ProactiveMessageModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener, LifecycleEventListener {

    private var listenerCount = 0
    private var pendingRoleId: String? = null

    init {
        reactContext.addActivityEventListener(this)
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName() = "ProactiveMessage"

    private fun queueRoleOpen(roleId: String) {
        pendingRoleId = roleId
        drain()
    }

    private fun drain() {
        val roleId = pendingRoleId ?: return
        if (listenerCount <= 0) return
        pendingRoleId = null
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_OPEN_ROLE, roleId)
    }

    override fun onNewIntent(intent: Intent) {
        intent.getStringExtra(Notifier.EXTRA_ROLE_ID)?.let { queueRoleOpen(it) }
        intent.removeExtra(Notifier.EXTRA_ROLE_ID)
    }

    override fun onActivityResult(activity: android.app.Activity?, requestCode: Int, resultCode: Int, data: Intent?) {}

    override fun onHostResume() {
        // 冷启动路径：模块注册时读取启动 intent 一次
        reactContext.currentActivity?.intent?.let { intent ->
            intent.getStringExtra(Notifier.EXTRA_ROLE_ID)?.let { queueRoleOpen(it) }
            intent.removeExtra(Notifier.EXTRA_ROLE_ID)
        }
        drain()
    }

    override fun onHostPause() {}
    override fun onHostDestroy() {}

    @ReactMethod
    fun addListener(eventName: String) {
        listenerCount++
        drain()
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        listenerCount = maxOf(0, listenerCount - count)
    }

    @ReactMethod
    fun consumeInitialRole(promise: Promise) {
        val roleId = pendingRoleId
        pendingRoleId = null
        promise.resolve(roleId)
    }

    @ReactMethod
    fun schedule(config: ReadableMap, promise: Promise) {
        try {
            val schedule = RoleSchedule(
                roleId = config.getString("roleId") ?: throw IllegalArgumentException("roleId 缺失"),
                roleName = config.getString("roleName") ?: "角色",
                persona = config.getString("persona") ?: "",
                hour = config.getInt("hour"),
                minute = config.getInt("minute"),
                mode = ScheduleMode.valueOf(config.getString("mode") ?: "WORK"),
                enabled = if (config.hasKey("enabled")) config.getBoolean("enabled") else true,
                revision = config.getString("revision") ?: java.util.UUID.randomUUID().toString(),
                slotId = config.getString("slotId") ?: ""
            )
            val store = MessageStore(reactContext)
            store.upsertSchedule(schedule)
            when (schedule.mode) {
                ScheduleMode.WORK -> DailyWorkScheduler.schedule(reactContext, schedule)
                ScheduleMode.EXACT -> AlarmScheduler.schedule(reactContext, schedule)
            }
            promise.resolve(schedule.resolvedSlotId)
        } catch (e: Exception) {
            promise.reject("ERR_SCHEDULE", e.message, e)
        }
    }

    /** 取消单个时间槽 */
    @ReactMethod
    fun cancel(slotId: String, promise: Promise) {
        try {
            MessageStore(reactContext).removeScheduleBySlot(slotId)
            DailyWorkScheduler.cancel(reactContext, slotId)
            AlarmScheduler.cancel(reactContext, slotId)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_CANCEL", e.message, e)
        }
    }

    /** 取消某角色的全部时间槽 */
    @ReactMethod
    fun cancelRole(roleId: String, promise: Promise) {
        try {
            val store = MessageStore(reactContext)
            // 用全量列表：已停用的槽也可能残留旧闹钟/任务
            store.loadSchedules().filter { it.roleId == roleId }.forEach { schedule ->
                DailyWorkScheduler.cancel(reactContext, schedule.resolvedSlotId)
                AlarmScheduler.cancel(reactContext, schedule.resolvedSlotId)
            }
            store.removeSchedulesByRole(roleId)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_CANCEL_ROLE", e.message, e)
        }
    }

    @ReactMethod
    fun setApiSettings(config: ReadableMap, promise: Promise) {
        try {
            MessageStore(reactContext).saveApiSettings(
                ApiSettings(
                    endpoint = config.getString("endpoint") ?: "",
                    model = config.getString("model") ?: "",
                    apiKey = config.getString("apiKey") ?: ""
                )
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_API_SETTINGS", e.message, e)
        }
    }

    @ReactMethod
    fun canScheduleExactAlarms(promise: Promise) {
        promise.resolve(AlarmScheduler.canScheduleExactAlarms(reactContext))
    }

    @ReactMethod
    fun openExactAlarmSettings(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                reactContext.startActivity(
                    Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                        data = Uri.parse("package:${reactContext.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                )
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OPEN_SETTINGS", e.message, e)
        }
    }

    @ReactMethod
    fun openBatteryOptimizationSettings(promise: Promise) {
        try {
            // 注意：常量名是 IGNORE_BATTERY_OPTIMIZATION_SETTINGS，
            // 不存在 ACTION_BATTERY_OPTIMIZATION_SETTINGS
            reactContext.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OPEN_SETTINGS", e.message, e)
        }
    }

    /** 厂商自启动/后台运行设置页。均属厂商私有 action，逐个尝试，失败落回应用详情。 */
    @ReactMethod
    fun openAutostartSettings(promise: Promise) {
        try {
            val manufacturer = Build.MANUFACTURER.lowercase()
            val candidates = when {
                manufacturer.contains("xiaomi") || manufacturer.contains("redmi") -> listOf(
                    "com.miui.securitycenter" to
                        "com.miui.permcenter.autostart.AutoStartManagementActivity"
                )
                manufacturer.contains("huawei") || manufacturer.contains("honor") -> listOf(
                    "com.huawei.systemmanager" to
                        "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                    "com.huawei.systemmanager" to
                        "com.huawei.systemmanager.optimize.process.ProtectActivity"
                )
                manufacturer.contains("oppo") -> listOf(
                    "com.coloros.safecenter" to
                        "com.coloros.privacypermissionsentry.PermissionTopActivity",
                    "com.coloros.safecenter" to
                        "com.coloros.safecenter.startupapp.StartupAppListActivity"
                )
                manufacturer.contains("vivo") -> listOf(
                    "com.iqoo.secure" to
                        "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
                    "com.vivo.permissionmanager" to
                        "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
                )
                else -> emptyList()
            }
            for ((pkg, cls) in candidates) {
                try {
                    reactContext.startActivity(
                        Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                    promise.resolve(true)
                    return
                } catch (e: Exception) {
                    // 该厂商机型没有这个页面，继续尝试下一个
                }
            }
            reactContext.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${reactContext.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_OPEN_SETTINGS", e.message, e)
        }
    }

    @ReactMethod
    fun addListenerStub() {}

    companion object {
        const val EVENT_OPEN_ROLE = "ProactiveMessage:onOpenRole"
    }
}
