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

    // pendingRoleId/listenerCount 会被两个线程访问：UI 线程（onHostResume/onNewIntent）
    // 与 NativeModules 队列线程（consumeInitialRole/addListener）。无同步时存在竞态：
    // 一个线程读空后另一个线程刚写入，或 drain 与 consume 同时清空导致角色丢失。
    private val lock = Any()
    private var listenerCount = 0
    private var pendingRoleId: String? = null

    init {
        reactContext.addActivityEventListener(this)
        reactContext.addLifecycleEventListener(this)
        // 注册时先兜底抓一次启动 intent：onHostResume 触发的时机早于 currentActivity 就绪，
        // 冷启动时 intent 可能读不到，这里补一次，避免通知点击进入但角色丢失。
        captureLaunchIntent()
    }

    override fun getName() = "ProactiveMessage"

    /** 从当前 Activity 的启动 intent 取 roleId；取到即消费并清掉 extra，防止重复处理。 */
    private fun captureLaunchIntent() {
        val intent = reactContext.currentActivity?.intent ?: return
        intent.getStringExtra(Notifier.EXTRA_ROLE_ID)?.let { queueRoleOpen(it) }
        intent.removeExtra(Notifier.EXTRA_ROLE_ID)
    }

    private fun queueRoleOpen(roleId: String) {
        synchronized(lock) {
            pendingRoleId = roleId
        }
        drain()
    }

    private fun drain() {
        val roleId = synchronized(lock) {
            val pending = pendingRoleId ?: return
            if (listenerCount <= 0) return
            pendingRoleId = null
            pending
        }
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
        // 冷启动路径：读取启动 intent。currentActivity 可能此刻仍为 null，
        // 故 addListener 命中时还会再兜底一次。
        captureLaunchIntent()
        drain()
    }

    override fun onHostPause() {}
    override fun onHostDestroy() {}

    @ReactMethod
    fun addListener(eventName: String) {
        synchronized(lock) { listenerCount++ }
        // JS 监听器就位时补抓一次启动 intent，覆盖 currentActivity 晚于 onHostResume 就绪的冷启动。
        captureLaunchIntent()
        drain()
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        synchronized(lock) { listenerCount = maxOf(0, listenerCount - count) }
    }

    @ReactMethod
    fun consumeInitialRole(promise: Promise) {
        val roleId = synchronized(lock) {
            val pending = pendingRoleId
            pendingRoleId = null
            pending
        }
        promise.resolve(roleId)
    }

    /**
     * 取出待写队列（原生生成但尚未写入会话的主动消息），**不清空**，供 JS 落库。
     * 返回 [{ id, slotId, roleId, roleName, text, createdAt }]。
     * 落库成功由 JS 调 ackPendingMessages(ids) 删除；写入失败则下次启动重试。
     * 消息 id 幂等，重复返回不会产生重复会话消息。
     */
    @ReactMethod
    fun consumePendingMessages(promise: Promise) {
        try {
            val store = MessageStore(reactContext)
            val pending = store.loadPendingMessages()
            val array = Arguments.createArray()
            pending.forEach { message ->
                val map = Arguments.createMap()
                map.putString("id", message.id)
                map.putString("slotId", message.slotId)
                map.putString("roleId", message.roleId)
                map.putString("roleName", message.roleName)
                map.putString("text", message.text)
                map.putDouble("createdAt", message.createdAt.toDouble())
                array.pushMap(map)
            }
            promise.resolve(array)
        } catch (e: Exception) {
            // 读取失败返回空数组，不影响主流程
            promise.resolve(Arguments.createArray())
        }
    }

    /** 已成功落库的消息按 id 从待写队列移除。 */
    @ReactMethod
    fun ackPendingMessages(ids: com.facebook.react.bridge.ReadableArray, promise: Promise) {
        try {
            val list = (0 until ids.size()).mapNotNull { ids.getString(it) }
            MessageStore(reactContext).removePendingMessages(list)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
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
                slotId = config.getString("slotId") ?: "",
                messageType = runCatching {
                    MessageType.valueOf(
                        if (config.hasKey("messageType")) config.getString("messageType") ?: "DEFAULT"
                        else "DEFAULT"
                    )
                }.getOrDefault(MessageType.DEFAULT),
                customPrompt = if (config.hasKey("customPrompt")) config.getString("customPrompt") ?: "" else "",
                requestJson = if (config.hasKey("requestJson")) config.getString("requestJson") ?: "" else "",
                avatarUri = if (config.hasKey("avatarUri")) config.getString("avatarUri") ?: "" else ""
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

    /**
     * 权限状态查询：返回可判定的布尔值；无法判定（如厂商自启动白名单无公开 API）用 null。
     * JS 侧据此展示打勾 / 叉 / 问号。
     */
    @ReactMethod
    fun getPermissionStatus(promise: Promise) {
        try {
            val result = Arguments.createMap()
            result.putBoolean("notification", Notifier.canNotify(reactContext))
            result.putBoolean("exactAlarm", AlarmScheduler.canScheduleExactAlarms(reactContext))
            val power = reactContext.getSystemService(PowerManager::class.java)
            val ignoring = power != null &&
                power.isIgnoringBatteryOptimizations(reactContext.packageName)
            result.putBoolean("battery", ignoring)
            // 自启动白名单没有公开可读接口：厂商实现各异，只能 null（未知）
            result.putNull("autostart")
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("ERR_PERMISSION_STATUS", e.message, e)
        }
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
